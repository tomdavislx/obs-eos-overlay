/**
 * ETC Eos Console Integration Types
 * Types for connection, cue data synchronization, and console API
 */

/**
 * Eos console connection configuration
 */
export interface EosConnectionConfig {
  host: string;                       // Console IP address (e.g., '10.101.100.101')
  port: number;                       // Port for OSC + API (default: 3037)
  connectionTimeout: number;          // Connection timeout in ms
  reconnectMaxAttempts: number;       // Max reconnection attempts (0 = infinite)
  reconnectDelays: number[];          // Exponential backoff delays in ms [1000, 2000, 5000, 10000, 30000]
}

/**
 * Connection state
 */
export enum EosConnectionState {
  DISCONNECTED = 'DISCONNECTED',      // Not connected
  CONNECTING = 'CONNECTING',          // Connection in progress
  CONNECTED = 'CONNECTED',            // Successfully connected and synced
  RECONNECTING = 'RECONNECTING',      // Attempting to reconnect
  ERROR = 'ERROR',                    // Connection error state
}

/**
 * Cue data from Eos console API
 * Based on eos-console library's Cue interface
 */
export interface EosConsoleCue {
  uid: string;                        // Unique ID
  targetNumber: number;               // Cue number (can be fractional, e.g., 163.5)
  label: string;                      // Cue label/name

  // Timing information (all in milliseconds)
  upTimeDurationMs?: number;          // Up fade time
  downTimeDurationMs?: number;        // Down fade time
  focusTimeDurationMs?: number;       // Focus fade time
  colorTimeDurationMs?: number;       // Color fade time
  beamTimeDurationMs?: number;        // Beam fade time

  // Additional timing
  followTimeMs?: number;              // Follow time
  hangTimeMs?: number;                // Hang time

  // Cue properties
  mark?: boolean;                     // Mark cue
  block?: boolean;                    // Block cue
  assert?: boolean;                   // Assert cue
  cueOnly?: boolean;                  // Cue only

  // Advanced properties
  scene?: string;                     // Scene text
  notes?: string;                     // Cue notes
  partCount?: number;                 // Number of parts

  // Links
  links?: {
    cueList?: number;
    part?: number;
  };
}

/**
 * Cached cue data entry
 */
export interface CueCacheEntry {
  cueId: string;                      // Format: "list/number" (e.g., "1/163")
  cueList: number;
  cueNumber: number;

  // Data from console
  label: string;
  fadeTimeMs: number | null;          // Best available fade time
  upTimeMs: number | null;
  focusTimeMs: number | null;
  colorTimeMs: number | null;
  beamTimeMs: number | null;

  // Metadata
  mark: boolean;
  block: boolean;
  scene: string | null;
  notes: string | null;

  // Cache metadata
  cachedAt: number;                   // Timestamp when cached
  fetchedFrom: 'initial-sync' | 'on-demand' | 'prefetch';
}

/**
 * Data synchronization configuration
 */
export interface SyncOptions {
  syncOnConnect: boolean;             // Perform full sync on connection
  syncInterval: number;               // Full sync interval in ms (0 = disabled)
  prefetchEnabled: boolean;           // Enable smart prefetch
  prefetchCount: number;              // Number of cues to prefetch ahead
  cacheTTL: number;                   // Cache time-to-live in ms
  cacheMaxSize: number;               // Maximum cache entries
}

/**
 * Sync status
 */
export interface SyncStatus {
  lastSyncAt: number | null;          // Timestamp of last full sync
  nextSyncAt: number | null;          // Timestamp of next scheduled sync
  cuesInCache: number;                // Number of cached cues
  syncInProgress: boolean;            // Whether sync is currently running
  lastSyncDuration: number | null;    // Duration of last sync in ms
  lastSyncCueCount: number | null;    // Number of cues from last sync
}

/**
 * OSC message structure from eos-console
 */
export interface EosOSCMessage {
  address: string;                    // OSC address (e.g., '/eos/out/active/cue/text')
  args: Array<string | number | boolean>;  // OSC arguments
  timeTag?: {
    raw: [number, number];
    native: number;
  };
}

/**
 * Connection event types
 */
export enum EosConnectionEvent {
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  OSC_MESSAGE = 'osc-message',
  ERROR = 'error',
  RECONNECTING = 'reconnecting',
  SYNC_COMPLETE = 'sync-complete',
}

/**
 * Connection error details
 */
export interface EosConnectionError {
  code: string;                       // Error code (e.g., 'ECONNREFUSED', 'TIMEOUT')
  message: string;                    // Human-readable message
  timestamp: number;
  recoverable: boolean;               // Whether automatic reconnection should be attempted
  attemptNumber?: number;             // Reconnection attempt number
}

/**
 * Reconnection state
 */
export interface ReconnectionState {
  isReconnecting: boolean;
  attemptNumber: number;
  nextAttemptAt: number | null;       // Timestamp of next reconnection attempt
  lastError: EosConnectionError | null;
}

/**
 * Console version information
 */
export interface EosConsoleVersion {
  version: string;                    // e.g., "3.2.1"
  build?: string;                     // Build number
}

/**
 * Cue list information from console
 */
export interface EosCueList {
  number: number;                     // Cue list number
  label?: string;                     // Cue list label
  cueCount?: number;                  // Number of cues in list
  independentEnabled?: boolean;       // Independent mode
}

/**
 * Prefetch request
 */
export interface PrefetchRequest {
  cueList: number;
  cueNumbers: number[];               // List of cue numbers to prefetch
  priority: 'high' | 'normal' | 'low';
  requestedAt: number;
}

/**
 * Fetch result
 */
export interface FetchResult {
  success: boolean;
  cueId: string;
  cached: boolean;                    // Whether data was from cache
  fetchDuration?: number;             // Time taken to fetch in ms
  error?: string;
}
