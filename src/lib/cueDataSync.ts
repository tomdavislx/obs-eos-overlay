/**
 * CueDataSync
 * Manages cue data caching, synchronization, and prefetching from Eos console
 * Implements three-tier strategy: initial full sync + on-demand fetch + smart prefetch
 */

import { EventEmitter } from 'events';
import { EosConnection } from './eosConnection';
import {
  CueCacheEntry,
  EosConsoleCue,
  SyncOptions,
  SyncStatus,
  PrefetchRequest,
  FetchResult,
} from '../types/eos';

export class CueDataSync extends EventEmitter {
  private static readonly CACHE_TTL_MS = 600_000; // 10 minutes
  private static readonly PREFETCH_COUNT = 2;

  private connection: EosConnection;
  private options: SyncOptions;
  private cache: Map<string, CueCacheEntry> = new Map();
  private syncStatus: SyncStatus = {
    lastSyncAt: null,
    nextSyncAt: null,
    cuesInCache: 0,
    syncInProgress: false,
    lastSyncDuration: null,
    lastSyncCueCount: null,
  };
  private syncInterval: NodeJS.Timeout | null = null;
  private prefetchQueue: PrefetchRequest[] = [];
  private prefetchInProgress: boolean = false;

  constructor(connection: EosConnection, options: SyncOptions) {
    super();
    this.connection = connection;
    this.options = options;
  }

  /**
   * Initialize sync service
   */
  async initialize(cueList: number): Promise<void> {
    await this.initialSync(cueList);

    if (this.options.syncInterval > 0) {
      this.schedulePeriodicSync(cueList);
    }
  }

  /**
   * Perform initial full sync
   */
  async initialSync(cueList: number): Promise<void> {
    if (this.syncStatus.syncInProgress) {
      console.warn('[CueDataSync] Sync already in progress, skipping');
      return;
    }

    console.log(`[CueDataSync] Starting initial sync for cue list ${cueList}...`);

    this.syncStatus.syncInProgress = true;
    const startTime = Date.now();

    try {
      // Fetch all cues from console
      const cues = await this.connection.getCues(cueList);

      // Clear old cache
      this.cache.clear();

      // Populate cache
      for (const cue of cues) {
        const cacheEntry = this.createCacheEntry(cue, cueList, 'initial-sync');
        this.cache.set(cacheEntry.cueId, cacheEntry);
      }

      // Update sync status
      const duration = Date.now() - startTime;
      this.syncStatus.lastSyncAt = Date.now();
      this.syncStatus.lastSyncDuration = duration;
      this.syncStatus.lastSyncCueCount = cues.length;
      this.syncStatus.cuesInCache = this.cache.size;
      this.syncStatus.syncInProgress = false;

      console.log(`[CueDataSync] Initial sync complete: ${cues.length} cues cached in ${duration}ms`);

      this.emit('sync-complete', {
        cueCount: cues.length,
        duration,
      });

    } catch (error) {
      console.error('[CueDataSync] Initial sync failed:', error);
      this.syncStatus.syncInProgress = false;
      this.emit('sync-error', error);
      throw error;
    }
  }

  /**
   * Ensure cue data is available (from cache or fetch)
   */
  async ensureCueData(cueId: string): Promise<CueCacheEntry | null> {
    // Check cache first
    const cached = this.getCachedData(cueId);
    if (cached) {
      // Check if cache entry is still valid (TTL)
      if (this.isCacheValid(cached)) {
        return cached;
      }
    }

    // Parse cueId to extract list and number
    const parsed = this.parseCueId(cueId);
    if (!parsed) {
      console.error(`[CueDataSync] Invalid cue ID format: ${cueId}`);
      return null;
    }

    // Fetch from console (cache miss)
    console.log(`[CueDataSync] Cache miss for ${cueId}, fetching from console...`);

    try {
      const cue = await this.connection.getCue(parsed.cueList, parsed.cueNumber);

      if (!cue) {
        console.warn(`[CueDataSync] Cue ${cueId} not found on console`);
        return null;
      }

      // Create and cache entry
      const cacheEntry = this.createCacheEntry(cue, parsed.cueList, 'on-demand');
      this.cache.set(cacheEntry.cueId, cacheEntry);
      this.syncStatus.cuesInCache = this.cache.size;

      console.log(`[CueDataSync] Cue ${cueId} fetched and cached`);

      this.emit('cue-fetched', { cueId, source: 'on-demand' });

      return cacheEntry;

    } catch (error) {
      console.error(`[CueDataSync] Failed to fetch cue ${cueId}:`, error);
      return null;
    }
  }

  /**
   * Get cached cue data (without fetching)
   */
  getCachedData(cueId: string): CueCacheEntry | null {
    const entry = this.cache.get(cueId);

    if (!entry) {
      return null;
    }

    // Check if cache is still valid
    if (!this.isCacheValid(entry)) {
      return null;
    }

    return entry;
  }

  /**
   * Prefetch next cues (anticipate operator workflow)
   */
  prefetchNextCues(currentCueList: number, currentCueNumber: number): void {
    // Walk the sorted cache to find the next PREFETCH_COUNT cues by position,
    // not by arithmetic — handles non-sequential numbering (gaps, fractional, etc.)
    // Uses raw cache entries (ignoring TTL) to discover cue numbers to warm up.
    const nextCueNumbers = Array.from(this.cache.values())
      .filter(e => e.cueList === currentCueList && e.cueNumber > currentCueNumber)
      .sort((a, b) => a.cueNumber - b.cueNumber)
      .slice(0, CueDataSync.PREFETCH_COUNT)
      .map(e => e.cueNumber);

    if (nextCueNumbers.length === 0) return;

    const request: PrefetchRequest = {
      cueList: currentCueList,
      cueNumbers: nextCueNumbers,
      priority: 'normal',
      requestedAt: Date.now(),
    };

    this.prefetchQueue.push(request);
    this.processPrefetchQueue();
  }

