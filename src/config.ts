/**
 * Application Configuration
 * Loads configuration from environment variables with validation
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  EosConnectionConfig,
  SyncOptions,
} from './types/eos';
import {
  normalizeCueNumberList,
  parseCommaSeparatedCueNumbers,
} from './lib/obsRecordingTriggers';

function getConfigPath(): string {
  if ((process as any).pkg) {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Eos OBS Bridge', 'config.json');
  }
  return path.join(process.cwd(), 'config.json');
}
const CONFIG_FILE_PATH = getConfigPath();

/**
 * OBS Studio WebSocket (obs-websocket v5) — recording triggers from Eos cue fire
 */
export interface ObsControlConfig {
  enabled: boolean;
  host: string;
  port: number;
  password: string;
  recordStartCueNumbers: string[];
  recordStopCueNumbers: string[];
  /**
   * Create recording chapter markers on cue fire.
   * Note: requires OBS recording to be active and a compatible recording format (e.g. Hybrid MP4).
   */
  recordChapterMarkers: Array<{ cueNumber: string; label: string }>;
  /**
   * Create recording chapter markers when the active cue's scene changes.
   * Marker label will be the scene text from cue metadata.
   */
  useSceneBreakForChapters: boolean;
  /** Wait after start-trigger cue fire before calling OBS StartRecord (ms). */
  recordStartDelayMs: number;
  /** Wait after stop-trigger cue fire before calling OBS StopRecord (ms). */
  recordStopDelayMs: number;
}

/**
 * Main application configuration
 */
export interface Config {
  // Eos Console Connection
  eos: EosConnectionConfig;

  // Cue List Tracking
  cueList: number;

  // Periodic cue data sync (0 = disabled)
  sync: SyncOptions;

  // WebSocket Server
  websocket: {
    port: number;
  };

  // Logging
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    logOSC: boolean;
    logState: boolean;
  };

  // OBS WebSocket control (optional)
  obsControl: ObsControlConfig;

  // Overlay display options
  overlay: {
    showSceneHeaders: boolean;
  };

  // Config UI server
  configUI: {
    enabled: boolean;
    port: number;
  };
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Config = {
  eos: {
    hosts: ['localhost'],
    port: 3037,
    connectionTimeout: 10000,
    reconnectMaxAttempts: 0, // Infinite reconnection
  },
  cueList: 1,
  sync: {
    syncInterval: 300000, // 5 minutes
  },
  websocket: {
    port: 8081,
  },
  logging: {
    level: 'info',
    logOSC: false,
    logState: true,
  },
  obsControl: {
    enabled: false,
    host: '127.0.0.1',
    port: 4455,
    password: '',
    recordStartCueNumbers: [],
    recordStopCueNumbers: [],
    recordChapterMarkers: [],
    useSceneBreakForChapters: false,
    recordStartDelayMs: 0,
    recordStopDelayMs: 0,
  },
  overlay: {
    showSceneHeaders: true,
  },
  configUI: {
    enabled: true,
    port: 8082,
  },
};

