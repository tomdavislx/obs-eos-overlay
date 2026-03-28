import OBSWebSocket from 'obs-websocket-js';

export interface ObsControlClientConfig {
  host: string;
  port: number;
  password: string;
}

/**
 * Thin client for OBS WebSocket v5 recording control.
 * Connects lazily on first request; resets connection on errors.
 */
export class ObsControlClient {
  private readonly obs: OBSWebSocket;
  private readonly config: ObsControlClientConfig;
  private ready: boolean = false;

  constructor(config: ObsControlClientConfig) {
    this.config = config;
    this.obs = new OBSWebSocket();
    this.obs.on('ConnectionClosed', () => {
      this.ready = false;
    });
  }

  private wsUrl(): string {
    return `ws://${this.config.host}:${this.config.port}`;
  }

  private async ensureConnected(): Promise<void> {
    if (this.ready) {
      return;
    }
    const password = this.config.password.trim() === '' ? undefined : this.config.password;
    console.log(`[ObsControlClient] Connecting to ${this.wsUrl()}...`);
    await this.obs.connect(this.wsUrl(), password);
    this.ready = true;
    console.log('[ObsControlClient] Connected to OBS WebSocket');
  }

  /**
   * Try to connect at bridge startup so OBS reachability is visible without firing a trigger cue.
   * On failure, recording triggers will still retry on the next StartRecord/StopRecord.
   */
  async warmUpConnection(): Promise<void> {
    try {
      await this.ensureConnected();
    } catch (err: any) {
      console.warn(
        '[ObsControlClient] Startup connection failed:',
        err?.message ?? err
      );
      console.warn(
        '[ObsControlClient] Will retry when a start/stop recording cue fires (lazy connect).'
      );
    }
  }

  private resetConnection(): void {
    this.ready = false;
    void this.obs.disconnect().catch(() => {
      // ignore
    });
  }

  async startRecording(): Promise<void> {
    try {
      await this.ensureConnected();
      await this.obs.call('StartRecord');
      console.log('[ObsControlClient] StartRecord acknowledged by OBS');
    } catch (err: any) {
      this.resetConnection();
      console.warn('[ObsControlClient] StartRecord failed:', err?.message ?? err);
    }
  }

  async stopRecording(): Promise<void> {
    try {
      await this.ensureConnected();
      await this.obs.call('StopRecord');
      console.log('[ObsControlClient] StopRecord acknowledged by OBS');
    } catch (err: any) {
      this.resetConnection();
      console.warn('[ObsControlClient] StopRecord failed:', err?.message ?? err);
    }
  }

  async createRecordChapter(chapterName: string): Promise<void> {
    try {
      await this.ensureConnected();
      await this.obs.call('CreateRecordChapter', {
        chapterName,
      });
      console.log(`[ObsControlClient] CreateRecordChapter acknowledged by OBS (${chapterName})`);
    } catch (err: any) {
      this.resetConnection();
      console.warn('[ObsControlClient] CreateRecordChapter failed:', err?.message ?? err);
    }
  }

  disconnect(): void {
    this.resetConnection();
  }
}