  /**
   * Get sync status
   */
  getSyncStatus(): SyncStatus {
    return { ...this.syncStatus };
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number } {
    return { size: this.cache.size };
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
    this.syncStatus.cuesInCache = 0;
    console.log('[CueDataSync] Cache cleared');
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    this.prefetchQueue = [];
    this.cache.clear();
    this.removeAllListeners();
  }

  // ===== PRIVATE METHODS =====

  /**
   * Create cache entry from console cue data
   */
  private createCacheEntry(
    cue: EosConsoleCue,
    cueList: number,
    source: 'initial-sync' | 'on-demand' | 'prefetch'
  ): CueCacheEntry {
    const cueId = `${cueList}/${cue.targetNumber}`;

    // Determine best fade time to use
    // Priority: upTime > focusTime > colorTime > beamTime
    const fadeTimeMs =
      cue.upTimeDurationMs ||
      cue.focusTimeDurationMs ||
      cue.colorTimeDurationMs ||
      cue.beamTimeDurationMs ||
      null;

    return {
      cueId,
      cueList,
      cueNumber: cue.targetNumber,
      label: cue.label || '',
      fadeTimeMs,
      upTimeMs: cue.upTimeDurationMs || null,
      focusTimeMs: cue.focusTimeDurationMs || null,
      colorTimeMs: cue.colorTimeDurationMs || null,
      beamTimeMs: cue.beamTimeDurationMs || null,
      mark: cue.mark || false,
      block: cue.block || false,
      scene: cue.scene || null,
      sceneEnd: cue.sceneEnd || false,
      notes: cue.notes || null,
      cachedAt: Date.now(),
      fetchedFrom: source,
    };
  }

  /**
   * Resolve effective scene for a cue by walking scene markers in cue order.
   * Scene markers apply to a range until a sceneEnd cue (inclusive) clears it.
   */
  getSceneForCue(cueId: string): string | null {
    const parsed = this.parseCueId(cueId);
    if (!parsed) return null;

    const targetCueNumber = parsed.cueNumber;
    const entries = Array.from(this.cache.values())
      .filter((entry) => this.isCacheValid(entry) && entry.cueList === parsed.cueList)
      .sort((a, b) => a.cueNumber - b.cueNumber);

    let activeScene: string | null = null;

    for (const entry of entries) {
      if (entry.cueNumber > targetCueNumber) {
        break;
      }

      if (entry.scene && entry.scene.trim().length > 0) {
        activeScene = entry.scene.trim();
      }

      // sceneEnd applies after this cue, so this cue still belongs to activeScene.
      if (entry.cueNumber === targetCueNumber) {
        return activeScene;
      }

      if (entry.sceneEnd) {
        activeScene = null;
      }
    }

    return activeScene;
  }

  /**
   * Check if cache entry is still valid (within TTL)
   */
  private isCacheValid(entry: CueCacheEntry): boolean {
    const age = Date.now() - entry.cachedAt;
    return age < CueDataSync.CACHE_TTL_MS;
  }

  /**
   * Parse cue ID string into components
   */
  private parseCueId(cueId: string): { cueList: number; cueNumber: number } | null {
    const parts = cueId.split('/');
    if (parts.length !== 2) {
      return null;
    }

    const cueList = parseInt(parts[0], 10);
    const cueNumber = parseFloat(parts[1]); // Support fractional cues

    if (isNaN(cueList) || isNaN(cueNumber)) {
      return null;
    }

    return { cueList, cueNumber };
  }

  /**
   * Schedule periodic sync
   */
  private schedulePeriodicSync(cueList: number): void {
    console.log(`[CueDataSync] Scheduling periodic sync every ${this.options.syncInterval}ms`);

    this.syncInterval = setInterval(async () => {
      console.log('[CueDataSync] Performing periodic sync...');
      try {
        await this.initialSync(cueList);
      } catch (error) {
        console.error('[CueDataSync] Periodic sync failed:', error);
      }
    }, this.options.syncInterval);

    // Update next sync time
    this.syncStatus.nextSyncAt = Date.now() + this.options.syncInterval;
  }

  /**
   * Process prefetch queue
   */
  private async processPrefetchQueue(): Promise<void> {
    if (this.prefetchInProgress || this.prefetchQueue.length === 0) {
      return;
    }

    this.prefetchInProgress = true;

    while (this.prefetchQueue.length > 0) {
      const request = this.prefetchQueue.shift();
      if (!request) break;

      await this.executePrefetch(request);
    }

    this.prefetchInProgress = false;
  }

  /**
   * Execute prefetch request
   */
  private async executePrefetch(request: PrefetchRequest): Promise<void> {
    console.log(`[CueDataSync] Prefetching cues ${request.cueList}/${request.cueNumbers.join(', ')}`);

    for (const cueNumber of request.cueNumbers) {
      const cueId = `${request.cueList}/${cueNumber}`;

      // Skip if already cached and valid
      const cached = this.getCachedData(cueId);
      if (cached && this.isCacheValid(cached)) {
        continue;
      }

      // Fetch from console
      try {
        const cue = await this.connection.getCue(request.cueList, cueNumber);

        if (cue) {
          const cacheEntry = this.createCacheEntry(cue, request.cueList, 'prefetch');
          this.cache.set(cueId, cacheEntry);
          this.syncStatus.cuesInCache = this.cache.size;

          this.emit('cue-prefetched', { cueId });
        }

      } catch (error) {
        console.error(`[CueDataSync] Prefetch failed for ${cueId}:`, error);
      }
    }
  }

}
