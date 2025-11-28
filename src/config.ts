/**
 * Application Configuration
 * Loads configuration from environment variables with validation
 */

import {
  EosConnectionConfig,
  SyncOptions,
} from './types/eos';

/**
 * Main application configuration
 */
export interface Config {
  // Eos Console Connection
  eos: EosConnectionConfig;

  // Cue List Tracking
  cueList: number;

  // Data Synchronization
  sync: SyncOptions;

  // Feature flags
  useEosConsoleAPI: boolean;

  // WebSocket Server
  websocket: {
    port: number;
    pingInterval: number;
  };

  // Cue State Management
  cueTracking: {
    staleTimeout: number;
    completionTimeout: number;
  };

  // Logging
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    logOSC: boolean;
    logState: boolean;
  };
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Config = {
  eos: {
    host: 'localhost',
    port: 3037,
    connectionTimeout: 10000,
    reconnectMaxAttempts: 0, // Infinite reconnection
    reconnectDelays: [1000, 2000, 5000, 10000, 30000], // Exponential backoff
  },
  cueList: 1,
  useEosConsoleAPI: true, // Enable API for accurate fade times
  sync: {
    syncOnConnect: true,
    syncInterval: 300000, // 5 minutes
    prefetchEnabled: true,
    prefetchCount: 2,
    cacheTTL: 600000, // 10 minutes
    cacheMaxSize: 10000,
  },
  websocket: {
    port: 8081,
    pingInterval: 30000,
  },
  cueTracking: {
    staleTimeout: 2000,
    completionTimeout: 500,
  },
  logging: {
    level: 'info',
    logOSC: false,
    logState: true,
  },
};

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

  // Try to load from config.json
  try {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(process.cwd(), 'config.json');

    if (fs.existsSync(configPath)) {
      const configFile = fs.readFileSync(configPath, 'utf-8');
      const userConfig = JSON.parse(configFile);

      // Deep merge user config with defaults
      config = deepMerge(config, userConfig);
      console.log('[Config] Loaded configuration from config.json');
    }
  } catch (error: any) {
    console.warn('[Config] Failed to load config.json, using defaults:', error.message);
  }

  // Eos Console Connection
  if (process.env.EOS_HOST) {
    config.eos.host = process.env.EOS_HOST;
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

  // Feature flags
  if (process.env.USE_EOS_CONSOLE_API !== undefined) {
    config.useEosConsoleAPI = process.env.USE_EOS_CONSOLE_API === 'true';
  }

  // Data Synchronization
  if (process.env.SYNC_ON_CONNECT !== undefined) {
    config.sync.syncOnConnect = process.env.SYNC_ON_CONNECT === 'true';
  }

  if (process.env.SYNC_INTERVAL) {
    const interval = parseInt(process.env.SYNC_INTERVAL, 10);
    if (!isNaN(interval) && interval >= 0) {
      config.sync.syncInterval = interval;
    }
  }

  if (process.env.PREFETCH_ENABLED !== undefined) {
    config.sync.prefetchEnabled = process.env.PREFETCH_ENABLED === 'true';
  }

  if (process.env.CACHE_TTL) {
    const ttl = parseInt(process.env.CACHE_TTL, 10);
    if (!isNaN(ttl) && ttl > 0) {
      config.sync.cacheTTL = ttl;
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

  if (process.env.WEBSOCKET_PING_INTERVAL) {
    const interval = parseInt(process.env.WEBSOCKET_PING_INTERVAL, 10);
    if (!isNaN(interval) && interval > 0) {
      config.websocket.pingInterval = interval;
    }
  }

  // Cue Tracking
  if (process.env.STALE_TIMEOUT) {
    const timeout = parseInt(process.env.STALE_TIMEOUT, 10);
    if (!isNaN(timeout) && timeout > 0) {
      config.cueTracking.staleTimeout = timeout;
    }
  }

  if (process.env.COMPLETION_TIMEOUT) {
    const timeout = parseInt(process.env.COMPLETION_TIMEOUT, 10);
    if (!isNaN(timeout) && timeout > 0) {
      config.cueTracking.completionTimeout = timeout;
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

  // Validate configuration
  validateConfig(config);

  return config;
}

/**
 * Validate configuration
 */
function validateConfig(config: Config): void {
  const errors: string[] = [];

  // Validate host
  if (!config.eos.host || config.eos.host.trim() === '') {
    errors.push('EOS_HOST cannot be empty');
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

  if (config.cueTracking.staleTimeout < 500) {
    errors.push(`STALE_TIMEOUT must be at least 500ms (got ${config.cueTracking.staleTimeout})`);
  }

  // Validate cue list
  if (config.cueList < 1) {
    errors.push(`CUE_LIST must be positive (got ${config.cueList})`);
  }

  // Validate sync options
  if (config.sync.cacheTTL < 1000) {
    errors.push(`CACHE_TTL must be at least 1000ms (got ${config.sync.cacheTTL})`);
  }

  if (config.sync.prefetchCount < 1) {
    errors.push(`Prefetch count must be positive (got ${config.sync.prefetchCount})`);
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
  console.log(`  Host: ${config.eos.host}`);
  console.log(`  Port: ${config.eos.port}`);
  console.log(`  Connection Timeout: ${config.eos.connectionTimeout}ms`);
  console.log(`  Max Reconnection Attempts: ${config.eos.reconnectMaxAttempts === 0 ? 'Infinite' : config.eos.reconnectMaxAttempts}`);
  console.log(`  Reconnection Delays: ${config.eos.reconnectDelays.join(', ')}ms`);

  console.log('\nCue Tracking:');
  console.log(`  Target Cue List: ${config.cueList}`);
  console.log(`  Stale Timeout: ${config.cueTracking.staleTimeout}ms`);
  console.log(`  Completion Timeout: ${config.cueTracking.completionTimeout}ms`);

  console.log('\nFeature Flags:');
  console.log(`  Use Eos Console API: ${config.useEosConsoleAPI ? 'Yes (Enhanced mode with accurate fade times)' : 'No (OSC-only mode)'}`);

  console.log('\nData Synchronization:');
  console.log(`  Sync on Connect: ${config.sync.syncOnConnect ? 'Yes' : 'No'}`);
  console.log(`  Sync Interval: ${config.sync.syncInterval === 0 ? 'Disabled' : `${config.sync.syncInterval}ms`}`);
  console.log(`  Prefetch Enabled: ${config.sync.prefetchEnabled ? 'Yes' : 'No'}`);
  console.log(`  Prefetch Count: ${config.sync.prefetchCount} cues ahead`);
  console.log(`  Cache TTL: ${config.sync.cacheTTL}ms`);
  console.log(`  Cache Max Size: ${config.sync.cacheMaxSize} entries`);

  console.log('\nWebSocket Server:');
  console.log(`  Port: ${config.websocket.port}`);
  console.log(`  Ping Interval: ${config.websocket.pingInterval}ms`);

  console.log('\nLogging:');
  console.log(`  Level: ${config.logging.level}`);
  console.log(`  Log OSC Messages: ${config.logging.logOSC ? 'Yes' : 'No'}`);
  console.log(`  Log State Transitions: ${config.logging.logState ? 'Yes' : 'No'}`);

  console.log('\n========================================\n');
}

/**
 * Export configured instance
 */
export const config = loadConfig();
