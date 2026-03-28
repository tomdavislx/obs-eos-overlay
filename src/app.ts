/**
 * EosOverlayBridge
 * Main application orchestrator that coordinates all components
 */

import { EventEmitter } from 'events';
import { Config } from './config';
import { EosConnection } from './lib/eosConnection';
import { CueDataSync } from './lib/cueDataSync';
import { CueStateManager } from './lib/cueStateManager';
import { OverlayServer } from './lib/overlayServer';
import {
  EosConnectionEvent,
  EosOSCMessage,
} from './types/eos';
import {
  parseActiveCue,
  parsePreviousCue,
  parseFireEvent,
  validateOSCMessage,
  extractTextFromArgs,
  isActiveCueMessage,
  isPreviousCueMessage,
  isFireEventMessage,
} from './lib/oscParser';
import { ObsControlClient } from './lib/obsControlClient';
import { recordingActionForCue } from './lib/obsRecordingTriggers';

export class EosOverlayBridge extends EventEmitter {
  private config: Config;
  private connection: EosConnection;
  private dataSync: CueDataSync;
  private cueManager: CueStateManager;
  private overlayServer: OverlayServer;
  private running: boolean = false;
  private initialSyncComplete: boolean = false;
  private bufferedActiveCueEvents: Array<{ cueList: number; cueNumber: number }> = [];
  private currentConnectionStatus: string = 'connecting';
  private currentConnectionMessage: string = '';
  private obsControlClient: ObsControlClient | null = null;
  private recordStartTimer: ReturnType<typeof setTimeout> | null = null;
  private recordStopTimer: ReturnType<typeof setTimeout> | null = null;
  /** When false, active-cue-driven OBS triggers are ignored (connection/sync bootstrap). OSC fire still triggers. */
  private obsRecordingTriggersArmed = false;

  constructor(config: Config) {
    super();
    this.config = config;

    // Initialize core components
    this.cueManager = new CueStateManager({
      staleTimeout: config.cueTracking.staleTimeout,
      completionTimeout: config.cueTracking.completionTimeout,
      enableStateLogging: config.logging.logState,
    });
    this.overlayServer = new OverlayServer({
      port: config.websocket.port,
      pingInterval: config.websocket.pingInterval,
    });

    // Eos Console API is mandatory in this application
    this.connection = new EosConnection(config.eos);
    this.dataSync = new CueDataSync(this.connection, config.sync);
    this.cueManager.setDataSync(this.dataSync);

    if (config.obsControl.enabled) {
      this.obsControlClient = new ObsControlClient({
        host: config.obsControl.host,
        port: config.obsControl.port,
        password: config.obsControl.password,
      });
      console.log('[EosOverlayBridge] OBS WebSocket recording control enabled');
    }

    // Set up event handlers
    this.setupEventHandlers();
  }

  /**
   * Start the application
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error('EosOverlayBridge is already running');
    }

    console.log('[EosOverlayBridge] Starting...');

    // Start WebSocket server
    this.overlayServer.start();

    if (this.obsControlClient) {
      void this.obsControlClient.warmUpConnection();
    }

    // Start connection attempt (don't await - let it connect in background)
    // Connection success/failure will be handled by event handlers
    this.connection.connect().catch(() => {
      // Error is logged by connection class, will trigger reconnection
      console.log('[EosOverlayBridge] Initial connection attempt failed, will retry automatically');
    });

    this.running = true;

    console.log('[EosOverlayBridge] Started successfully');
    this.emit('started');
  }

  /**
   * Stop the application
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    console.log('[EosOverlayBridge] Stopping...');

    // Broadcast disconnection status
    this.broadcastConnectionStatus('disconnected', 'Server stopped');

    // Stop components
    this.connection.disconnect();
    this.dataSync.cleanup();
    this.clearObsRecordingTimers();
    if (this.obsControlClient) {
      this.obsControlClient.disconnect();
      this.obsControlClient = null;
    }
    this.cueManager.cleanup();
    this.overlayServer.stop();

    this.running = false;

    console.log('[EosOverlayBridge] Stopped');
    this.emit('stopped');
  }

  /**
   * Check if running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get status information
   */
  getStatus(): any {
    return {
      running: this.running,
      connection: {
        state: this.connection.getState(),
        reconnection: this.connection.getReconnectionState(),
      },
      sync: this.dataSync.getSyncStatus(),
      cues: {
        active: this.cueManager.getActiveCues().length,
        total: this.cueManager.getAllCues().length,
        distribution: this.cueManager.getStateDistribution(),
      },
      overlay: {
        clients: this.overlayServer.getClientCount(),
      },
    };
  }

