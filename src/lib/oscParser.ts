/**
 * OSC Message Parser
 * Parses OSC messages from Eos console
 */

import { EosOSCMessage } from '../types/eos';

export interface ParsedActiveCue {
  cueList: string;
  cueNumber: string;
  label: string;
  time: number;
  percentage: string;
  raw: string;
}

export interface ParsedPreviousCue {
  cueList: string;
  cueNumber: string;
  label: string;
  time: number;
  raw: string;
}

export interface ParsedFireEvent {
  cueList: string;
  cueNumber: string;
}

export interface OSCValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Parse time string (supports decimal seconds, MM:SS, HH:MM:SS)
 */
export function parseTimeString(timeString: string): number {
  if (timeString.includes(':')) {
    const parts = timeString.split(':').map(parseFloat);

    if (parts.length === 2) {
      // MM:SS format
      const [minutes, seconds] = parts;
      return minutes * 60 + seconds;
    } else if (parts.length === 3) {
      // HH:MM:SS format
      const [hours, minutes, seconds] = parts;
      return hours * 3600 + minutes * 60 + seconds;
    } else {
      // Fallback to decimal parsing
      return parseFloat(timeString);
    }
  } else {
    // Decimal seconds format
    return parseFloat(timeString);
  }
}

/**
 * Parse active cue message
 * Expected format: [CUE_LIST]/[CUE_NUMBER] [CUE_LABEL] [CUE_TIME] [CUE_PERCENTAGE]
 * Strategy: Work backwards from the end to avoid label interference
 */
export function parseActiveCue(fullCueText: string): ParsedActiveCue | null {
  if (!fullCueText || typeof fullCueText !== 'string') {
    return null;
  }

  // First, extract the percentage (always ends with %)
  const percentageMatch = fullCueText.match(/\s+(\d+%)$/);
  if (!percentageMatch) {
    return null; // No percentage found at end
  }
  const percentage = percentageMatch[1];
  const withoutPercentage = fullCueText.slice(0, -percentageMatch[0].length);

  // Extract the time (decimal seconds, MM:SS, or HH:MM:SS format before percentage)
  const timeMatch = withoutPercentage.match(/\s+(\d+(?:\.\d+)?|\d+:\d+(?:\.\d+)?|\d+:\d+:\d+(?:\.\d+)?)$/);
  if (!timeMatch) {
    return null; // No time found before percentage
  }
  const timeString = timeMatch[1];
  const time = parseTimeString(timeString);
  const withoutTime = withoutPercentage.slice(0, -timeMatch[0].length);

  // Extract cue list and number from the beginning (support decimal cue numbers)
  const cueMatch = withoutTime.match(/^(\d+)\/(\d+(?:\.\d+)?)\s+(.+)$/);
  if (!cueMatch) {
    return null; // Invalid cue format
  }

  const cueList = cueMatch[1];
  const cueNumber = cueMatch[2];
  const label = cueMatch[3].trim(); // Clean up any extra whitespace

  return {
    cueList,
    cueNumber,
    label,
    time,
    percentage,
    raw: fullCueText,
  };
}

/**
 * Parse previous cue message
 * Expected format: [CUE_LIST]/[CUE_NUMBER] [CUE_LABEL] [CUE_TIME]
 * Strategy: Work backwards from the end to avoid label interference
 */
export function parsePreviousCue(fullCueText: string): ParsedPreviousCue | null {
  if (!fullCueText || typeof fullCueText !== 'string') {
    return null;
  }

  // Extract the time (decimal seconds, MM:SS, or HH:MM:SS format at the end)
  const timeMatch = fullCueText.match(/\s+(\d+(?:\.\d+)?|\d+:\d+(?:\.\d+)?|\d+:\d+:\d+(?:\.\d+)?)$/);
  if (!timeMatch) {
    return null; // No time found at end
  }
  const timeString = timeMatch[1];
  const time = parseTimeString(timeString);
  const withoutTime = fullCueText.slice(0, -timeMatch[0].length);

  // Extract cue list and number from the beginning (support decimal cue numbers)
  const cueMatch = withoutTime.match(/^(\d+)\/(\d+(?:\.\d+)?)\s+(.+)$/);
  if (!cueMatch) {
    return null; // Invalid cue format
  }

  const cueList = cueMatch[1];
  const cueNumber = cueMatch[2];
  const label = cueMatch[3].trim(); // Clean up any extra whitespace

  return {
    cueList,
    cueNumber,
    label,
    time,
    raw: fullCueText,
  };
}

/**
 * Parse fire event
 * Expected address format: /eos/out/event/cue/[CUE_LIST]/[CUE_NUMBER]/fire
 */
export function parseFireEvent(address: string): ParsedFireEvent | null {
  if (!address || typeof address !== 'string') {
    return null;
  }

  // Match pattern: /eos/out/event/cue/{list}/{number}/fire
  const match = address.match(/\/eos\/out\/event\/cue\/(\d+)\/(\d+(?:\.\d+)?)\/fire/);
  if (!match) {
    return null;
  }

  return {
    cueList: match[1],
    cueNumber: match[2],
  };
}

/**
 * Validate OSC message structure
 */
export function validateOSCMessage(oscMsg: any): OSCValidationResult {
  if (!oscMsg) {
    return { valid: false, error: 'Null or undefined OSC message' };
  }

  if (!oscMsg.address || typeof oscMsg.address !== 'string') {
    return { valid: false, error: 'Invalid or missing OSC address' };
  }

  if (!oscMsg.args || !Array.isArray(oscMsg.args)) {
    return { valid: false, error: 'Invalid or missing OSC arguments' };
  }

  return { valid: true };
}

/**
 * Extract text from OSC args
 */
export function extractTextFromArgs(args: Array<string | number | boolean>): string | null {
  if (!args || args.length === 0) {
    return null;
  }

  // Get first string argument
  const textArg = args.find(arg => typeof arg === 'string');

  if (!textArg || typeof textArg !== 'string') {
    return null;
  }

  return textArg.trim();
}

/**
 * Check if OSC address matches pattern
 */
export function matchesAddress(address: string, pattern: string): boolean {
  if (pattern.includes('*')) {
    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '[^/]+');
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(address);
  }

  return address === pattern;
}

/**
 * Check if message is active cue message
 */
export function isActiveCueMessage(message: EosOSCMessage): boolean {
  return message.address === '/eos/out/active/cue/text';
}

/**
 * Check if message is previous cue message
 */
export function isPreviousCueMessage(message: EosOSCMessage): boolean {
  return message.address === '/eos/out/previous/cue/text';
}

/**
 * Check if message is pending cue message
 */
export function isPendingCueMessage(message: EosOSCMessage): boolean {
  return message.address === '/eos/out/pending/cue/text';
}

/**
 * Check if message is fire event
 */
export function isFireEventMessage(message: EosOSCMessage): boolean {
  return matchesAddress(message.address, '/eos/out/event/cue/*/*/fire');
}

/**
 * Get OSC message type
 */
export type OSCMessageType = 'active' | 'previous' | 'pending' | 'fire' | 'unknown';

export function getMessageType(message: EosOSCMessage): OSCMessageType {
  if (isActiveCueMessage(message)) return 'active';
  if (isPreviousCueMessage(message)) return 'previous';
  if (isPendingCueMessage(message)) return 'pending';
  if (isFireEventMessage(message)) return 'fire';
  return 'unknown';
}
