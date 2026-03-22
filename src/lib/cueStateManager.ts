/**
 * CueStateManager
 * Simplified cue state management without XState complexity
 * Tracks cues through lifecycle: DISCOVERED → ACTIVE → COMPLETING → FINISHED
 */

import { EventEmitter } from 'events';
import {
  CueData,
  CueState,
  CueSource,
  CueProgressEntry,
  CueStateTransition,
  VALID_TRANSITIONS,
} from '../types/cue';
import { CueDataSync } from './cueDataSync';

interface CueTimers {
  staleTimer: NodeJS.Timeout | null;
  completionTimer: NodeJS.Timeout | null;
}

export class CueStateManager extends EventEmitter {
  private cues: Map<string, CueData> = new Map();
  private cueTimers: Map<string, CueTimers> = new Map();
  private dataSync: CueDataSync | null = null;

  // Configuration
  private staleTimeout: number;
  private completionTimeout: number;
  private enableStateLogging: boolean;

  constructor(config: {
    staleTimeout: number;
    completionTimeout: number;
    enableStateLogging?: boolean;
  }) {
    super();
    this.staleTimeout = config.staleTimeout;
    this.completionTimeout = config.completionTimeout;
    this.enableStateLogging = config.enableStateLogging !== false;
  }

  /**
   * Set data sync service
   */
  setDataSync(dataSync: CueDataSync): void {
    this.dataSync = dataSync;
  }

  /**
   * Handle FIRE event
   */
  handleFire(cueList: string, cueNumber: string, fireTimestamp: number): void {
    const cueId = `${cueList}/${cueNumber}`;

    // Handle existing cues when a new cue fires
    for (const [existingCueId, existingCue] of this.cues.entries()) {
      if (existingCueId !== cueId) {
        // Move ACTIVE cues to background
        if (existingCue.state === CueState.ACTIVE) {
          this.transitionToState(existingCue, CueState.BACKGROUND, 'Another cue fired');
          // Schedule cleanup based on estimated completion time
          this.scheduleBackgroundCleanup(existingCue);
        }
        // Cleanup FINISHED cues (old main cue that has completed)
        else if (existingCue.state === CueState.FINISHED) {
          this.cleanupCue(existingCueId);
        }
      }
    }

    // Get or create cue
    let cue = this.cues.get(cueId);

    if (!cue) {
      // Create new cue
      cue = this.createCue(cueId, cueList, cueNumber, CueSource.FIRE);
    }

    // Transition to ACTIVE
    this.transitionToState(cue, CueState.ACTIVE, 'Cue fired');

    // Fetch enhanced data from console if available
    if (this.dataSync) {
      this.enrichCueData(cue);
    }

    // Prefetch next cues
    if (this.dataSync) {
      const cueNumberFloat = parseFloat(cueNumber);
      const cueListInt = parseInt(cueList, 10);
      if (!isNaN(cueNumberFloat) && !isNaN(cueListInt)) {
        this.dataSync.prefetchNextCues(cueListInt, cueNumberFloat);
      }
    }

    // Reset stale timer
    this.resetStaleTimer(cue);

    this.emit('cue-fired', cue);
  }

  /**
   * Handle active cue UPDATE
   */
  handleActiveUpdate(
    cueList: string,
    cueNumber: string,
    label: string,
    time: number | null,
    percentage: string | null,
    raw: string
  ): void {
    const cueId = `${cueList}/${cueNumber}`;
    let cue = this.cues.get(cueId);

    if (!cue) {
      // Create new cue from active update
      cue = this.createCue(cueId, cueList, cueNumber, CueSource.ACTIVE);
    }

    // Update cue data
    cue.label = label;
    cue.time = time;
    cue.percentage = percentage;
    cue.raw = raw;
    cue.lastUpdate = Date.now();

    // Track progress history
    if (percentage) {
      this.addProgressEntry(cue, percentage);
    }

    // Always transition DISCOVERED → ACTIVE when we receive any active-cue
    // update, even without a percentage. The cue is the active cue on the
    // desk and must appear in the overlay. Stale/finish logic handles cleanup.
    if (cue.state === CueState.DISCOVERED || cue.state === CueState.STALE) {
      this.transitionToState(cue, CueState.ACTIVE, 'Received active update');

      // When a new cue becomes active, cleanup old FINISHED cues
      for (const [existingCueId, existingCue] of this.cues.entries()) {
        if (existingCueId !== cue.cueId && existingCue.state === CueState.FINISHED) {
          this.cleanupCue(existingCueId);
        }
      }
    }

    // State transitions based on percentage
    if (percentage) {
      const percentValue = parseInt(percentage.replace('%', ''), 10);

      if (percentValue === 100) {
        // Reached 100%, transition to FINISHED immediately
        if (cue.state === CueState.ACTIVE) {
          this.transitionToState(cue, CueState.FINISHED, 'Reached 100%');
          this.emit('cue-finished', cue);
        } else if (cue.state === CueState.BACKGROUND) {
          // Background cue reached 100%, cleanup immediately
          this.cleanupCue(cue.cueId);
        }
      }
    }

    // Enrich with console data if available
    if (this.dataSync) {
      this.enrichCueData(cue);
    }

    // Only reset the stale timer if percentage is actively changing.
    // - No percentage at all: don't reset (stale timer fires → FINISHED)
    // - Stagnant percentage (same value 3+ times): don't reset (same result)
    // - Changing percentage: reset (cue is genuinely running)
    if (this.isPercentageProgressing(cue, percentage)) {
      this.resetStaleTimer(cue);
    }

    this.emit('cue-updated', cue);
  }