function normalizeRecordChapterMarkers(
  value: unknown
): Array<{ cueNumber: string; label: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: Array<{ cueNumber: string; label: string }> = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const cueNumber = String((item as any).cueNumber ?? '').trim();
    const label = String((item as any).label ?? '').trim();
    if (!cueNumber || !label) continue;
    const key = `${cueNumber}::${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ cueNumber, label });
  }
  return out;
}

/**
 * Deep merge two objects
 */
function deepMerge(target: any, source: any): any {
  const result = { ...target };

  for (const key in source) {
    if (source.hasOwnProperty(key)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
  }

  return result;
}

/**
 * Load configuration from JSON file and environment variables
 * Priority: Environment Variables > config.json > Defaults
 */
export function loadConfig(): Config {
  let config: Config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  let fileUserConfig: Record<string, unknown> | null = null;

  // Try to load from config.json
  try {
    const configPath = CONFIG_FILE_PATH;

    if (fs.existsSync(configPath)) {
      const configFile = fs.readFileSync(configPath, 'utf-8');
      fileUserConfig = JSON.parse(configFile);

      // Deep merge user config with defaults
      config = deepMerge(config, fileUserConfig);
      console.log('[Config] Loaded configuration from config.json');
    }
  } catch (error: any) {
    console.warn('[Config] Failed to load config.json, using defaults:', error.message);
  }

  // Eos hosts: avoid deepMerge pitfall (default hosts + user host). Prefer file intent.
  if (fileUserConfig && fileUserConfig.eos && typeof fileUserConfig.eos === 'object') {
    const ue = fileUserConfig.eos as Record<string, unknown>;
    if (Array.isArray(ue.hosts) && ue.hosts.length > 0) {
      config.eos.hosts = ue.hosts
        .map((h) => String(h).trim())
        .filter((h) => h.length > 0);
    } else if (typeof ue.host === 'string' && ue.host.trim()) {
      config.eos.hosts = [ue.host.trim()];
    }
  }
  delete (config.eos as unknown as Record<string, unknown>).host;

  if (process.env.EOS_HOST) {
    const parts = process.env.EOS_HOST.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    if (parts.length > 0) {
      config.eos.hosts = parts;
    }
  }

  if (process.env.EOS_PORT) {
    const port = parseInt(process.env.EOS_PORT, 10);
    if (!isNaN(port) && port > 0 && port <= 65535) {
      config.eos.port = port;
    } else {
      console.warn(`[Config] Invalid EOS_PORT: ${process.env.EOS_PORT}, using default ${config.eos.port}`);
    }
  }

  if (process.env.EOS_CONNECTION_TIMEOUT) {
    const timeout = parseInt(process.env.EOS_CONNECTION_TIMEOUT, 10);
    if (!isNaN(timeout) && timeout > 0) {
      config.eos.connectionTimeout = timeout;
    }
  }

  if (process.env.EOS_RECONNECT_MAX_ATTEMPTS) {
    const maxAttempts = parseInt(process.env.EOS_RECONNECT_MAX_ATTEMPTS, 10);
    if (!isNaN(maxAttempts) && maxAttempts >= 0) {
      config.eos.reconnectMaxAttempts = maxAttempts;
    }
  }

  // Cue List
  if (process.env.CUE_LIST) {
    const cueList = parseInt(process.env.CUE_LIST, 10);
    if (!isNaN(cueList) && cueList > 0) {
      config.cueList = cueList;
    }
  }

  // Data Synchronization
  if (process.env.SYNC_INTERVAL) {
    const interval = parseInt(process.env.SYNC_INTERVAL, 10);
    if (!isNaN(interval) && interval >= 0) {
      config.sync.syncInterval = interval;
    }
  }

  // WebSocket Server
  if (process.env.WEBSOCKET_PORT) {
    const port = parseInt(process.env.WEBSOCKET_PORT, 10);
    if (!isNaN(port) && port > 0 && port <= 65535) {
      config.websocket.port = port;
    } else {
      console.warn(`[Config] Invalid WEBSOCKET_PORT: ${process.env.WEBSOCKET_PORT}, using default ${config.websocket.port}`);
    }
  }

  // Logging
  if (process.env.LOG_LEVEL) {
    const level = process.env.LOG_LEVEL.toLowerCase();
    if (['debug', 'info', 'warn', 'error'].includes(level)) {
      config.logging.level = level as 'debug' | 'info' | 'warn' | 'error';
    }
  }

  if (process.env.LOG_OSC !== undefined) {
    config.logging.logOSC = process.env.LOG_OSC === 'true';
  }

  if (process.env.LOG_STATE !== undefined) {
    config.logging.logState = process.env.LOG_STATE === 'true';
  }

  // OBS WebSocket control
  if (process.env.OBS_CONTROL_ENABLED !== undefined) {
    config.obsControl.enabled = process.env.OBS_CONTROL_ENABLED === 'true';
  }

  if (process.env.OBS_WEBSOCKET_HOST) {
    config.obsControl.host = process.env.OBS_WEBSOCKET_HOST;
  }

  if (process.env.OBS_WEBSOCKET_PORT) {
    const port = parseInt(process.env.OBS_WEBSOCKET_PORT, 10);
    if (!isNaN(port) && port > 0 && port <= 65535) {
      config.obsControl.port = port;
    } else {
      console.warn(
        `[Config] Invalid OBS_WEBSOCKET_PORT: ${process.env.OBS_WEBSOCKET_PORT}, using default ${config.obsControl.port}`
      );
    }
  }

  if (process.env.OBS_WEBSOCKET_PASSWORD !== undefined) {
    config.obsControl.password = process.env.OBS_WEBSOCKET_PASSWORD;
  }

  if (process.env.OBS_RECORD_START_CUES !== undefined) {
    config.obsControl.recordStartCueNumbers = normalizeCueNumberList(
      parseCommaSeparatedCueNumbers(process.env.OBS_RECORD_START_CUES)
    );
  }

  if (process.env.OBS_RECORD_STOP_CUES !== undefined) {
    config.obsControl.recordStopCueNumbers = normalizeCueNumberList(
      parseCommaSeparatedCueNumbers(process.env.OBS_RECORD_STOP_CUES)
    );
  }

  if (process.env.OBS_RECORD_START_DELAY_MS !== undefined) {
    const ms = parseInt(process.env.OBS_RECORD_START_DELAY_MS, 10);
    if (!isNaN(ms) && ms >= 0) {
      config.obsControl.recordStartDelayMs = ms;
    } else {
      console.warn(
        `[Config] Invalid OBS_RECORD_START_DELAY_MS: ${process.env.OBS_RECORD_START_DELAY_MS}, using ${config.obsControl.recordStartDelayMs}`
      );
    }
  }

  if (process.env.OBS_RECORD_STOP_DELAY_MS !== undefined) {
    const ms = parseInt(process.env.OBS_RECORD_STOP_DELAY_MS, 10);
    if (!isNaN(ms) && ms >= 0) {
      config.obsControl.recordStopDelayMs = ms;
    } else {
      console.warn(
        `[Config] Invalid OBS_RECORD_STOP_DELAY_MS: ${process.env.OBS_RECORD_STOP_DELAY_MS}, using ${config.obsControl.recordStopDelayMs}`
      );
    }
  }

  // Normalize cue lists from config.json (trim / dedupe)
  config.obsControl.recordStartCueNumbers = normalizeCueNumberList(
    config.obsControl.recordStartCueNumbers
  );
  config.obsControl.recordStopCueNumbers = normalizeCueNumberList(
    config.obsControl.recordStopCueNumbers
  );
  config.obsControl.recordChapterMarkers = normalizeRecordChapterMarkers(
    (config.obsControl as any).recordChapterMarkers
  );
  // Support both canonical camelCase and user-provided PascalCase config key.
  if (typeof (config.obsControl as any).UseSceneBreakForChapters === 'boolean') {
    config.obsControl.useSceneBreakForChapters = (config.obsControl as any).UseSceneBreakForChapters;
  }
  if (fileUserConfig && typeof (fileUserConfig as any).UseSceneBreakForChapters === 'boolean') {
    config.obsControl.useSceneBreakForChapters = (fileUserConfig as any).UseSceneBreakForChapters;
  }

  if (process.env.OBS_USE_SCENE_BREAK_FOR_CHAPTERS !== undefined) {
    config.obsControl.useSceneBreakForChapters =
      process.env.OBS_USE_SCENE_BREAK_FOR_CHAPTERS === 'true';
  }
  if (process.env.USE_SCENE_BREAK_FOR_CHAPTERS !== undefined) {
    config.obsControl.useSceneBreakForChapters =
      process.env.USE_SCENE_BREAK_FOR_CHAPTERS === 'true';
  }

  // Overlay display options
  if (process.env.OVERLAY_SHOW_SCENE_HEADERS !== undefined) {
    config.overlay.showSceneHeaders = process.env.OVERLAY_SHOW_SCENE_HEADERS === 'true';
  }

  // Config UI server
  if (process.env.CONFIG_UI_ENABLED !== undefined) {
    config.configUI.enabled = process.env.CONFIG_UI_ENABLED === 'true';
  }

  if (process.env.CONFIG_UI_PORT) {
    const port = parseInt(process.env.CONFIG_UI_PORT, 10);
    if (!isNaN(port) && port > 0 && port <= 65535) {
      config.configUI.port = port;
    }
  }

  // Removed from app; ignore if still present in older config.json files
  delete (config as unknown as Record<string, unknown>).useEosConsoleAPI;

  // Validate configuration
  validateConfig(config);

  return config;
}

/**
 * Validate configuration
 */
function validateConfig(config: Config): void {
  const errors: string[] = [];

  if (!config.eos.hosts || config.eos.hosts.length < 1) {
    errors.push('At least one Eos console host is required (eos.hosts or eos.host)');
  }
  for (let i = 0; i < (config.eos.hosts || []).length; i++) {
    const h = config.eos.hosts[i];
    if (!h || String(h).trim() === '') {
      errors.push(`EOS hosts[${i}] cannot be empty`);
    }
  }

  // Validate ports
  if (config.eos.port < 1 || config.eos.port > 65535) {
    errors.push(`EOS_PORT must be between 1 and 65535 (got ${config.eos.port})`);
  }

  if (config.websocket.port < 1 || config.websocket.port > 65535) {
    errors.push(`WEBSOCKET_PORT must be between 1 and 65535 (got ${config.websocket.port})`);
  }

  // Validate timeouts
  if (config.eos.connectionTimeout < 1000) {
    errors.push(`EOS_CONNECTION_TIMEOUT must be at least 1000ms (got ${config.eos.connectionTimeout})`);
  }

  // Validate cue list
  if (config.cueList < 1) {
    errors.push(`CUE_LIST must be positive (got ${config.cueList})`);
  }

  if (config.obsControl.enabled) {
    if (!config.obsControl.host || config.obsControl.host.trim() === '') {
      errors.push('OBS_WEBSOCKET_HOST cannot be empty when OBS control is enabled');
    }
    if (config.obsControl.port < 1 || config.obsControl.port > 65535) {
      errors.push(
        `OBS_WEBSOCKET_PORT must be between 1 and 65535 (got ${config.obsControl.port})`
      );
    }
    if (config.obsControl.recordStartDelayMs < 0) {
      errors.push(
        `OBS record start delay must be >= 0 (got ${config.obsControl.recordStartDelayMs})`
      );
    }
    if (config.obsControl.recordStopDelayMs < 0) {
      errors.push(
        `OBS record stop delay must be >= 0 (got ${config.obsControl.recordStopDelayMs})`
      );
    }
    for (let i = 0; i < (config.obsControl.recordChapterMarkers || []).length; i++) {
      const m = config.obsControl.recordChapterMarkers[i];
      if (!m.cueNumber || m.cueNumber.trim() === '') {
        errors.push(`OBS chapter marker cueNumber cannot be empty (index ${i})`);
      }
      if (!m.label || m.label.trim() === '') {
        errors.push(`OBS chapter marker label cannot be empty (index ${i})`);
      }
    }
  }

  // Throw if validation failed
  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }
}

/**
 * Print configuration summary
 */
export function printConfigSummary(config: Config): void {
  console.log('\n========================================');
  console.log('  Eos-to-OBS Overlay Bridge');
  console.log('========================================\n');

  console.log('Eos Console:');
  console.log(`  Hosts (try in order): ${config.eos.hosts.join(' → ')}`);
  console.log(`  Port: ${config.eos.port}`);
  console.log(`  Connection Timeout: ${config.eos.connectionTimeout}ms`);
  console.log(`  Max Reconnection Attempts: ${config.eos.reconnectMaxAttempts === 0 ? 'Infinite' : config.eos.reconnectMaxAttempts}`);
  console.log(`  Reconnection Interval: ${config.eos.connectionTimeout}ms (same as connection timeout)`);

  console.log(`\n  Tracking Cue List: ${config.cueList}`);

  console.log('\nData Synchronization:');
  console.log(`  Sync on Connect: Yes (always)`);
  console.log(`  Periodic Sync: ${config.sync.syncInterval === 0 ? 'Disabled' : `every ${config.sync.syncInterval}ms`}`);
  console.log(`  Prefetch: next 2 cues (always enabled)`);

  console.log('\nOverlay HTTP + WebSocket (same port):');
  console.log(`  Port: ${config.websocket.port}`);
  console.log(
    `  OBS Browser Source URL: http://127.0.0.1:${config.websocket.port}/ (avoid file:// — OBS CEF often blocks WebSocket)`
  );

  console.log('\nLogging:');
  console.log(`  Level: ${config.logging.level}`);
  console.log(`  Log OSC Messages: ${config.logging.logOSC ? 'Yes' : 'No'}`);
  console.log(`  Log State Transitions: ${config.logging.logState ? 'Yes' : 'No'}`);

  console.log('\nOBS WebSocket control:');
  console.log(`  Enabled: ${config.obsControl.enabled ? 'Yes' : 'No'}`);
  if (config.obsControl.enabled) {
    console.log(`  Host: ${config.obsControl.host}`);
    console.log(`  Port: ${config.obsControl.port}`);
    console.log(`  Record start cues: ${config.obsControl.recordStartCueNumbers.join(', ') || '(none)'}`);
    console.log(`  Record stop cues: ${config.obsControl.recordStopCueNumbers.join(', ') || '(none)'}`);
    console.log(`  Chapter markers: ${config.obsControl.recordChapterMarkers.length} configured`);
    console.log(
      `  Scene break chapters: ${config.obsControl.useSceneBreakForChapters ? 'Enabled' : 'Disabled'}`
    );
    console.log(`  Record start delay: ${config.obsControl.recordStartDelayMs}ms`);
    console.log(`  Record stop delay: ${config.obsControl.recordStopDelayMs}ms`);
  }

  console.log('\n========================================\n');
}

/**
 * Export configured instance
 */
export const config = loadConfig();
