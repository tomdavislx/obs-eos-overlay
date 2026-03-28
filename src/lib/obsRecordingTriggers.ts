/**
 * Parse comma-separated cue numbers from env-style strings.
 */
export function parseCommaSeparatedCueNumbers(value: string | undefined): string[] {
  if (!value || typeof value !== 'string') {
    return [];
  }
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Normalize config arrays: trim entries, drop empties, dedupe while preserving order.
 */
export function normalizeCueNumberList(values: string[] | undefined): string[] {
  if (!values || !Array.isArray(values)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = String(v).trim();
    if (!t || seen.has(t)) {
      continue;
    }
    seen.add(t);
    out.push(t);
  }
  return out;
}

export type RecordingTriggerAction = 'start' | 'stop';

/**
 * If a cue is in both lists, stop wins (safer when recording is on).
 */
export function recordingActionForCue(
  firedCueNumber: string,
  recordStartCueNumbers: string[],
  recordStopCueNumbers: string[]
): RecordingTriggerAction | null {
  const n = firedCueNumber.trim();
  const stopSet = new Set(recordStopCueNumbers);
  const startSet = new Set(recordStartCueNumbers);
  if (stopSet.has(n)) {
    return 'stop';
  }
  if (startSet.has(n)) {
    return 'start';
  }
  return null;
}