  // ===== PRIVATE METHODS =====

  private clearObsRecordingTimers(): void {
    if (this.recordStartTimer !== null) {
      clearTimeout(this.recordStartTimer);
      this.recordStartTimer = null;
    }
    if (this.recordStopTimer !== null) {
      clearTimeout(this.recordStopTimer);
      this.recordStopTimer = null;
    }
  }

  /**
   * After a record start/stop trigger cue fires, optionally delay before calling OBS.
   * Scheduling a start cancels a pending delayed stop; scheduling a stop cancels a pending delayed start.
   */
  private scheduleObsRecording(action: 'start' | 'stop', cueRef: string): void {
    if (!this.obsControlClient) {
      return;
    }

    const delayMs =
      action === 'start'
        ? this.config.obsControl.recordStartDelayMs
        : this.config.obsControl.recordStopDelayMs;

    if (action === 'start') {
      if (this.recordStopTimer !== null) {
        clearTimeout(this.recordStopTimer);
        this.recordStopTimer = null;
      }
      if (this.recordStartTimer !== null) {
        clearTimeout(this.recordStartTimer);
        this.recordStartTimer = null;
      }
      const client = this.obsControlClient;
      const run = (): void => {
        this.recordStartTimer = null;
        console.log(`[EosOverlayBridge] Starting OBS recording (cue ${cueRef})`);
        void client.startRecording();
      };
      if (delayMs <= 0) {
        run();
      } else {
        console.log(
          `[EosOverlayBridge] Scheduling OBS StartRecord in ${delayMs}ms (cue ${cueRef})`
        );
        this.recordStartTimer = setTimeout(run, delayMs);
      }
    } else {
      if (this.recordStartTimer !== null) {
        clearTimeout(this.recordStartTimer);
        this.recordStartTimer = null;
      }
      if (this.recordStopTimer !== null) {
        clearTimeout(this.recordStopTimer);
        this.recordStopTimer = null;
      }
      const client = this.obsControlClient;
      const run = (): void => {
        this.recordStopTimer = null;
        console.log(`[EosOverlayBridge] Stopping OBS recording (cue ${cueRef})`);
        void client.stopRecording();
      };
      if (delayMs <= 0) {
        run();
      } else {
        console.log(
          `[EosOverlayBridge] Scheduling OBS StopRecord in ${delayMs}ms (cue ${cueRef})`
        );
        this.recordStopTimer = setTimeout(run, delayMs);
      }
    }
  }