  /**
   * Handle previous cue UPDATE (background cue)
   */
  handlePreviousUpdate(
    cueList: string,
    cueNumber: string,
    label: string,
    time: number | null,
    raw: string
  ): void {
    const cueId = `${cueList}/${cueNumber}`;
    let cue = this.cues.get(cueId);

    if (!cue) {
      // Create new cue from previous update
      cue = this.createCue(cueId, cueList, cueNumber, CueSource.PREVIOUS);
    }

    // Update cue data
    cue.label = label;
    cue.time = time;
    cue.raw = raw;
    cue.lastUpdate = Date.now();

    // Move to BACKGROUND if not already
    if (cue.state === CueState.ACTIVE || cue.state === CueState.COMPLETING) {
      this.transitionToState(cue, CueState.BACKGROUND, 'Moved to previous list');
    }

    // Estimate completion time for background cue
    this.estimateBackgroundCompletion(cue);

    // Schedule cleanup based on estimated completion time
    if (cue.state === CueState.BACKGROUND) {
      this.scheduleBackgroundCleanup(cue);
    }

    // Reset stale timer
    this.resetStaleTimer(cue);

    this.emit('cue-updated', cue);
  }

  /**
   * Get all active cues (for overlay display)
   */
  getActiveCues(): CueData[] {
    const activeCues: CueData[] = [];

    for (const cue of this.cues.values()) {
      if (
        cue.state === CueState.ACTIVE ||
        cue.state === CueState.COMPLETING ||
        cue.state === CueState.BACKGROUND ||
        cue.state === CueState.FINISHED
      ) {
        // Add computed properties for overlay
        cue.isRunning = cue.state === CueState.ACTIVE || cue.state === CueState.COMPLETING;
        cue.isBackgroundRunning = cue.state === CueState.BACKGROUND;
        cue.isStale = false; // Active cues are not stale

        activeCues.push(cue);
      }
    }

    // Sort by state priority and discovery time (most recent first)
    // Priority: ACTIVE/COMPLETING > FINISHED > BACKGROUND
    // Within same priority: most recently discovered first
    activeCues.sort((a, b) => {
      // Define state priority (lower number = higher priority)
      const getPriority = (state: CueState): number => {
        if (state === CueState.ACTIVE || state === CueState.COMPLETING) return 1;
        if (state === CueState.FINISHED) return 2;
        if (state === CueState.BACKGROUND) return 3;
        return 4;
      };

      const priorityA = getPriority(a.state);
      const priorityB = getPriority(b.state);

      // First sort by priority
      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }

      // Within same priority, sort by most recently discovered
      return b.discoveredAt - a.discoveredAt;
    });

