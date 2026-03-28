/**
 * EosConnection
 * Wrapper around eos-console library providing connection management,
 * reconnection with exponential backoff, and event forwarding
 */

import { EventEmitter } from 'events';
import { EosConsole as EosConsoleClass } from 'eos-console';
import {
  EosConnectionConfig,
  EosConnectionState,
  EosConnectionEvent,
  EosConnectionError,
  ReconnectionState,
  EosConsoleCue,
  EosOSCMessage,
  EosConsoleVersion,
} from '../types/eos';

export class EosConnection extends EventEmitter {
  private config: EosConnectionConfig;
  private console: any; // EosConsole instance
  private state: EosConnectionState = EosConnectionState.DISCONNECTED;
  private reconnectionState: ReconnectionState = {
    isReconnecting: false,
    attemptNumber: 0,
    nextAttemptAt: null,
    lastError: null,
  };
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private cleanedUp: boolean = false;
  /** Host we are currently connected to (from config.hosts). */
  private activeHost: string | null = null;

  constructor(config: EosConnectionConfig) {
    super();
    this.config = config;
  }

  /**
   * Connect to Eos console
   */
  async connect(): Promise<void> {
    if (this.cleanedUp) {
      throw new Error('EosConnection has been cleaned up and cannot be reused');
    }

    if (this.state === EosConnectionState.CONNECTED) {
      return; // Already connected
    }

    if (this.state === EosConnectionState.CONNECTING) {
      throw new Error('Connection already in progress');
    }

    this.setState(EosConnectionState.CONNECTING);
    this.disposeConsoleInstance();

    const hosts = this.config.hosts;
    let lastError: unknown = null;

    for (let i = 0; i < hosts.length; i++) {
      const host = hosts[i];
      console.log(
        `[EosConnection] Trying console ${i + 1}/${hosts.length}: ${host}:${this.config.port}...`
      );

      try {
        await this.tryConnectToHost(host);
        this.activeHost = host;
        this.setState(EosConnectionState.CONNECTED);
        this.reconnectionState.attemptNumber = 0;
        this.reconnectionState.lastError = null;

        this.emit(EosConnectionEvent.CONNECTED);

        try {
          const version = await this.getVersion();
          console.log(
            `[EosConnection] Connected to Eos console v${version.version} at ${host}:${this.config.port}`
          );
        } catch {
          console.log(`[EosConnection] Connected to Eos console at ${host}:${this.config.port}`);
        }
        return;
      } catch (error) {
        lastError = error;
        console.warn(
          `[EosConnection] Unreachable: ${host}:${this.config.port} — ${(error as Error)?.message ?? error}`
        );
        this.disposeConsoleInstance();
      }
    }

    this.activeHost = null;
    const connectionError = this.createConnectionError(
      lastError ?? new Error('All console hosts failed'),
      hosts
    );
    this.setState(EosConnectionState.ERROR);
    this.reconnectionState.lastError = connectionError;

    this.emit(EosConnectionEvent.ERROR, connectionError);

    if (this.shouldReconnect()) {
      this.scheduleReconnect();
    } else {
      throw lastError ?? new Error('All console hosts failed');
    }
  }

  /**
   * Disconnect from console
   */
  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.disposeConsoleInstance();
    this.activeHost = null;