  /**
   * Set up event handlers
   */
  private setupEventHandlers(): void {
    // Connection events
    this.connection.on(EosConnectionEvent.CONNECTED, () => {
      this.handleConnected();
    });

    this.connection.on(EosConnectionEvent.DISCONNECTED, () => {
      this.handleDisconnected();
    });

    this.connection.on(EosConnectionEvent.OSC_MESSAGE, (message: EosOSCMessage) => {
      this.handleOSCMessage(message);
    });

    this.connection.on('active-cue-change', (data: { cueList: number; cueNumber: number }) => {
      this.handleActiveCueChange(data);
    });

    this.connection.on('previous-cue-change', (data: { cueList: number; cueNumber: number }) => {
      this.handlePreviousCueChange(data);
    });

    this.connection.on(EosConnectionEvent.ERROR, (error: any) => {
      this.handleConnectionError(error);
    });

    // Data sync events
    this.dataSync.on('sync-complete', () => {
      this.handleSyncComplete();
    });

    this.dataSync.on('sync-error', (error: any) => {
      console.error('[EosOverlayBridge] Sync error:', error);
    });

    // Cue manager events
    this.cueManager.on('cue-fired', () => {
      this.broadcastCueUpdate();
    });

    this.cueManager.on('cue-updated', () => {
      this.broadcastCueUpdate();
    });

    this.cueManager.on('state-changed', () => {
      this.broadcastCueUpdate();
    });

    this.cueManager.on('cue-finished', () => {
      this.broadcastCueUpdate();
    });

    this.cueManager.on('cue-removed', () => {
      this.broadcastCueUpdate();
    });

    // Overlay server events
    this.overlayServer.on('client-connected', (client: any) => {
      // Send current connection status and cue state to new client
      this.overlayServer.broadcastConnectionStatus(this.currentConnectionStatus, this.currentConnectionMessage);
      this.broadcastCueUpdate();
    });

    this.overlayServer.on('client-disconnected', (client: any) => {
      // Client disconnected
    });
  }

  /**
   * Handle connection established
   */
  private async handleConnected(): Promise<void> {
    console.log('[EosOverlayBridge] Eos console connected');
    this.emit('console-connected');

    this.obsRecordingTriggersArmed = false;

    try {
      // Initialize data sync after connection is established
      try {
        this.broadcastConnectionStatus('syncing', 'Loading cue data...');
        await this.dataSync.initialize(this.config.cueList);
        console.log('[EosOverlayBridge] Data sync initialized');
        this.broadcastConnectionStatus('connected', 'Ready');
      } catch (error) {
        console.error('[EosOverlayBridge] Failed to initialize data sync:', error);
        this.broadcastConnectionStatus('connected', 'Connected (sync failed)');
      }
    } finally {
      this.obsRecordingTriggersArmed = true;
    }
  }

  /**
   * Handle connection lost
   */
  private handleDisconnected(): void {
    console.warn('[EosOverlayBridge] Eos console disconnected');
    this.obsRecordingTriggersArmed = false;
    this.broadcastConnectionStatus('reconnecting', 'Connection lost, retrying...');
    this.emit('console-disconnected');
  }

  /**
   * Handle connection error
   */
  private handleConnectionError(error: any): void {
    console.error('[EosOverlayBridge] Connection error:', error.message);
    this.overlayServer.broadcastError(`Console connection error: ${error.message}`, error.recoverable);
    this.emit('console-error', error);
  }

  /**
   * Handle sync complete
   */
  private async handleSyncComplete(): Promise<void> {
    this.initialSyncComplete = true;

    // Process any buffered events (not operator GOs — skip OBS; same cue as idle state would false-trigger)
    if (this.bufferedActiveCueEvents.length > 0) {
      for (const event of this.bufferedActiveCueEvents) {
        await this.processActiveCueChange(event, { skipObsRecording: true });
      }
      this.bufferedActiveCueEvents = [];
    }

    // If the console was sitting idle when we connected, the active-cue event
    // may never fire (Eos only sends it when the cue changes). Seed the state
    // manager from the library's cached active cue so the overlay shows the
    // current cue immediately rather than waiting for the next Go.
    if (this.cueManager.getAllCues().length === 0 && this.connection) {
      const activeCue = this.connection.getActiveCueNumber();
      if (activeCue && activeCue.cueList === this.config.cueList) {
        console.log(`[EosOverlayBridge] Seeding active cue from console state: ${activeCue.cueList}/${activeCue.cueNumber}`);
        await this.processActiveCueChange(activeCue, { skipObsRecording: true });
      }
    }
  }

