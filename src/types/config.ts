/**
 * Application Configuration Types
 */

import { CueState } from './cue';

/**
 * OSC Server Configuration
 */
export interface OSCConfig {
  port: number;
  localAddress: string;
  metadata: boolean;
}

/**
 * WebSocket Server Configuration  
 */
export interface WebSocketConfig {
  port: number;
  pingInterval: number;
  pongTimeout: number;
  maxClients: number;
}

/**
 * Cue tracking configuration
 */
export interface CueTrackingConfig {
  staleTimeout: number;              // Milliseconds before marking cue as stale
  extendedStaleTimeout: number;      // Milliseconds before cleaning up stale cues
  maxHistoryLength: number;          // Maximum state transitions to keep per cue
  maxProgressHistory: number;        // Maximum progress entries for rate calculation
  completionTimeout: number;         // Auto-finish timeout for completing cues
  fireExecutionTimeout: number;      // Time to wait for ACTIVE after FIRE
  enabledCueLists: string[];         // Only process cues from these lists
}

/**
 * Logging configuration
 */
export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  enableTimestamps: boolean;
  enableStateTransitionLogging: boolean;
  enableOSCRawLogging: boolean;
  enableBroadcastLogging: boolean;
  logFile?: string;
}

/**
 * Cache configuration
 */
export interface CacheConfig {
  enabled: boolean;
  ttl: number;                       // Time to live in milliseconds
  maxEntries: number;                // Maximum cache entries
  cleanupInterval: number;           // Cache cleanup interval
}

/**
 * Main application configuration
 */
export interface AppConfig {
  osc: OSCConfig;
  websocket: WebSocketConfig;
  cueTracking: CueTrackingConfig;
  logging: LoggingConfig;
  cache: CacheConfig;
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: AppConfig = {
  osc: {
    port: 8001,
    localAddress: '0.0.0.0',
    metadata: true,
  },
  websocket: {
    port: 8081,
    pingInterval: 30000,
    pongTimeout: 5000,
    maxClients: 10,
  },
  cueTracking: {
    staleTimeout: 2000,
    extendedStaleTimeout: 6000,
    maxHistoryLength: 50,
    maxProgressHistory: 10,
    completionTimeout: 500,
    fireExecutionTimeout: 1000,
    enabledCueLists: ['1'], // Only process cue list 1
  },
  logging: {
    level: 'info',
    enableTimestamps: true,
    enableStateTransitionLogging: true,
    enableOSCRawLogging: true,
    enableBroadcastLogging: true,
  },
  cache: {
    enabled: true,
    ttl: 30000,
    maxEntries: 1000,
    cleanupInterval: 60000,
  },
};

/**
 * Environment-based configuration overrides
 */
export interface EnvironmentConfig {
  NODE_ENV?: 'development' | 'production' | 'test';
  OSC_PORT?: string;
  WEBSOCKET_PORT?: string;
  LOG_LEVEL?: 'debug' | 'info' | 'warn' | 'error';
  ENABLED_CUE_LISTS?: string; // Comma-separated list
}