    return activeCues;
  }

  /**
   * Get header cue (main display cue)
   */
  getHeaderCue(): CueData | null {
    // Priority: ACTIVE > COMPLETING > BACKGROUND > FINISHED
    const priorities = [
      CueState.ACTIVE,
      CueState.COMPLETING,
      CueState.BACKGROUND,
      CueState.FINISHED,
    ];

    for (const state of priorities) {
      for (const cue of this.cues.values()) {
        if (cue.state === state) {
          return cue;
        }
      }
    }

    return null;
  }

  /**
   * Get all cues
   */
  getAllCues(): CueData[] {
    return Array.from(this.cues.values());
  }

  /**
   * Get cue by ID
   */
  getCue(cueId: string): CueData | null {
    return this.cues.get(cueId) || null;
  }

  /**
   * Get state distribution (for debugging)
   */
  getStateDistribution(): Record<CueState, number> {
    const distribution: Record<CueState, number> = {
      [CueState.DISCOVERED]: 0,
      [CueState.ACTIVE]: 0,
      [CueState.COMPLETING]: 0,
      [CueState.BACKGROUND]: 0,
      [CueState.FINISHED]: 0,
      [CueState.TERMINATED]: 0,
      [CueState.STALE]: 0,
      [CueState.ERROR]: 0,
    };

    for (const cue of this.cues.values()) {
      distribution[cue.state]++;
    }

    return distribution;
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    // Clear all timers
    for (const timers of this.cueTimers.values()) {
      if (timers.staleTimer) clearTimeout(timers.staleTimer);
      if (timers.completionTimer) clearTimeout(timers.completionTimer);
    }

    this.cues.clear();
    this.cueTimers.clear();
    this.removeAllListeners();
  }

  // ===== PRIVATE METHODS =====

  /**
   * Create new cue
   */
  private createCue(cueId: string, cueList: string, cueNumber: string, source: CueSource): CueData {
    const now = Date.now();

    const cue: CueData = {
      cueId,
      cueList,
      cueNumber,
      label: '',
      time: null,
      percentage: null,
      state: CueState.DISCOVERED,
      source,
      discoveredAt: now,
      lastUpdate: now,
      lastStateChange: now,
      progressHistory: [],
      raw: '',
    };

    this.cues.set(cueId, cue);
    this.cueTimers.set(cueId, { staleTimer: null, completionTimer: null });

    if (this.enableStateLogging) {
      console.log(`[CueStateManager] Created cue ${cueId} (source: ${source})`);
    }

    this.emit('cue-created', cue);

    return cue;
  }

  /**
   * Transition cue to new state
   */
  private transitionToState(cue: CueData, newState: CueState, reason: string): boolean {
    const oldState = cue.state;

    // Validate transition
    const validTransitions = VALID_TRANSITIONS[oldState];
    if (!validTransitions.includes(newState)) {
      console.warn(`[CueStateManager] Invalid transition ${cue.cueId}: ${oldState} → ${newState}`);
      return false;
    }

    // Update state
    cue.state = newState;
    cue.lastStateChange = Date.now();

    if (this.enableStateLogging) {
      console.log(`[CueStateManager] ${cue.cueId}: ${oldState} → ${newState} (${reason})`);
    }

    this.emit('state-changed', { cue, oldState, newState, reason });

    return true;
  }

  /**
   * Add progress entry for rate calculation
   */
  private addProgressEntry(cue: CueData, percentage: string): void {
    const entry: CueProgressEntry = {
      percentage,
      timestamp: Date.now(),
    };

    cue.progressHistory.push(entry);

    // Keep only last 10 entries
    if (cue.progressHistory.length > 10) {
      cue.progressHistory = cue.progressHistory.slice(-10);
    }
  }

  /**
   * Estimate completion time for background cue
   */
  private estimateBackgroundCompletion(cue: CueData): void {
    // If we have cached fade time from console, use it (most accurate)
    if (this.dataSync) {
      const cached = this.dataSync.getCachedData(cue.cueId);
      if (cached && cached.fadeTimeMs) {
        cue.estimatedCompletionTime = cached.fadeTimeMs;
        return;
      }
    }

    // Otherwise use time from OSC message
    if (cue.time && cue.time > 0) {
      cue.estimatedCompletionTime = cue.time * 1000; // Convert seconds to ms
      return;
    }

    // Instant cue or no timing info
    cue.estimatedCompletionTime = 0;
  }

  /**
   * Enrich cue data from console cache
   */
  private async enrichCueData(cue: CueData): Promise<void> {
    if (!this.dataSync) return;

    try {
      // Try to get cached data only (don't fetch if not ready)
      const cached = this.dataSync.getCachedData(cue.cueId);

      if (cached) {
        // Enrich label if not set
        if (!cue.label && cached.label) {
          cue.label = cached.label;
        }

        // Update estimated completion time with accurate fade time
        if (cached.fadeTimeMs) {
          cue.estimatedCompletionTime = cached.fadeTimeMs;
        }
      }
      // If not in cache, don't try to fetch - sync will populate cache soon
    } catch (error) {
      // Silently ignore enrichment errors
    }
  }

  /**
   * Reset stale timer for cue
   */
  private resetStaleTimer(cue: CueData): void {
    const timers = this.cueTimers.get(cue.cueId);
    if (!timers) return;

    // Clear existing timer
    if (timers.staleTimer) {
      clearTimeout(timers.staleTimer);
    }

    // Don't set stale timer for BACKGROUND cues - they're managed by completion timer
    if (cue.state === CueState.BACKGROUND) {
      return;
    }

    // Set new timer
    timers.staleTimer = setTimeout(() => {
      this.handleStaleTimeout(cue);
    }, this.staleTimeout);
  }

  /**
   * Handle stale timeout
   */
  private handleStaleTimeout(cue: CueData): void {
    // Only mark as stale if in active states
    if (
      cue.state === CueState.DISCOVERED ||
      cue.state === CueState.ACTIVE ||
      cue.state === CueState.COMPLETING ||
      cue.state === CueState.BACKGROUND
    ) {
      // If the cue never made progress (percentage was static the whole time),
      // it was likely already completed when we first connected. Treat it as
      // FINISHED rather than STALE so the overlay shows it as completed.
      if (!this.cueHadProgressingUpdates(cue)) {
        this.transitionToState(cue, CueState.FINISHED, 'No percentage progress - assumed already complete');
        this.emit('cue-finished', cue);
        return;
      }

      this.transitionToState(cue, CueState.STALE, 'No updates received');
      this.emit('cue-stale', cue);

      // Schedule cleanup after extended stale period
      const timers = this.cueTimers.get(cue.cueId);
      if (timers) {
        timers.staleTimer = setTimeout(() => {
          this.cleanupCue(cue.cueId);
        }, this.staleTimeout * 3); // 3x stale timeout = 6 seconds default
      }
    }
  }

  /**
   * Check if a cue has received progressing (changing) percentage updates.
   * A cue with static/non-advancing percentage was likely already complete
   * when we first connected.
   */
  private cueHadProgressingUpdates(cue: CueData): boolean {
    const history = cue.progressHistory;
    if (history.length < 2) return false;

    const firstPercent = history[0].percentage;
    return history.some(entry => entry.percentage !== firstPercent);
  }

  /**
   * Returns true if the cue's percentage is actively changing (not stagnant).
   * Looks at the last 3 progress entries — if they're all the same, the cue
   * is not progressing and we should let the stale timer run out.
   */
  private isPercentageProgressing(cue: CueData, currentPercentage: string | null): boolean {
    if (!currentPercentage) return false; // No percentage info — don't reset stale timer

    const history = cue.progressHistory;
    if (history.length < 3) return true; // Not enough history yet

    // If the last 3 entries are all the same as the current value, stagnant
    const last3 = history.slice(-3);
    return last3.some(entry => entry.percentage !== currentPercentage);
  }


  /**
   * Schedule cleanup for background cue based on estimated completion time
   */
  private scheduleBackgroundCleanup(cue: CueData): void {
    const timers = this.cueTimers.get(cue.cueId);
    if (!timers) return;

    // Clear existing completion timer
    if (timers.completionTimer) {
      clearTimeout(timers.completionTimer);
    }

    // Calculate remaining time based on percentage and estimated completion time
    let cleanupDelay = this.staleTimeout; // Default fallback

    if (cue.estimatedCompletionTime && cue.percentage) {
      // Parse current percentage
      const percentValue = parseInt(cue.percentage.replace('%', ''), 10);

      if (!isNaN(percentValue) && percentValue < 100) {
        // Calculate how much time remains
        const remainingPercent = 100 - percentValue;
        const remainingTime = (cue.estimatedCompletionTime * remainingPercent) / 100;

        // Use the remaining time, with a minimum of 100ms to avoid immediate cleanup
        cleanupDelay = Math.max(100, remainingTime);
      }
    } else if (cue.estimatedCompletionTime && cue.estimatedCompletionTime > 0) {
      // No percentage info, use full estimated time
      cleanupDelay = cue.estimatedCompletionTime;
    }

    // Schedule cleanup
    timers.completionTimer = setTimeout(() => {
      if (cue.state === CueState.BACKGROUND) {
        this.cleanupCue(cue.cueId);
      }
    }, cleanupDelay);
  }

  /**
   * Cleanup cue (remove from tracking)
   */
  private cleanupCue(cueId: string): void {
    const timers = this.cueTimers.get(cueId);
    if (timers) {
      if (timers.staleTimer) clearTimeout(timers.staleTimer);
      if (timers.completionTimer) clearTimeout(timers.completionTimer);
      this.cueTimers.delete(cueId);
    }

    const cue = this.cues.get(cueId);
    if (cue) {
      this.cues.delete(cueId);

      if (this.enableStateLogging) {
        console.log(`[CueStateManager] Cleaned up cue ${cueId}`);
      }

      this.emit('cue-removed', cue);
    }
  }
}