    this.setState(EosConnectionState.DISCONNECTED);
    this.emit(EosConnectionEvent.DISCONNECTED);
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    this.disconnect();
    this.removeAllListeners();
    this.cleanedUp = true;
  }

  /**
   * Get current connection state
   */
  getState(): EosConnectionState {
    return this.state;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.state === EosConnectionState.CONNECTED;
  }

  /**
   * Get reconnection state
   */
  getReconnectionState(): ReconnectionState {
    return { ...this.reconnectionState };
  }

  /**
   * Get current active cue number from console state
   * Returns the identifier immediately from the library's cached state.
   */
  getActiveCueNumber(): { cueList: number; cueNumber: number } | null {
    if (!this.console || !this.isConnected()) return null;
    const active = this.console.activeCueNumber;
    return active ? { cueList: active.cueList, cueNumber: active.cueNumber } : null;
  }

  /**
   * Get current previous cue number from console state
   */
  getPreviousCueNumber(): { cueList: number; cueNumber: number } | null {
    if (!this.console || !this.isConnected()) return null;
    const previous = this.console.previousCueNumber;
    return previous ? { cueList: previous.cueList, cueNumber: previous.cueNumber } : null;
  }

  /**
   * Get console version
   */
  async getVersion(): Promise<EosConsoleVersion> {
    this.ensureConnected();
    const version = await this.console.getVersion();
    return { version };
  }

  /**
   * Get single cue from console
   */
  async getCue(cueList: number, cueNumber: number): Promise<EosConsoleCue | null> {
    this.ensureConnected();

    try {
      const cue = await this.console.getCue(cueList, cueNumber);
      return cue || null;
    } catch (error) {
      console.error(`[EosConnection] Error fetching cue ${cueList}/${cueNumber}:`, error);
      return null;
    }
  }

  /**
   * Get all cues from a cue list
   */
  async getCues(cueList: number): Promise<EosConsoleCue[]> {
    this.ensureConnected();

    try {
      const cues = await this.console.getCues(cueList);
      return Array.isArray(cues) ? cues : [];
    } catch (error) {
      console.error(`[EosConnection] Error fetching cues from list ${cueList}:`, error);
      return [];
    }
  }

  /**
   * Fire a cue
   */
  async fireCue(cueList: number, cueNumber: number): Promise<boolean> {
    this.ensureConnected();

    try {
      await this.console.fireCue(cueList, cueNumber);
      return true;
    } catch (error) {
      console.error(`[EosConnection] Error firing cue ${cueList}/${cueNumber}:`, error);
      return false;
    }
  }

  /**
   * Execute command on console
   */
  async executeCommand(command: string): Promise<boolean> {
    this.ensureConnected();

    try {
      await this.console.executeCommand(command);
      return true;
    } catch (error) {
      console.error(`[EosConnection] Error executing command "${command}":`, error);
      return false;
    }
  }

  // ===== PRIVATE METHODS =====

  private disposeConsoleInstance(): void {
    if (!this.console) {
      return;
    }
    try {
      if (typeof this.console.removeAllListeners === 'function') {
        this.console.removeAllListeners();
      }
    } catch {
      // ignore
    }
    try {
      this.console.disconnect();
    } catch {
      // ignore
    }
    this.console = null;
  }

  private async tryConnectToHost(host: string): Promise<void> {
    this.console = new EosConsoleClass({
      host,
      port: this.config.port,
      logging: (level: string, message: string) => {
        if (level === 'warn' || level === 'error') {
          console.log(`[eos-console:${level}] ${message}`);
        }
      },
    });
    this.setupEventListeners();
    await this.console.connect();
  }

  /**
   * Set up event listeners on eos-console instance
   */
  private setupEventListeners(): void {
    if (!this.console) return;

    // High-level active cue event (fires once when cue changes)
    this.console.on('active-cue', (data: any) => {
      console.log('[EosConnection] Active cue changed:', data);
      if (data.cue) {
        this.emit('active-cue-change', {
          cueList: data.cue.cueList,
          cueNumber: data.cue.cueNumber,
        });
      }
    });

    // Active cue text updates (fires continuously with time/percentage)
    this.console.on('active-cue-text', (data: any) => {
      // Convert to OSC message format for compatibility
      const oscMessage: EosOSCMessage = {
        address: '/eos/out/active/cue/text',
        args: [data.text],
        timeTag: undefined,
      };
      this.emit(EosConnectionEvent.OSC_MESSAGE, oscMessage);
    });

    // Previous cue event (fires when cue moves to previous list)
    this.console.on('previous-cue', (data: any) => {
      console.log('[EosConnection] Previous cue:', data);
      if (data.cue) {
        this.emit('previous-cue-change', {
          cueList: data.cue.cueList,
          cueNumber: data.cue.cueNumber,
        });
      }
    });

    // Raw OSC messages (fallback for unhandled messages)
    this.console.on('osc', (message: any) => {
      console.log('[EosConnection] Raw OSC message received:', message.address, message.args);
      const oscMessage: EosOSCMessage = {
        address: message.address,
        args: message.args,
        timeTag: message.timeTag,
      };
      this.emit(EosConnectionEvent.OSC_MESSAGE, oscMessage);
    });

    // Disconnect event
    this.console.on('disconnect', () => {
      console.warn('[EosConnection] Console disconnected');
      this.handleDisconnect();
    });

    // Error event
    this.console.on('error', (error: any) => {
      console.error('[EosConnection] Console error:', error);
      const connectionError = this.createConnectionError(error);
      this.emit(EosConnectionEvent.ERROR, connectionError);
    });
  }

  /**
   * Handle disconnect event
   */
  private handleDisconnect(): void {
    if (this.state === EosConnectionState.DISCONNECTED) {
      return; // Already handled
    }

    this.setState(EosConnectionState.DISCONNECTED);
    this.emit(EosConnectionEvent.DISCONNECTED);

    // Attempt reconnection if configured
    if (this.shouldReconnect()) {
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimeout || this.cleanedUp) {
      return; // Already scheduled or cleaned up
    }

    this.reconnectionState.isReconnecting = true;
    this.reconnectionState.attemptNumber++;

    const delayIndex = Math.min(
      this.reconnectionState.attemptNumber - 1,
      this.config.reconnectDelays.length - 1
    );
    const delay = this.config.reconnectDelays[delayIndex];

    this.reconnectionState.nextAttemptAt = Date.now() + delay;

    console.log(`[EosConnection] Scheduling reconnection attempt ${this.reconnectionState.attemptNumber} in ${delay}ms`);

    this.setState(EosConnectionState.RECONNECTING);
    this.emit(EosConnectionEvent.RECONNECTING, this.reconnectionState);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.attemptReconnect();
    }, delay);
  }

  /**
   * Attempt reconnection
   */
  private async attemptReconnect(): Promise<void> {
    console.log(`[EosConnection] Reconnection attempt ${this.reconnectionState.attemptNumber}...`);

    try {
      await this.connect();
      // Success! Reset reconnection state
      this.reconnectionState.isReconnecting = false;
      this.reconnectionState.nextAttemptAt = null;
    } catch (error) {
      // connect() will schedule next attempt if needed
    }
  }

  /**
   * Check if reconnection should be attempted
   */
  private shouldReconnect(): boolean {
    if (this.cleanedUp) {
      return false;
    }

    const maxAttempts = this.config.reconnectMaxAttempts;

    // 0 means infinite reconnection attempts
    if (maxAttempts === 0) {
      return true;
    }

    return this.reconnectionState.attemptNumber < maxAttempts;
  }

  /**
   * Create connection error object
   */
  private createConnectionError(error: any, triedHosts?: string[]): EosConnectionError {
    const code = error?.code || error?.name || 'UNKNOWN';
    const refHost =
      triedHosts?.[triedHosts.length - 1] ??
      this.activeHost ??
      this.config.hosts[0] ??
      'unknown';
    let message = error?.message || 'Unknown connection error';
    let recoverable = true;

    if (triedHosts && triedHosts.length > 1) {
      message = `Could not connect to any of [${triedHosts.join(', ')}]. Last error: ${error?.message ?? 'unknown'}`;
    } else {
      switch (code) {
        case 'ECONNREFUSED':
          message = `Connection refused at ${refHost}:${this.config.port}. Ensure console is on and "Third Party OSC" is enabled.`;
          recoverable = true;
          break;

        case 'ETIMEDOUT':
        case 'TIMEOUT':
          message = `Connection timeout to ${refHost}:${this.config.port}. Check network and firewall.`;
          recoverable = true;
          break;

        case 'EHOSTUNREACH':
          message = `Host unreachable: ${refHost}. Verify IP and network.`;
          recoverable = true;
          break;

        case 'ENOTFOUND':
          message = `Host not found: ${refHost}. Check hostname/IP.`;
          recoverable = false;
          break;
      }
    }

    return {
      code,
      message,
      timestamp: Date.now(),
      recoverable,
      attemptNumber: this.reconnectionState.attemptNumber,
    };
  }

  /**
   * Set connection state
   */
  private setState(newState: EosConnectionState): void {
    const oldState = this.state;
    this.state = newState;

    if (oldState !== newState) {
      console.log(`[EosConnection] State changed: ${oldState} → ${newState}`);
    }
  }

  /**
   * Ensure connected before API calls
   */
  private ensureConnected(): void {
    if (!this.isConnected()) {
      throw new Error(`Cannot perform operation: connection state is ${this.state}`);
    }
  }
}
