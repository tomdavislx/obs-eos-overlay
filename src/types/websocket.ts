/**
 * WebSocket Communication Types
 * For communication with OBS overlay clients
 */

import { CueData } from './cue';

/**
 * Message types sent to overlay clients
 */
export enum OverlayMessageType {
  CUE_UPDATE = 'CUE_UPDATE',
  SINGLE_CUE = 'SINGLE_CUE',      // Fallback for unparsed cues
  CONNECTION_STATUS = 'CONNECTION_STATUS',
  ERROR = 'ERROR',
  DEBUG = 'DEBUG',
}

/**
 * Standard overlay message structure
 */
export interface OverlayMessage {
  type: OverlayMessageType;
  timestamp: number;
  data: any;
}

/**
 * Cue update message sent to overlays
 */
export interface CueUpdateMessage extends OverlayMessage {
  type: OverlayMessageType.CUE_UPDATE;
  data: {
    activeCues: CueData[];
    latestCue: CueData | null;
    totalTrackedCues: number;
  };
}

/**
 * Single cue message (for fallback/error cases)
 */
export interface SingleCueMessage extends OverlayMessage {
  type: OverlayMessageType.SINGLE_CUE;
  data: {
    singleCue: {
      raw: string;
      error?: string;
    };
  };
}

/**
 * Connection status message
 */
export interface ConnectionStatusMessage extends OverlayMessage {
  type: OverlayMessageType.CONNECTION_STATUS;
  data: {
    connected: boolean;
    clientCount: number;
    oscConnected: boolean;
  };
}

/**
 * Error message
 */
export interface ErrorMessage extends OverlayMessage {
  type: OverlayMessageType.ERROR;
  data: {
    error: string;
    code?: string;
    recoverable: boolean;
  };
}

/**
 * Debug message
 */
export interface DebugMessage extends OverlayMessage {
  type: OverlayMessageType.DEBUG;
  data: {
    level: 'info' | 'warn' | 'error';
    message: string;
    context?: any;
  };
}

/**
 * WebSocket client management
 */
export interface WebSocketClient {
  id: string;
  socket: any; // WebSocket instance
  connectedAt: number;
  lastPing?: number;
}

/**
 * WebSocket server configuration
 */
export interface WebSocketConfig {
  port: number;
  pingInterval?: number;
  pongTimeout?: number;
  maxClients?: number;
}