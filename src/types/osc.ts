/**
 * OSC Message Types and Interfaces
 * Based on OSC 1.0 specification and ETC Eos console patterns
 */

export interface OSCArgument {
  type: string;
  value: any;
}

export interface OSCMessage {
  address: string;
  args: OSCArgument[];
  origin: {
    address: string;
    family: string;
    port: number;
    size: number;
  };
  timeTag?: {
    raw: [number, number];
    native: number;
  };
}

/**
 * ETC Eos specific OSC message patterns
 */
export enum EosMessageType {
  ACTIVE_CUE_TEXT = '/eos/out/active/cue/text',
  ACTIVE_CUE_NUMBER = '/eos/out/active/cue',
  PREVIOUS_CUE_TEXT = '/eos/out/previous/cue/text',
  PREVIOUS_CUE_NUMBER = '/eos/out/previous/cue',
  PENDING_CUE_TEXT = '/eos/out/pending/cue/text',
  PENDING_CUE_NUMBER = '/eos/out/pending/cue',
  CUE_FIRE = '/eos/out/event/cue',  // Followed by /{list}/{number}/fire
  USER_COMMAND = '/eos/out/user',
  SHOW_CONTROL = '/eos/out/show',
}

export interface EosFireEvent {
  address: string; // e.g., "/eos/out/event/cue/1/163/fire"
  cueList: string;
  cueNumber: string;
  label?: string;
}

export interface EosActiveCueMessage {
  cueText: string; // e.g., "1/163 **MIDI** Scene 9 - Interview 5.5 73%"
  percentage?: number; // Parsed from message
}

export interface EosPreviousCueMessage {
  cueText: string; // e.g., "1/162.5 Background Music 3.0"
}

/**
 * OSC Message validation and parsing utilities
 */
export interface OSCValidationResult {
  valid: boolean;
  error?: string;
  messageType?: EosMessageType;
}

export interface ParsedCueData {
  cueList: string;
  cueNumber: string;
  label: string;
  time: number;
  percentage?: string;
  raw: string;
}

export interface OSCMessageHandler {
  pattern: string | RegExp;
  handler: (message: OSCMessage) => void | Promise<void>;
}