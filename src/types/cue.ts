/**
 * Cue State Management Types
 * Defines the complete lifecycle and data structures for lighting cues
 */

/**
 * Comprehensive cue state enumeration
 * Covers all possible states from discovery to completion
 */
export enum CueState {
  DISCOVERED = 'DISCOVERED',     // Cue first detected but not validated
  ACTIVE = 'ACTIVE',             // Cue running with progress updates (0-99%)
  COMPLETING = 'COMPLETING',     // Cue reached 100% but may still be transitioning
  BACKGROUND = 'BACKGROUND',     // Cue moved to previous list, running in background
  FINISHED = 'FINISHED',         // Cue completed successfully
  TERMINATED = 'TERMINATED',     // Cue interrupted by another cue firing
  STALE = 'STALE',              // Cue hasn't received updates, may be orphaned
  ERROR = 'ERROR',              // Cue in error state due to validation/parsing issues
}

/**
 * Valid state transitions for finite state machine
 */
export const VALID_TRANSITIONS: Record<CueState, CueState[]> = {
  [CueState.DISCOVERED]: [CueState.ACTIVE, CueState.ERROR, CueState.STALE, CueState.FINISHED],
  [CueState.ACTIVE]: [CueState.COMPLETING, CueState.BACKGROUND, CueState.TERMINATED, CueState.STALE, CueState.FINISHED],
  [CueState.COMPLETING]: [CueState.FINISHED, CueState.BACKGROUND, CueState.TERMINATED, CueState.STALE],
  [CueState.BACKGROUND]: [CueState.FINISHED, CueState.TERMINATED, CueState.STALE],
  [CueState.FINISHED]: [CueState.ACTIVE], // Can be reactivated by FIRE events
  [CueState.TERMINATED]: [], // Terminal state - gets cleaned up directly
  [CueState.STALE]: [CueState.ACTIVE, CueState.ERROR, CueState.FINISHED],
  [CueState.ERROR]: [CueState.DISCOVERED, CueState.STALE],
};

/**
 * Source of cue data - affects how cue is processed
 */
export enum CueSource {
  FIRE = 'fire',           // Created from FIRE event
  ACTIVE = 'active',       // From active cue OSC message
  PREVIOUS = 'previous',   // From previous cue OSC message
  MANUAL = 'manual',       // Manually created/modified
}

/**
 * Progress tracking for rate calculations
 */
export interface CueProgressEntry {
  percentage: string;
  timestamp: number;
}

/**
 * State transition history for debugging
 */
export interface CueStateTransition {
  from: CueState | null;
  to: CueState;
  timestamp: number;
  reason: string;
}

/**
 * Complete cue data structure
 */
export interface CueData {
  // Identity
  cueId: string;                    // e.g., "1/163"
  cueList: string;                  // e.g., "1"
  cueNumber: string;                // e.g., "163" or "163.5"
  
  // Content
  label: string;                    // e.g., "Scene 9 - Interview"
  time: number | null;              // Duration in seconds
  percentage: string | null;        // Current progress, e.g., "73%"
  
  // State management
  state: CueState;
  source: CueSource;
  
  // Timestamps
  discoveredAt: number;
  lastUpdate: number;
  lastStateChange: number;
  
  // Progress tracking
  progressHistory: CueProgressEntry[];
  
  // Metadata
  raw: string;                      // Original OSC message or identifier
  fireExecuted?: boolean;           // Whether FIRE event was followed by ACTIVE
  
  // Computed properties
  isRunning?: boolean;              // Convenience property for overlay
  isBackgroundRunning?: boolean;    // Running in background
  isStale?: boolean;                // Stale state indicator
  estimatedCompletionTime?: number; // Milliseconds until completion
}

/**
 * Cue validation result
 */
export interface CueValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
}

/**
 * Cue collection state for tracking multiple cues
 */
export interface CueCollectionState {
  activeCues: CueData[];
  headerCue: CueData | null;
  lastFiredCue: {
    cueId: string;
    cueList: string;
    cueNumber: string;
    fireTimestamp: number;
  } | null;
  totalTrackedCues: number;
  stateDistribution: Record<CueState, number>;
}

/**
 * Events that can be sent to cue state machines
 */
export enum CueEvent {
  FIRE = 'FIRE',                    // Cue was fired
  UPDATE = 'UPDATE',                // Progress/data update
  COMPLETE = 'COMPLETE',            // Reached 100%
  MOVE_TO_BACKGROUND = 'MOVE_TO_BACKGROUND', // Moved to previous list
  TERMINATE = 'TERMINATE',          // Interrupted by another cue
  TIMEOUT = 'TIMEOUT',              // No updates received
  ERROR = 'ERROR',                  // Validation or processing error
  CLEANUP = 'CLEANUP',              // Ready for cleanup
}

/**
 * XState event data structures
 */
export interface CueFireEventData {
  type: CueEvent.FIRE;
  fireTimestamp: number;
  label?: string;
}

export interface CueUpdateEventData {
  type: CueEvent.UPDATE;
  cueData: Partial<CueData>;
  source: CueSource;
}

export interface CueCompleteEventData {
  type: CueEvent.COMPLETE;
  finalPercentage: string;
}

export interface CueTerminateEventData {
  type: CueEvent.TERMINATE;
  reason: string;
  terminatedBy?: string;
}

export interface CueTimeoutEventData {
  type: CueEvent.TIMEOUT;
  lastUpdate: number;
}

export interface CueErrorEventData {
  type: CueEvent.ERROR;
  error: string;
  recoverable: boolean;
}

export type CueEventData = 
  | CueFireEventData
  | CueUpdateEventData
  | CueCompleteEventData
  | CueTerminateEventData
  | CueTimeoutEventData
  | CueErrorEventData;