  /**
   * Handle active cue change from high-level event
   */
  private async handleActiveCueChange(data: { cueList: number; cueNumber: number }): Promise<void> {
    // Filter by cue list
    if (data.cueList !== this.config.cueList) {
      return; // Not the cue list we're tracking
    }

    // Buffer events until initial sync is complete
    if (!this.initialSyncComplete && this.dataSync) {
      this.bufferedActiveCueEvents.push(data);
      return;
    }

    await this.processActiveCueChange(data);
  }

  /**
   * Match fired / active cue number against OBS recording trigger lists.
   * Uses eos-console active-cue events as well as OSC fire (some consoles omit fire on Third Party OSC).
   */
  private maybeTriggerObsRecordingForCueNumber(cueNumber: string): void {
    if (!this.obsControlClient) {
      return;
    }
    const action = recordingActionForCue(
      cueNumber,
      this.config.obsControl.recordStartCueNumbers,
      this.config.obsControl.recordStopCueNumbers
    );
    const cueRef = `${this.config.cueList}/${cueNumber.trim()}`;
    if (action === 'start') {
      console.log(
        `[EosOverlayBridge] OBS recording: cue ${cueRef} matched start list [${this.config.obsControl.recordStartCueNumbers.join(', ')}]`
      );
      this.scheduleObsRecording('start', cueRef);
    } else if (action === 'stop') {
      console.log(
        `[EosOverlayBridge] OBS recording: cue ${cueRef} matched stop list [${this.config.obsControl.recordStopCueNumbers.join(', ')}]`
      );
      this.scheduleObsRecording('stop', cueRef);
    }
  }

  /**
   * Process active cue change (after sync is complete)
   */
  private async processActiveCueChange(
    data: { cueList: number; cueNumber: number },
    options?: { skipObsRecording?: boolean }
  ): Promise<void> {
    if (!options?.skipObsRecording && this.obsRecordingTriggersArmed) {
      this.maybeTriggerObsRecordingForCueNumber(String(data.cueNumber));
    }

    // Look up cue data from cache
    if (this.dataSync) {
      const cueId = `${data.cueList}/${data.cueNumber}`;
      const cueData = await this.dataSync.ensureCueData(cueId);

      if (cueData) {
        // We have full cue data with accurate fade time
        const fadeTimeSec = cueData.fadeTimeMs ? cueData.fadeTimeMs / 1000 : 0;
        this.cueManager.handleActiveUpdate(
          String(data.cueList),
          String(data.cueNumber),
          cueData.label || '',
          fadeTimeSec,
          null, // Percentage not available from this event; real value comes via active-cue-text
          `${data.cueList}/${data.cueNumber} ${cueData.label || ''}`
        );
      } else {
        // No cached data, create with minimal info
        this.cueManager.handleActiveUpdate(
          String(data.cueList),
          String(data.cueNumber),
          '',
          0,
          null, // Percentage not available from this event
          `${data.cueList}/${data.cueNumber}`
        );
      }
    } else {
      // No data sync, minimal info
      this.cueManager.handleActiveUpdate(
        String(data.cueList),
        String(data.cueNumber),
        '',
        0,
        null, // Percentage not available from this event
        `${data.cueList}/${data.cueNumber}`
      );
    }
  }

  /**
   * Handle previous cue change (cue moved to previous list)
   */
  private handlePreviousCueChange(data: { cueList: number; cueNumber: number }): void {
    // Filter by cue list
    if (data.cueList !== this.config.cueList) {
      return;
    }

    const cueId = `${data.cueList}/${data.cueNumber}`;
    const cue = this.cueManager.getCue(cueId);

    if (cue) {
      // Eos doesn't send percentage updates for previous cues, so we need to
      // manually transition to BACKGROUND and schedule cleanup based on fade time
      this.cueManager.handlePreviousUpdate(
        String(data.cueList),
        String(data.cueNumber),
        cue.label || '',
        cue.time,
        cue.raw || `${cueId}`
      );
    }
  }

