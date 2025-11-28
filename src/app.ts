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

export class EosOverlayBridge extends EventEmitter {
  private config: Config;
  private connection: EosConnection | null;
  private dataSync: CueDataSync | null;
  private cueManager: CueStateManager;
  private overlayServer: OverlayServer;
  private running: boolean = false;
  private initialSyncComplete: boolean = false;
  private bufferedActiveCueEvents: Array<{ cueList: number; cueNumber: number }> = [];

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

    // Initialize optional Eos Console API components
    if (config.useEosConsoleAPI) {
      console.log('[EosOverlayBridge] Eos Console API enabled - will provide accurate fade times');
      this.connection = new EosConnection(config.eos);
      this.dataSync = new CueDataSync(this.connection, config.sync);
      this.cueManager.setDataSync(this.dataSync);
    } else {
      console.log('[EosOverlayBridge] Eos Console API disabled - running in OSC-only mode');
      this.connection = null;
      this.dataSync = null;
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

    // Start connection attempt if Eos Console API is enabled
    if (this.connection) {
      // Start connection attempt (don't await - let it connect in background)
      // Connection success/failure will be handled by event handlers
      this.connection.connect().catch((error) => {
        // Error is logged by connection class, will trigger reconnection
        console.log('[EosOverlayBridge] Initial connection attempt failed, will retry automatically');
      });
    } else {
      console.log('[EosOverlayBridge] Eos Console API disabled - waiting for OSC messages only');
      // Broadcast that we're "connected" in OSC-only mode
      this.overlayServer.broadcastConnectionStatus('connected', 'OSC-only mode');
    }

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
    this.overlayServer.broadcastConnectionStatus('disconnected', 'Server stopped');

    // Stop components
    if (this.connection) {
      this.connection.disconnect();
    }
    if (this.dataSync) {
      this.dataSync.cleanup();
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
      connection: this.connection ? {
        state: this.connection.getState(),
        reconnection: this.connection.getReconnectionState(),
      } : { state: 'OSC_ONLY', reconnection: null },
      sync: this.dataSync ? this.dataSync.getSyncStatus() : null,
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

  /**
   * Set up event handlers
   */
  private setupEventHandlers(): void {
    // Connection events (only if Eos Console API is enabled)
    if (this.connection) {
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
    }

    // Data sync events (only if enabled)
    if (this.dataSync) {
      this.dataSync.on('sync-complete', (data: any) => {
        this.handleSyncComplete();
      });

      this.dataSync.on('sync-error', (error: any) => {
        console.error('[EosOverlayBridge] Sync error:', error);
      });
    }

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
      // Send current state to new client
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

    // Initialize data sync after connection is established (if enabled)
    if (this.dataSync) {
      try {
        this.overlayServer.broadcastConnectionStatus('syncing', 'Loading cue data...');
        await this.dataSync.initialize(this.config.cueList);
        console.log('[EosOverlayBridge] Data sync initialized');
        this.overlayServer.broadcastConnectionStatus('connected', 'Ready');
      } catch (error) {
        console.error('[EosOverlayBridge] Failed to initialize data sync:', error);
        this.overlayServer.broadcastConnectionStatus('connected', 'Connected (sync failed)');
      }
    } else {
      this.overlayServer.broadcastConnectionStatus('connected', 'Ready');
    }
  }

  /**
   * Handle connection lost
   */
  private handleDisconnected(): void {
    console.warn('[EosOverlayBridge] Eos console disconnected');
    this.overlayServer.broadcastConnectionStatus('reconnecting', 'Connection lost, retrying...');
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

    // Process any buffered events
    if (this.bufferedActiveCueEvents.length > 0) {
      for (const event of this.bufferedActiveCueEvents) {
        await this.processActiveCueChange(event);
      }
      this.bufferedActiveCueEvents = [];
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
   * Process active cue change (after sync is complete)
   */
  private async processActiveCueChange(data: { cueList: number; cueNumber: number }): Promise<void> {

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
          '0%', // Percentage not available from this event
          `${data.cueList}/${data.cueNumber} ${cueData.label || ''}`
        );
      } else {
        // No cached data, create with minimal info
        this.cueManager.handleActiveUpdate(
          String(data.cueList),
          String(data.cueNumber),
          '',
          0,
          '0%',
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
        '0%',
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
  private broadcastCueUpdate(): void {
    const activeCues = this.cueManager.getActiveCues();
    this.overlayServer.broadcastCueUpdate(activeCues);
  }
}