  /**
   * Handle incoming OSC message
   */
  private handleOSCMessage(message: EosOSCMessage): void {
    // Validate message
    const validation = validateOSCMessage(message);
    if (!validation.valid) {
      if (this.config.logging.logOSC) {
        console.warn(`[EosOverlayBridge] Invalid OSC message: ${validation.error}`);
      }
      return;
    }

    // Route message to appropriate handler
    if (isFireEventMessage(message)) {
      this.handleFireEvent(message);
    } else if (isActiveCueMessage(message)) {
      this.handleActiveCue(message);
    } else if (isPreviousCueMessage(message)) {
      this.handlePreviousCue(message);
    }
  }

  /**
   * Handle fire event
   */
  private handleFireEvent(message: EosOSCMessage): void {
    const parsed = parseFireEvent(message.address);

    if (!parsed) {
      console.warn('[EosOverlayBridge] Failed to parse fire event:', message.address);
      return;
    }

    // Filter by cue list
    if (parseInt(parsed.cueList, 10) !== this.config.cueList) {
      return; // Not the cue list we're tracking
    }

    this.cueManager.handleFire(parsed.cueList, parsed.cueNumber, Date.now());

    this.maybeTriggerObsRecordingForCueNumber(parsed.cueNumber);
    this.maybeCreateObsRecordChapterMarker(parsed.cueNumber);
  }

  private maybeCreateObsRecordChapterMarker(cueNumber: string): void {
    if (!this.obsControlClient) {
      return;
    }
    const n = cueNumber.trim();
    const marker = this.config.obsControl.recordChapterMarkers.find(
      (m) => m.cueNumber === n
    );
    if (!marker) {
      return;
    }
    const cueRef = `${this.config.cueList}/${n}`;
    console.log(
      `[EosOverlayBridge] OBS chapter marker: cue ${cueRef} → "${marker.label}"`
    );
    void this.obsControlClient.createRecordChapter(marker.label);
  }

  /**
   * Handle active cue update
   */
  private handleActiveCue(message: EosOSCMessage): void {
    const text = extractTextFromArgs(message.args);

    if (!text) {
      return;
    }

    const parsed = parseActiveCue(text);

    if (!parsed) {
      console.warn('[EosOverlayBridge] Failed to parse active cue:', text);
      return;
    }

    // Filter by cue list
    if (parseInt(parsed.cueList, 10) !== this.config.cueList) {
      return; // Not the cue list we're tracking
    }

    this.cueManager.handleActiveUpdate(
      parsed.cueList,
      parsed.cueNumber,
      parsed.label,
      parsed.time,
      parsed.percentage,
      parsed.raw
    );
  }

  /**
   * Handle previous cue update
   */
  private handlePreviousCue(message: EosOSCMessage): void {
    const text = extractTextFromArgs(message.args);

    if (!text) {
      return;
    }

    const parsed = parsePreviousCue(text);

    if (!parsed) {
      console.warn('[EosOverlayBridge] Failed to parse previous cue:', text);
      return;
    }

    // Filter by cue list
    if (parseInt(parsed.cueList, 10) !== this.config.cueList) {
      return; // Not the cue list we're tracking
    }

    this.cueManager.handlePreviousUpdate(
      parsed.cueList,
      parsed.cueNumber,
      parsed.label,
      parsed.time,
      parsed.raw
    );
  }

  /**
   * Broadcast cue update to overlay
   */
  private broadcastConnectionStatus(status: string, message: string = ''): void {
    this.currentConnectionStatus = status;
    this.currentConnectionMessage = message;
    this.overlayServer.broadcastConnectionStatus(status, message);
  }

  private broadcastCueUpdate(): void {
    const activeCues = this.cueManager.getActiveCues();
    this.overlayServer.broadcastCueUpdate(activeCues);
  }
}
