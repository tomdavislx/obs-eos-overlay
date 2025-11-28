const osc = require("osc");
const WebSocket = require("ws");
const { EosConsole } = require("eos-console");

// --- Configuration ---
const OSC_PROTOCOL = process.env.OSC_PROTOCOL || "UDP"; // "UDP" or "TCP" - UDP is standard, TCP requires Third Party OSC on port 3037
const OSC_PORT = parseInt(process.env.OSC_PORT) || (process.env.OSC_PROTOCOL === "TCP" ? 3037 : 8001); // Port for OSC (UDP: 8001, TCP: 3037)
const WEBSOCKET_PORT = parseInt(process.env.WEBSOCKET_PORT) || 8081; // Port for the OBS overlay to connect to
const EOS_CONSOLE_HOST = process.env.EOS_HOST || "10.101.100.101"; // Eos console IP (set EOS_HOST env var to override)
const EOS_CONSOLE_PORT = parseInt(process.env.EOS_PORT) || 3037; // Standard Eos console port (for EosConsole API, separate from TCP OSC)
const CUE_LIST_NUMBER = parseInt(process.env.CUE_LIST) || 1; // Which cue list to track (default: 1)
const SYNC_INTERVAL_MINUTES = parseInt(process.env.SYNC_INTERVAL) || 5; // Periodic sync interval in minutes
const USE_EOS_CONSOLE_API = process.env.USE_EOS_CONSOLE_API !== "false"; // Enable/disable EosConsole API (may conflict with TCP OSC on same port)

// Configuration validation
function validateConfiguration() {
  // Validate OSC protocol
  if (OSC_PROTOCOL !== "UDP" && OSC_PROTOCOL !== "TCP") {
    throw new Error(`Invalid OSC_PROTOCOL: ${OSC_PROTOCOL}. Must be "UDP" or "TCP".`);
  }
  
  // Log all configuration values
  logCueEvent('CONFIG', `Configuration: OSC:${OSC_PROTOCOL}:${OSC_PORT}, WebSocket:${WEBSOCKET_PORT}, Eos:${EOS_CONSOLE_HOST}:${EOS_CONSOLE_PORT}, CueList:${CUE_LIST_NUMBER}, SyncInterval:${SYNC_INTERVAL_MINUTES}min, EosConsole API:${USE_EOS_CONSOLE_API}`);
  
  // Validate all ports in one go
  const ports = { OSC_PORT, WEBSOCKET_PORT };
  if (USE_EOS_CONSOLE_API) {
    ports.EOS_CONSOLE_PORT = EOS_CONSOLE_PORT;
  }
  Object.entries(ports).forEach(([name, port]) => {
    if (port < 1 || port > 65535) {
      throw new Error(`Invalid ${name}: ${port}. Must be between 1-65535.`);
    }
  });
  
  // Warn if TCP OSC and EosConsole API both use port 3037
  if (OSC_PROTOCOL === "TCP" && OSC_PORT === 3037 && USE_EOS_CONSOLE_API && EOS_CONSOLE_PORT === 3037) {
    logCueEvent('CONFIG-WARN', 'TCP OSC and EosConsole API both configured for port 3037 - may conflict. Consider disabling EosConsole API (USE_EOS_CONSOLE_API=false) or using different ports.');
  }
  
  // Validate positive numbers
  const positiveNumbers = { CUE_LIST_NUMBER, SYNC_INTERVAL_MINUTES };
  Object.entries(positiveNumbers).forEach(([name, value]) => {
    if (value < 1) {
      throw new Error(`Invalid ${name}: ${value}. Must be 1 or higher.`);
    }
  });
  
  return { OSC_PROTOCOL, OSC_PORT, WEBSOCKET_PORT, EOS_CONSOLE_HOST, EOS_CONSOLE_PORT, CUE_LIST_NUMBER, SYNC_INTERVAL_MINUTES, USE_EOS_CONSOLE_API };
}

// --- OSC Server Setup ---
let oscPort; // Will be either UDPPort or TCPSocketPort

if (OSC_PROTOCOL === "TCP") {
  // TCP OSC - connects to Eos console for Third Party OSC
  // Note: Eos uses SLIP encoding for TCP OSC, which TCPSocketPort handles automatically
  oscPort = new osc.TCPSocketPort({
    address: EOS_CONSOLE_HOST,
    port: OSC_PORT,
    metadata: true,
  });

  oscPort.on("ready", () => {
    console.log(`✅ Connected to Eos OSC via TCP on ${EOS_CONSOLE_HOST}:${OSC_PORT}`);
    logCueEvent('OSC-TCP', `Connected to Eos TCP OSC at ${EOS_CONSOLE_HOST}:${OSC_PORT}`);
    
    // Subscribe to OSC messages for Third Party OSC integration
    // This enables receiving OSC messages from the console
    try {
      oscPort.send({
        address: "/eos/subscribe",
        args: [{ type: "i", value: 1 }] // 1 = subscribe, 0 = unsubscribe
      });
      logCueEvent('OSC-TCP', 'Subscribed to OSC messages (/eos/subscribe=1)');
      console.log('📡 Subscribed to Eos OSC messages');
      
      // Request version info as initial handshake
      oscPort.send({
        address: "/eos/get/version",
        args: []
      });
      logCueEvent('OSC-TCP', 'Requested Eos version info');
      console.log('📡 Requested Eos version');
    } catch (error) {
      logCueEvent('OSC-TCP-ERROR', `Failed to subscribe: ${error.message}`);
      console.error('❌ Failed to subscribe to OSC:', error);
    }
  });

  oscPort.on("connect", () => {
    console.log(`🔌 TCP socket connected to ${EOS_CONSOLE_HOST}:${OSC_PORT}`);
    logCueEvent('OSC-TCP', `TCP socket connected`);
  });

  oscPort.on("error", (err) => {
    const errorMsg = err.message || err.toString() || String(err);
    console.error("❌ OSC TCP Error:", errorMsg);
    console.error("❌ Full error object:", err);
    logCueEvent('OSC-TCP-ERROR', `Connection error: ${errorMsg}`);
    
    // Provide helpful error messages for common issues
    if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('connection refused')) {
      console.error('💡 Connection refused - Possible causes:');
      console.error('   1. Third Party OSC not enabled on console');
      console.error('   2. "Allow Remotes" not enabled (Setup > Remotes)');
      console.error('   3. Port 3037 not open on console');
      console.error('   4. Firewall blocking connection');
      logCueEvent('OSC-TCP-ERROR', 'Connection refused - check console configuration');
    } else if (errorMsg.includes('ETIMEDOUT') || errorMsg.includes('timeout')) {
      console.error('💡 Connection timeout - Possible causes:');
      console.error('   1. Console not reachable at ' + EOS_CONSOLE_HOST);
      console.error('   2. Network connectivity issues');
      logCueEvent('OSC-TCP-ERROR', 'Connection timeout - check network');
    }
  });

  oscPort.on("close", () => {
    console.log("🔌 OSC TCP connection closed");
    logCueEvent('OSC-TCP', 'TCP connection closed');
  });

  oscPort.on("raw", (data) => {
    console.log(`📦 Received ${data.length} bytes of raw OSC data`);
  });

  // Add listener for any socket events (these may fire before 'ready')
  if (oscPort.socket) {
    oscPort.socket.on('connect', () => {
      console.log('🔌 Socket connected event fired');
      logCueEvent('OSC-TCP', 'Socket connected event');
    });
    oscPort.socket.on('error', (err) => {
      const errorMsg = err.message || err.toString() || String(err);
      console.error('❌ Socket error:', errorMsg);
      logCueEvent('OSC-TCP-ERROR', `Socket error: ${errorMsg}`);
    });
    oscPort.socket.on('close', () => {
      console.log('🔌 Socket closed');
      logCueEvent('OSC-TCP', 'Socket closed');
    });
  }
} else {
  // UDP OSC - listens for messages from Eos console
  oscPort = new osc.UDPPort({
    localAddress: "0.0.0.0",
    localPort: OSC_PORT,
    metadata: true,
  });

  oscPort.on("ready", () => {
    console.log(`Listening for Eos OSC on UDP port ${OSC_PORT}`);
    logCueEvent('OSC-UDP', `Listening on UDP port ${OSC_PORT}`);
  });

  oscPort.on("error", (err) => {
    console.error("OSC UDP Error:", err);
    logCueEvent('OSC-UDP-ERROR', `UDP error: ${err.message}`);
  });
}

// --- WebSocket Server Setup ---
const wss = new WebSocket.Server({ port: WEBSOCKET_PORT });

wss.on("listening", () => {
  console.log(`WebSocket server started on port ${WEBSOCKET_PORT}`);
});

wss.on("connection", (ws) => {
  console.log("OBS overlay connected.");
  ws.on("close", () => console.log("OBS overlay disconnected."));
});

// --- Cue Tracking State Machine ---

// Cue states define the lifecycle of a cue from discovery to completion
const CueState = {
  DISCOVERED: 'DISCOVERED',     // Cue first seen but not validated
  ACTIVE: 'ACTIVE',             // Cue is running and progressing (0-99%)
  COMPLETING: 'COMPLETING',     // Cue has reached 100% but may still be transitioning
  BACKGROUND: 'BACKGROUND',     // Cue moved to previous list, running in background
  FINISHED: 'FINISHED',         // Cue completed normally
  TERMINATED: 'TERMINATED',     // Cue stopped by another cue firing
  STALE: 'STALE',              // Cue hasn't received updates and may be orphaned
  ERROR: 'ERROR'               // Cue in error state due to parsing/validation issues
};

// Valid state transitions to prevent invalid state changes
const VALID_TRANSITIONS = {
  [CueState.DISCOVERED]: [CueState.ACTIVE, CueState.ERROR, CueState.STALE],
  [CueState.ACTIVE]: [CueState.COMPLETING, CueState.BACKGROUND, CueState.TERMINATED, CueState.STALE],
  [CueState.COMPLETING]: [CueState.FINISHED, CueState.BACKGROUND, CueState.TERMINATED, CueState.STALE], // Allow COMPLETING -> STALE
  [CueState.BACKGROUND]: [CueState.FINISHED, CueState.TERMINATED, CueState.STALE],
  [CueState.FINISHED]: [CueState.ACTIVE], // Can be reactivated by FIRE events
  [CueState.TERMINATED]: [], // Terminal state - gets cleaned up directly
  [CueState.STALE]: [CueState.ACTIVE, CueState.ERROR, CueState.FINISHED], // Can recover from stale or be cleaned up
  [CueState.ERROR]: [CueState.DISCOVERED, CueState.STALE] // Can recover from error
};

// Cue tracking with robust state management
class CueTracker {
  constructor() {
    this.cues = new Map(); // cueId -> CueData
    this.stateHistory = new Map(); // cueId -> Array of state transitions
    this.lastHeaderCue = null;
    this.lastFiredCue = null;
    this.messageBuffer = [];
    this.STALE_TIMEOUT = 2000; // 2 seconds without updates = stale cue
    this.MAX_HISTORY_LENGTH = 50; // Limit state history per cue
  }

  // Validate and perform state transitions
  transitionCueState(cueId, newState, reason = '') {
    const cue = this.cues.get(cueId);
    if (!cue) {
      console.error(`[STATE] Cannot transition unknown cue ${cueId} to ${newState}`);
      return false;
    }

    const currentState = cue.state;
    const validTransitions = VALID_TRANSITIONS[currentState] || [];
    
    if (!validTransitions.includes(newState)) {
      console.error(`[STATE] Invalid transition for ${cueId}: ${currentState} -> ${newState}. Valid: [${validTransitions.join(', ')}]`);
      return false;
    }

    // Record state change
    const timestamp = Date.now();
    const transition = {
      from: currentState,
      to: newState,
      timestamp,
      reason
    };

    // Update cue state
    cue.state = newState;
    cue.lastStateChange = timestamp;
    cue.lastUpdate = timestamp;

    // Add to state history
    if (!this.stateHistory.has(cueId)) {
      this.stateHistory.set(cueId, []);
    }
    const history = this.stateHistory.get(cueId);
    history.push(transition);
    
    // Limit history length
    if (history.length > this.MAX_HISTORY_LENGTH) {
      history.shift();
    }

    logCueEvent('STATE', `${currentState} -> ${newState} (${reason})`, cueId);
    return true;
  }

  // Create or update a cue with proper state management
  updateCue(cueId, cueData, source = 'unknown') {
    const now = Date.now();
    const existingCue = this.cues.get(cueId);
    
    // Try to enhance cueData with stored information from CueListManager
    const storedCueInfo = cueListManager.getCueInfo(cueId);
    if (storedCueInfo) {
      // Merge stored data with live OSC data, prioritizing live data where available
      cueData = {
        ...storedCueInfo,
        ...cueData, // Live OSC data takes priority
        // Ensure stored fade time is available for calculations
        storedFadeTime: storedCueInfo.fadeTime,
        storedLabel: storedCueInfo.label,
        hasStoredData: true
      };
      
      logCueEvent('CUE-ENHANCE', `Enhanced ${cueId} with stored cue data (fade: ${storedCueInfo.fadeTime}s)`, cueId);
    } else {
      cueData = {
        ...cueData,
        hasStoredData: false
      };
    }
    
    if (!existingCue) {
      // New cue discovery
      const newCue = {
        ...cueData,
        cueId,
        state: CueState.DISCOVERED,
        discoveredAt: now,
        lastUpdate: now,
        lastStateChange: now,
        progressHistory: [], // Track percentage changes for rate calculation
        source
      };
      
      this.cues.set(cueId, newCue);
      this.stateHistory.set(cueId, [{
        from: null,
        to: CueState.DISCOVERED,
        timestamp: now,
        reason: `Discovered from ${source}`
      }]);
      
      logCueEvent('STATE', `NEW -> DISCOVERED (from ${source})`, cueId, cueData.raw || '');
      
      // Immediately try to transition to ACTIVE if cue is valid and not at 100%
      if (cueData.percentage && cueData.percentage !== '100%') {
        this.transitionCueState(cueId, CueState.ACTIVE, 'Valid active cue with progress');
      }
      
      return newCue;
    } else {
      // Update existing cue
      const updatedCue = {
        ...existingCue,
        ...cueData,
        lastUpdate: now,
        source
      };
      
      // Track progress history for rate calculation
      if (cueData.percentage && cueData.percentage !== existingCue.percentage) {
        updatedCue.progressHistory = updatedCue.progressHistory || [];
        updatedCue.progressHistory.push({
          percentage: cueData.percentage,
          timestamp: now
        });
        
        // Keep only recent progress history (last 10 updates)
        if (updatedCue.progressHistory.length > 10) {
          updatedCue.progressHistory.shift();
        }
      }
      
      this.cues.set(cueId, updatedCue);
      
      // Handle state transitions based on updates
      this.evaluateStateTransition(cueId, updatedCue, source);
      
      return updatedCue;
    }
  }


  // Clean up finished cues while preserving them for header display
  cleanupFinishedCue(cueId) {
    const cue = this.cues.get(cueId);
    if (cue && (cue.state === CueState.FINISHED || cue.state === CueState.TERMINATED)) {
      // Save as last header cue if it's recent enough OR if it was fired more recently
      const wasRecentlyFired = cue.raw && (cue.raw.startsWith('FIRE:') || cue.raw.startsWith('FIRE-COMPLETED:'));
      const isMostRecentFire = this.lastFiredCue && this.lastFiredCue.cueId === cueId;
      const wasFromPrevious = cue.source === 'previous';
      
      // Only update header cue if:
      // - It was fired (not just from PREVIOUS messages)
      // - Or it was more recently updated than current header and actually ran (had ACTIVE state)
      const hadActiveState = cue.progressHistory && cue.progressHistory.length > 0;
      
      if (!wasFromPrevious && (!this.lastHeaderCue || 
          cue.lastUpdate > this.lastHeaderCue.lastUpdate ||
          wasRecentlyFired || 
          isMostRecentFire ||
          hadActiveState)) {
        this.lastHeaderCue = { ...cue };
        logCueEvent('STATE', `Updated header cue to ${cueId}`, cueId);
      } else if (wasFromPrevious) {
        logCueEvent('STATE', `Skipped header update - cue was from PREVIOUS only`, cueId);
      }
      
      // Remove from active tracking
      this.cues.delete(cueId);
      // Keep state history for debugging
      setTimeout(() => {
        this.stateHistory.delete(cueId);
      }, 30000); // Clean up history after 30 seconds
      
      logCueEvent('STATE', `Cleaned up ${cue.state} cue`, cueId);
    }
  }

  // Check for stale cues and handle termination
  performMaintenance() {
    const now = Date.now();
    const EXTENDED_STALE_TIMEOUT = this.STALE_TIMEOUT * 3; // 6 seconds for final cleanup
    
    for (const [cueId, cue] of this.cues) {
      // Check for stale cues (skip terminal states and give background cues more time)
      const staleTimeout = cue.state === CueState.BACKGROUND ? this.STALE_TIMEOUT * 3 : this.STALE_TIMEOUT;
      if (now - cue.lastUpdate > staleTimeout && 
          cue.state !== CueState.STALE && 
          cue.state !== CueState.FINISHED && 
          cue.state !== CueState.TERMINATED) {
        const reason = cue.state === CueState.BACKGROUND ? 'Background cue no updates received' : 'No updates received';
        this.transitionCueState(cueId, CueState.STALE, reason);
      }
      
      // Clean up cues that have been stale for too long
      if (cue.state === CueState.STALE && now - cue.lastUpdate > EXTENDED_STALE_TIMEOUT) {
        logCueEvent('CLEANUP', `Removing long-term stale cue`, cueId);
        this.transitionCueState(cueId, CueState.FINISHED, 'Long-term stale cleanup');
        this.cleanupFinishedCue(cueId);
        continue;
      }
      
      // Auto-finish completing cues that have been stuck too long
      if (cue.state === CueState.COMPLETING && now - cue.lastUpdate > this.STALE_TIMEOUT) {
        logCueEvent('CLEANUP', `Auto-finishing stuck completing cue`, cueId);
        this.transitionCueState(cueId, CueState.FINISHED, 'Auto-finish stuck completing cue');
        this.cleanupFinishedCue(cueId);
        continue;
      }
      
      // Clean up old terminated cues  
      if (cue.state === CueState.TERMINATED && now - cue.lastUpdate > EXTENDED_STALE_TIMEOUT) {
        logCueEvent('CLEANUP', `Removing old terminated cue`, cueId);
        this.cleanupFinishedCue(cueId);
        continue;
      }
      
      // Note: Cue interruption by FIRE events is now handled in the FIRE event handler
      // This ensures proper ACTIVE -> BACKGROUND transitions instead of termination
    }
  }

  // Get current active cues sorted by recency
  getActiveCues() {
    const activeCues = Array.from(this.cues.values())
      .filter(cue => [CueState.ACTIVE, CueState.COMPLETING, CueState.BACKGROUND].includes(cue.state))
      .sort((a, b) => b.lastUpdate - a.lastUpdate);
    
    return activeCues;
  }

  // Get the best cue for header display
  getHeaderCue() {
    const activeCues = this.getActiveCues();
    
    if (activeCues.length === 0) {
      return this.lastHeaderCue;
    }
    
    // Find the most recent ACTIVE cue (highest cue number/most recently fired)
    const activeCue = activeCues
      .filter(cue => cue.state === CueState.ACTIVE)
      .sort((a, b) => {
        // Sort by cue number (descending) to get most recent
        const aNum = parseFloat(a.cueId.split('/')[1]) || 0;
        const bNum = parseFloat(b.cueId.split('/')[1]) || 0;
        return bNum - aNum;
      })[0];
    
    if (activeCue) {
      this.lastHeaderCue = { ...activeCue };
      return activeCue;
    }
    
    // If no ACTIVE cues, find the most recent COMPLETING cue
    const completingCue = activeCues
      .filter(cue => cue.state === CueState.COMPLETING)
      .sort((a, b) => {
        const aNum = parseFloat(a.cueId.split('/')[1]) || 0;
        const bNum = parseFloat(b.cueId.split('/')[1]) || 0;
        return bNum - aNum;
      })[0];
    
    if (completingCue) {
      this.lastHeaderCue = { ...completingCue };
      return completingCue;
    }
    
    // If no ACTIVE or COMPLETING, use the most recent BACKGROUND cue
    const backgroundCue = activeCues
      .filter(cue => cue.state === CueState.BACKGROUND)
      .sort((a, b) => {
        const aNum = parseFloat(a.cueId.split('/')[1]) || 0;
        const bNum = parseFloat(b.cueId.split('/')[1]) || 0;
        return bNum - aNum;
      })[0];
    
    if (backgroundCue) {
      this.lastHeaderCue = { ...backgroundCue };
      return backgroundCue;
    }
    
    // Fallback to existing header cue
    return this.lastHeaderCue;
  }

  // Calculate estimated completion time based on progress rate and stored fade times
  estimateCompletionTime(cueId) {
    const cue = this.cues.get(cueId);
    if (!cue) return null;

    // First, try to use stored fade time for more accurate calculation
    if (cue.hasStoredData && cue.storedFadeTime > 0) {
      const currentPercentage = parseInt(cue.percentage) || 0;
      const elapsedSinceDiscovered = Date.now() - cue.discoveredAt;
      const totalFadeTimeMs = cue.storedFadeTime * 1000;
      
      // Calculate remaining time based on stored fade time
      const estimatedRemainingTime = totalFadeTimeMs - elapsedSinceDiscovered;
      
      if (estimatedRemainingTime > 0) {
        logCueEvent('DURATION-CALC', `Using stored fade time: ${cue.storedFadeTime}s, remaining: ${Math.round(estimatedRemainingTime/1000)}s`, cueId);
        return Math.max(0, Math.round(estimatedRemainingTime));
      }
    }

    // Fallback to percentage-based calculation if no stored data or stored calculation is invalid
    if (!cue.progressHistory || cue.progressHistory.length < 2) {
      return null;
    }
    
    // Get recent progress history
    const history = cue.progressHistory.slice(-5); // Use last 5 updates
    if (history.length < 2) return null;
    
    // Calculate progress rate (percentage per millisecond)
    const timeSpan = history[history.length - 1].timestamp - history[0].timestamp;
    const startPercent = parseInt(history[0].percentage);
    const endPercent = parseInt(history[history.length - 1].percentage);
    const percentageChange = endPercent - startPercent;
    
    if (timeSpan <= 0 || percentageChange <= 0) return null;
    
    const percentagePerMs = percentageChange / timeSpan;
    const remainingPercentage = 100 - endPercent;
    
    if (remainingPercentage <= 0) return 0; // Already complete
    
    const estimatedRemainingTime = remainingPercentage / percentagePerMs;
    logCueEvent('DURATION-CALC', `Using percentage-based calc, remaining: ${Math.round(estimatedRemainingTime/1000)}s`, cueId);
    return Math.max(0, Math.round(estimatedRemainingTime));
  }

  // Predict when background cues will complete and schedule cleanup
  scheduleBackgroundCueCompletion(cueId) {
    const cue = this.cues.get(cueId);
    if (!cue || cue.state !== CueState.BACKGROUND) return;
    
    // Try estimation with enhanced methods (stored fade time + percentage)
    let estimatedTime = this.estimateCompletionTime(cueId);
    
    // Fallback to OSC-parsed time-based calculation if estimation fails
    if (estimatedTime === null && cue.time && cue.time > 0) {
      const elapsedSinceDiscovered = Date.now() - cue.discoveredAt;
      const totalTime = cue.time * 1000;
      estimatedTime = Math.max(0, totalTime - elapsedSinceDiscovered);
      logCueEvent('BACKGROUND', `Using OSC-parsed time: ${estimatedTime}ms remaining`, cueId);
    }
    
    if (estimatedTime !== null && estimatedTime >= 0) {
      const calculationType = cue.hasStoredData && cue.storedFadeTime > 0 ? 'stored fade time' : 'percentage/OSC calculation';
      logCueEvent('BACKGROUND', `Estimated completion in ${Math.round(estimatedTime/1000)}s using ${calculationType}`, cueId);
      
      setTimeout(() => {
        if (this.cues.has(cueId) && this.cues.get(cueId).state === CueState.BACKGROUND) {
          this.transitionCueState(cueId, CueState.FINISHED, 'Estimated completion time reached');
          this.cleanupFinishedCue(cueId);
        }
      }, estimatedTime);
    } else {
      logCueEvent('BACKGROUND', `Could not estimate completion time, relying on Eos updates`, cueId);
    }
  }

  // Enhanced state transition evaluation with background cue scheduling
  evaluateStateTransition(cueId, cue, source) {
    const currentState = cue.state;
    
    switch (currentState) {
      case CueState.DISCOVERED:
        if (cue.percentage && cue.percentage !== '100%') {
          this.transitionCueState(cueId, CueState.ACTIVE, `Valid progress data from ${source}`);
        }
        break;
        
      case CueState.ACTIVE:
        if (cue.percentage === '100%') {
          this.transitionCueState(cueId, CueState.COMPLETING, 'Reached 100% completion');
        } else if (source === 'previous') {
          this.transitionCueState(cueId, CueState.BACKGROUND, 'Moved to previous list');
          // Schedule completion prediction for background cues
          this.scheduleBackgroundCueCompletion(cueId);
        }
        break;
        
      case CueState.COMPLETING:
        if (source === 'previous') {
          this.transitionCueState(cueId, CueState.BACKGROUND, 'Moved to previous while completing');
          this.scheduleBackgroundCueCompletion(cueId);
        } else {
          // Auto-transition to finished after brief delay
          setTimeout(() => {
            if (this.cues.has(cueId) && this.cues.get(cueId).state === CueState.COMPLETING) {
              this.transitionCueState(cueId, CueState.FINISHED, 'Completion timeout');
              this.cleanupFinishedCue(cueId);
            }
          }, 500);
        }
        break;
        
      case CueState.BACKGROUND:
        // Update progress tracking for better estimation
        if (cue.percentage && source === 'previous') {
          // Background cues can still receive updates, recalculate if needed
          this.scheduleBackgroundCueCompletion(cueId);
        }
        break;
    }
  }

  // Get debug information about current state
  getDebugInfo() {
    const cueCount = this.cues.size;
    const stateDistribution = {};
    
    for (const cue of this.cues.values()) {
      stateDistribution[cue.state] = (stateDistribution[cue.state] || 0) + 1;
    }
    
    return {
      cueCount,
      stateDistribution,
      totalHistoryEntries: Array.from(this.stateHistory.values()).reduce((sum, history) => sum + history.length, 0)
    };
  }
}

// --- Cue List Management with Eos Console Connection ---
class CueListManager {
  constructor() {
    this.eosConsole = null;
    this.cueListData = new Map(); // cueId -> { label, fadeTime, notes, etc. }
    this.isConnected = false;
    this.connectionAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 5000; // 5 seconds
    this.connectionTimeout = null;
  }

  async connect() {
    try {
      logCueEvent('EOS-CONSOLE', `Attempting to connect to Eos console at ${EOS_CONSOLE_HOST}:${EOS_CONSOLE_PORT}`);
      
      this.eosConsole = new EosConsole({
        host: EOS_CONSOLE_HOST,
        port: EOS_CONSOLE_PORT
      });

      // Set up event listeners
      this.setupEventListeners();

      // Connect to the console
      await this.eosConsole.connect();
      
      this.isConnected = true;
      this.connectionAttempts = 0;
      logCueEvent('EOS-CONSOLE', 'Successfully connected to Eos console');

      // Initial cue list sync
      await this.syncCueList(CUE_LIST_NUMBER);

    } catch (error) {
      this.isConnected = false;
      this.connectionAttempts++;
      logCueEvent('EOS-CONSOLE-ERROR', `Connection failed (attempt ${this.connectionAttempts}): ${error.message}`);
      
      // Schedule reconnection if we haven't exceeded max attempts
      if (this.connectionAttempts < this.maxReconnectAttempts) {
        logCueEvent('EOS-CONSOLE', `Scheduling reconnection in ${this.reconnectDelay / 1000} seconds`);
        this.connectionTimeout = setTimeout(() => {
          this.connect();
        }, this.reconnectDelay);
      } else {
        logCueEvent('EOS-CONSOLE-ERROR', 'Max reconnection attempts reached. Operating in OSC-only mode.');
      }
    }
  }

  setupEventListeners() {
    if (!this.eosConsole) return;

    // Listen for console events
    this.eosConsole.on('disconnect', () => {
      logCueEvent('EOS-CONSOLE', 'Disconnected from Eos console');
      this.isConnected = false;
      
      // Attempt to reconnect
      setTimeout(() => {
        this.connect();
      }, this.reconnectDelay);
    });

    this.eosConsole.on('error', (error) => {
      logCueEvent('EOS-CONSOLE-ERROR', `Console error: ${error.message}`);
    });

    // Listen for cue events if available
    this.eosConsole.on('active-cue', (data) => {
      logCueEvent('EOS-CONSOLE', `Active cue event received: ${JSON.stringify(data)}`);
    });
  }

  async syncCueList(cueListNumber = 1) {
    if (!this.isConnected || !this.eosConsole) {
      logCueEvent('EOS-CONSOLE-WARN', 'Cannot sync cue list - not connected to console');
      return false;
    }

    try {
      logCueEvent('EOS-CONSOLE', `Syncing cue list ${cueListNumber}`);
      
      // Note: eos-console uses getCues(cueListNumber) method to retrieve all cues
      
      // Try different API approaches
      let cueList;
      let syncedCount = 0;
      
      // Use the getCues() method which we know works
      if (typeof this.eosConsole.getCues === 'function') {
        try {
          const allCues = await this.eosConsole.getCues(cueListNumber);
          
          if (Array.isArray(allCues)) {
            for (const cue of allCues) {
              // Filter cues that belong to our target cue list
              if (cue.targetType === 'cue') {
                const cueId = `${cueListNumber}/${cue.targetNumber}`;
                
                // Extract fade time - prioritize upTimeDurationMs, then focusTimeDurationMs
                const fadeTimeMs = cue.upTimeDurationMs || cue.focusTimeDurationMs || cue.colorTimeDurationMs || cue.beamTimeDurationMs || 0;
                const fadeTimeSeconds = fadeTimeMs / 1000;
                
                const cueData = {
                  cueList: cueListNumber,
                  cueNumber: cue.targetNumber,
                  label: cue.label || `Cue ${cue.targetNumber}`,
                  fadeTime: fadeTimeSeconds,
                  notes: cue.notes || '',
                  upTime: cue.upTimeDurationMs / 1000,
                  focusTime: cue.focusTimeDurationMs ? cue.focusTimeDurationMs / 1000 : null,
                  colorTime: cue.colorTimeDurationMs ? cue.colorTimeDurationMs / 1000 : null,
                  beamTime: cue.beamTimeDurationMs ? cue.beamTimeDurationMs / 1000 : null,
                  followTime: cue.followTimeMs ? cue.followTimeMs / 1000 : null,
                  mark: cue.mark || '',
                  block: cue.block || '',
                  scene: cue.scene || '',
                  syncedAt: Date.now()
                };
                
                this.cueListData.set(cueId, cueData);
                syncedCount++;
              }
            }
          } else {
            logCueEvent('EOS-CONSOLE-WARN', `getCues returned non-array result: ${typeof allCues}`);
          }
        } catch (error) {
          logCueEvent('EOS-CONSOLE-ERROR', `getCues method failed: ${error.message}`);
        }
      } else {
        logCueEvent('EOS-CONSOLE-WARN', 'getCues method not available');
      }

      if (syncedCount > 0) {
        logCueEvent('EOS-CONSOLE', `Synced ${syncedCount} cues from cue list ${cueListNumber}`);
        return true;
      } else {
        logCueEvent('EOS-CONSOLE-WARN', `No cues found for cue list ${cueListNumber} - API might need different approach`);
        return false;
      }

    } catch (error) {
      logCueEvent('EOS-CONSOLE-ERROR', `Failed to sync cue list ${cueListNumber}: ${error.message}`);
      return false;
    }
  }

  // Get stored cue information by cueId
  getCueInfo(cueId) {
    return this.cueListData.get(cueId) || null;
  }

  // Get fade time for a specific cue
  getCueFadeTime(cueId) {
    const cueInfo = this.getCueInfo(cueId);
    return cueInfo ? cueInfo.fadeTime : null;
  }

  // Get label for a specific cue
  getCueLabel(cueId) {
    const cueInfo = this.getCueInfo(cueId);
    return cueInfo ? cueInfo.label : null;
  }

  // Check if we have information for a specific cue
  hasCueInfo(cueId) {
    return this.cueListData.has(cueId);
  }

  // Get all stored cue information
  getAllCues() {
    return Array.from(this.cueListData.values());
  }

  // Manually refresh a specific cue's information
  async refreshCue(cueList, cueNumber) {
    if (!this.isConnected || !this.eosConsole) {
      return null;
    }

    try {
      // Use getCues to get all cues, then find the specific one we need
      if (typeof this.eosConsole.getCues === 'function') {
        const allCues = await this.eosConsole.getCues(cueList);
        
        if (Array.isArray(allCues)) {
          // Find the specific cue by targetNumber
          const cue = allCues.find(c => c.targetType === 'cue' && c.targetNumber === cueNumber);
          
          if (cue) {
            const cueId = `${cueList}/${cueNumber}`;
            const fadeTimeMs = cue.upTimeDurationMs || cue.focusTimeDurationMs || cue.colorTimeDurationMs || cue.beamTimeDurationMs || 0;
            const fadeTimeSeconds = fadeTimeMs / 1000;
            
            const cueData = {
              cueList: cueList,
              cueNumber: cueNumber,
              label: cue.label || `Cue ${cueNumber}`,
              fadeTime: fadeTimeSeconds,
              notes: cue.notes || '',
              upTime: cue.upTimeDurationMs / 1000,
              focusTime: cue.focusTimeDurationMs ? cue.focusTimeDurationMs / 1000 : null,
              colorTime: cue.colorTimeDurationMs ? cue.colorTimeDurationMs / 1000 : null,
              beamTime: cue.beamTimeDurationMs ? cue.beamTimeDurationMs / 1000 : null,
              followTime: cue.followTimeMs ? cue.followTimeMs / 1000 : null,
              mark: cue.mark || '',
              block: cue.block || '',
              scene: cue.scene || '',
              syncedAt: Date.now()
            };
            
            this.cueListData.set(cueId, cueData);
            logCueEvent('EOS-CONSOLE', `Refreshed cue data for ${cueId}: "${cueData.label}" (${cueData.fadeTime}s)`);
            return cueData;
          } else {
            logCueEvent('EOS-CONSOLE-WARN', `Cue ${cueList}/${cueNumber} not found in console data`);
          }
        }
      }
    } catch (error) {
      logCueEvent('EOS-CONSOLE-ERROR', `Failed to refresh cue ${cueList}/${cueNumber}: ${error.message}`);
    }
    
    return null;
  }

  // Cleanup and disconnect
  async disconnect() {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }

    if (this.eosConsole && this.isConnected) {
      try {
        await this.eosConsole.disconnect();
        logCueEvent('EOS-CONSOLE', 'Disconnected from Eos console');
      } catch (error) {
        logCueEvent('EOS-CONSOLE-ERROR', `Error during disconnect: ${error.message}`);
      }
    }

    this.isConnected = false;
    this.eosConsole = null;
  }

  // Get connection status and debug info
  getStatus() {
    return {
      connected: this.isConnected,
      cueCount: this.cueListData.size,
      connectionAttempts: this.connectionAttempts,
      host: EOS_CONSOLE_HOST,
      port: EOS_CONSOLE_PORT
    };
  }
}

// Initialize the cue tracker and cue list manager
const cueTracker = new CueTracker();
const cueListManager = new CueListManager();

// Track last broadcast state to avoid duplicate logging
let lastBroadcastState = {
  cueCount: 0,
  stateDistribution: {},
  activeCueIds: '',
  headerCueId: 'none'
};

// These legacy variables are now handled by CueTracker - removed for cleanup

// --- Robust Parsing Functions ---

// Shared time parsing function for consistent handling across active and previous cues
function parseTimeString(timeString) {
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
function parseActiveCue(fullCueText) {
  // Expected format: [CUE_LIST]/[CUE_NUMBER] [CUE_LABEL] [CUE_TIME] [CUE_PERCENTAGE]
  // Strategy: Work backwards from the end to avoid label interference
  
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
  const label = cueMatch[3];
  
  // Validate that label doesn't end with what looks like time/percentage
  // This catches cases like "Scene 12.5" where 12.5 might be confused for time
  const labelEndsWithNumber = /\d+(?:\.\d+)?$/.test(label.trim());
  const labelContainsPercent = /%/.test(label);
  
  if (labelEndsWithNumber || labelContainsPercent) {
    logCueEvent('PARSE-WARN', `Label "${label}" contains potentially confusing characters`);
  }
  
  return {
    cueList,
    cueNumber,
    label: label.trim(), // Clean up any extra whitespace
    time: time, // Already parsed as number above
    percentage,
    raw: fullCueText
  };
}

function parsePreviousCue(fullCueText) {
  // Expected format: [CUE_LIST]/[CUE_NUMBER] [CUE_LABEL] [CUE_TIME]
  // Strategy: Work backwards from the end to avoid label interference
  
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
  const label = cueMatch[3];
  
  // Validate that label doesn't end with what looks like time
  const labelEndsWithNumber = /\d+(?:\.\d+)?$/.test(label.trim());
  
  if (labelEndsWithNumber) {
    logCueEvent('PARSE-WARN', `Previous cue label "${label}" ends with number that might be confused for time`);
  }
  
  return {
    cueList,
    cueNumber,
    label: label.trim(), // Clean up any extra whitespace
    time: time, // Already parsed as number above
    raw: fullCueText
  };
}

// --- Debug Utilities ---
function getTimestamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function logCueEvent(level, message, cueId = '', rawData = '') {
  const timestamp = getTimestamp();
  const cueInfo = cueId ? ` [${cueId}]` : '';
  console.log(`[${timestamp}] [${level}]${cueInfo} ${message}`);
  if (rawData) {
    console.log(`[${timestamp}] [RAW]${cueInfo} "${rawData}"`);
  }
}

// --- OSC Message Validation ---
function validateOSCMessage(oscMsg) {
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

function validateCueData(cueData, source) {
  const errors = [];
  
  if (!cueData.cueList || !cueData.cueNumber) {
    errors.push('Missing cue list or number');
  }
  
  if (!cueData.label || typeof cueData.label !== 'string') {
    errors.push('Invalid or missing cue label');
  }
  
  if (source === 'active') {
    if (!cueData.percentage || !cueData.percentage.match(/^\d+%$/)) {
      errors.push('Invalid or missing percentage for active cue');
    }
    
    if (typeof cueData.time !== 'number' || cueData.time < 0) {
      errors.push('Invalid or missing time for active cue');
    }
  }
  
  if (source === 'previous') {
    if (typeof cueData.time !== 'number' || cueData.time < 0) {
      errors.push('Invalid or missing time for previous cue');
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

// --- Bridge Logic ---
oscPort.on("message", (oscMsg) => {
  // Log all OSC messages when using TCP for debugging
  if (OSC_PROTOCOL === "TCP" && oscMsg && oscMsg.address) {
    const args = oscMsg.args ? oscMsg.args.map(arg => {
      if (typeof arg.value !== 'undefined') return arg.value;
      return arg;
    }).join(', ') : 'no args';
    logCueEvent('OSC-RAW', `${oscMsg.address} -> [${args}]`);
  }
  
  // Log relevant OSC messages for debugging (UDP)
  if (OSC_PROTOCOL === "UDP" && oscMsg && oscMsg.address && (oscMsg.address.includes('/cue/text') || oscMsg.address.includes('/fire'))) {
    const args = oscMsg.args ? oscMsg.args.map(arg => arg.value).join(', ') : '';
    logCueEvent('OSC-RAW', `${oscMsg.address} -> [${args}]`);
  }
  
  // Handle OSC Get responses (version info, etc.)
  if (oscMsg && oscMsg.address === "/eos/out/get/version") {
    const version = oscMsg.args && oscMsg.args[0] ? oscMsg.args[0].value : 'unknown';
    logCueEvent('OSC-TCP', `Eos version: ${version}`);
    console.log(`📦 Eos version: ${version}`);
  }
  
  // Validate OSC message structure
  const validation = validateOSCMessage(oscMsg);
  if (!validation.valid) {
    // Only log validation errors for cue-related messages to reduce noise
    if (oscMsg && oscMsg.address && (
        oscMsg.address.includes('/cue/') || 
        oscMsg.address.includes('/active/') || 
        oscMsg.address.includes('/previous/')
    )) {
      logCueEvent('OSC-VALIDATION', validation.error);
      console.error(`[${getTimestamp()}] [OSC-VALIDATION] Message:`, oscMsg);
    }
    return;
  }
  
  try {
    // Eos sends cue info on these addresses
    if (oscMsg.address.startsWith("/eos/out/event/cue/") && oscMsg.address.endsWith("/fire")) {
      // Extract cue number from the address pattern 
      // Format: /eos/out/event/cue/NUMBER/fire or /eos/out/event/cue/LIST/NUMBER/fire
      const pathParts = oscMsg.address.split('/');
      let cueList, cueNumber;
      
      if (pathParts.length === 7) {
        // Format: /eos/out/event/cue/NUMBER/fire
        cueList = CUE_LIST_NUMBER.toString(); // Default to configured cue list
        cueNumber = pathParts[5]; // The NUMBER part
      } else if (pathParts.length === 8) {
        // Format: /eos/out/event/cue/LIST/NUMBER/fire  
        cueList = pathParts[5]; // The LIST part
        cueNumber = pathParts[6]; // The NUMBER part
        
        // Only process events from the configured cue list
        if (cueList !== CUE_LIST_NUMBER.toString()) {
          logCueEvent('OSC-FILTERED', `Ignoring FIRE event from cue list ${cueList} (tracking: ${CUE_LIST_NUMBER})`, `${cueList}/${cueNumber}`);
          return;
        }
      } else {
        logCueEvent('OSC-ERROR', `Invalid FIRE event address format: ${oscMsg.address}`);
        return;
      }
        
      const cueId = `${cueList}/${cueNumber}`;
      logCueEvent('OSC-IN', `FIRE event`, cueId);
      
      // Update state machine with fire event
      const fireTimestamp = Date.now();
      cueTracker.lastFiredCue = {
        cueId: cueId,
        cueList: cueList,
        cueNumber: cueNumber,
        fireTimestamp: fireTimestamp
      };
      
      // lastFiredCue now managed by cueTracker
      
      // Move other active cues to background when a new cue fires
      for (const [otherCueId, cue] of cueTracker.cues) {
        if (otherCueId !== cueId && 
            cue.state === CueState.ACTIVE &&
            fireTimestamp > cue.lastUpdate) {
          // Move to background instead of terminating - cue is still running but no longer primary
          cueTracker.transitionCueState(otherCueId, CueState.BACKGROUND, `Moved to background by fire of ${cueId}`);
          // Schedule completion prediction for the backgrounded cue
          cueTracker.scheduleBackgroundCueCompletion(otherCueId);
          logCueEvent('FIRE', `Moved ${otherCueId} to background`, otherCueId);
        }
      }
      
      // Handle the fired cue - create or reactivate it
      const existingCue = cueTracker.cues.get(cueId);
      if (existingCue) {
        // Reactivate existing cue if it was stale or finished
        if (existingCue.state === CueState.STALE || existingCue.state === CueState.FINISHED) {
          cueTracker.transitionCueState(cueId, CueState.ACTIVE, 'Reactivated by FIRE event');
          logCueEvent('FIRE', `Reactivated existing cue`, cueId);
        } else {
          // Update timestamp for existing active cue
          existingCue.lastUpdate = fireTimestamp;
          logCueEvent('FIRE', `Updated timestamp for active cue`, cueId);
        }
      } else {
        // Create new cue with minimal data from FIRE event
        // Extract label from FIRE event args if available
        const fireLabel = oscMsg.args && oscMsg.args[0] && oscMsg.args[0].value ? oscMsg.args[0].value : '';
        const fireCueData = {
          cueList: cueList,
          cueNumber: cueNumber,
          label: fireLabel || `Cue ${cueNumber}`, // Use label from FIRE event or fallback
          time: null, // Will be updated when ACTIVE message arrives
          percentage: '0%', // Start with 0% until we know more
          raw: `FIRE:${cueId}`,
          timestamp: fireTimestamp
        };
        
        const newCue = cueTracker.updateCue(cueId, fireCueData, 'fire');
        // Immediately transition to ACTIVE since it was fired
        if (newCue.state === CueState.DISCOVERED) {
          cueTracker.transitionCueState(cueId, CueState.ACTIVE, 'Activated by FIRE event');
        }
        logCueEvent('FIRE', `Created new cue from FIRE event`, cueId);
        
        // Check if we get ACTIVE message within 1 second, if not treat as instant/completed cue
        setTimeout(() => {
          const cue = cueTracker.cues.get(cueId);
          if (cue && cue.raw && cue.raw.startsWith('FIRE:') && !cue.fireExecuted) {
            logCueEvent('FIRE', `No ACTIVE message received - treating as instant/completed cue`, cueId);
            // Update to show as completed cue (like instant cues)
            cue.percentage = '100%';
            cue.time = 0;
            // Keep the original label from FIRE event
            cue.raw = `FIRE-COMPLETED:${cueId}`;
            cueTracker.transitionCueState(cueId, CueState.COMPLETING, 'FIRE event without ACTIVE - completed');
            
            // Auto-finish after brief delay (like other completing cues)
            setTimeout(() => {
              if (cueTracker.cues.has(cueId) && cueTracker.cues.get(cueId).state === CueState.COMPLETING) {
                cueTracker.transitionCueState(cueId, CueState.FINISHED, 'Instant cue completion');
                cueTracker.cleanupFinishedCue(cueId);
              }
            }, 500);
            
            broadcastActiveCues();
          }
        }, 1000); // Wait 1 second to see if ACTIVE message follows
      }
      
      // Don't broadcast FIRE-only cues immediately - wait for ACTIVE message with complete data
      // This prevents flicker from incomplete cue information
      // broadcastActiveCues();
    } else if (oscMsg.address === "/eos/out/active/cue/text") {
      const fullCueText = oscMsg.args[0].value;
      logCueEvent('OSC-IN', `ACTIVE cue message`, '', fullCueText);

      // Use robust parsing function
      const parseResult = parseActiveCue(fullCueText);
    
    if (parseResult) {
      // Only process cues from the configured cue list
      if (parseResult.cueList !== CUE_LIST_NUMBER.toString()) {
        logCueEvent('OSC-FILTERED', `Ignoring ACTIVE cue from cue list ${parseResult.cueList} (tracking: ${CUE_LIST_NUMBER})`, `${parseResult.cueList}/${parseResult.cueNumber}`, fullCueText);
        return;
      }
      
      const cueId = `${parseResult.cueList}/${parseResult.cueNumber}`;
      
      // Validate parsed cue data
      const cueData = {
        cueList: parseResult.cueList,
        cueNumber: parseResult.cueNumber,
        label: parseResult.label,
        time: parseResult.time,
        percentage: parseResult.percentage,
        raw: fullCueText,
        timestamp: Date.now()
      };
      
      const dataValidation = validateCueData(cueData, 'active');
      if (!dataValidation.valid) {
        logCueEvent('VALIDATION', `Invalid active cue data: ${dataValidation.errors.join(', ')}`, cueId, fullCueText);
        return;
      }
      
      const updatedCue = cueTracker.updateCue(cueId, cueData, 'active');
      
      // If we don't have stored data for this cue, try to fetch it
      if (!updatedCue.hasStoredData) {
        handleMissingCue(cueId, parseResult.cueList, parseResult.cueNumber);
      }
      
      // Check if this was a cue created from FIRE event that now has full details
      const wasFireCreated = updatedCue.raw && updatedCue.raw.startsWith('FIRE:');
      if (wasFireCreated) {
        logCueEvent('ACTIVE', `Fire-created cue now has full details - this was actual execution`, cueId, fullCueText);
        // Update the raw data to reflect it now has full active details
        updatedCue.raw = fullCueText;
        // Mark that this FIRE event was followed by ACTIVE (real execution)
        updatedCue.fireExecuted = true;
      }
      
      // Handle instant cues logging
      if (updatedCue && updatedCue.time === 0 && updatedCue.percentage === '100%') {
        logCueEvent('CUE-TYPE', 'INSTANT CUE (0-second cue)', cueId);
      }
      
    } else {
      // Handle parsing errors with fallback
      const errorCue = {
        raw: fullCueText,
        error: 'Failed to parse cue format'
      };
      
      logCueEvent('PARSE-ERROR', 'Failed to parse active cue', '', fullCueText);
      
      // For unparsed cues, just send the single cue
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ singleCue: errorCue }));
        }
      });
      return;
    }

    broadcastActiveCues();
  } else if (oscMsg.address === "/eos/out/previous/cue/text") {
    const fullCueText = oscMsg.args[0].value;
    logCueEvent('OSC-IN', `PREVIOUS cue message`, '', fullCueText);
    
    // Handle previous cues (completed cues that are still running in background)
    if (fullCueText.trim() === '') {
      logCueEvent('PREVIOUS', 'EMPTY - clearing all background cues');
      
      // Transition all background cues to finished
      for (const [cueId, cue] of cueTracker.cues) {
        if (cue.state === CueState.BACKGROUND) {
          cueTracker.transitionCueState(cueId, CueState.FINISHED, 'Previous list cleared');
          cueTracker.cleanupFinishedCue(cueId);
        }
      }
      
      // Previous cues state now handled by CueTracker
      
      broadcastActiveCues();
    } else {
      // Use robust parsing function for previous cues
      const parseResult = parsePreviousCue(fullCueText);
      
      if (parseResult) {
        // Only process cues from the configured cue list
        if (parseResult.cueList !== CUE_LIST_NUMBER.toString()) {
          logCueEvent('OSC-FILTERED', `Ignoring PREVIOUS cue from cue list ${parseResult.cueList} (tracking: ${CUE_LIST_NUMBER})`, `${parseResult.cueList}/${parseResult.cueNumber}`, fullCueText);
          return;
        }
        
        const cueId = `${parseResult.cueList}/${parseResult.cueNumber}`;
        
        logCueEvent('PREVIOUS', 'CUE MOVED TO PREVIOUS', cueId, fullCueText);
        
        // Validate parsed cue data
        const cueData = {
          cueList: parseResult.cueList,
          cueNumber: parseResult.cueNumber,
          label: parseResult.label,
          time: parseResult.time,
          raw: fullCueText
        };
        
        const dataValidation = validateCueData(cueData, 'previous');
        if (!dataValidation.valid) {
          logCueEvent('VALIDATION', `Invalid previous cue data: ${dataValidation.errors.join(', ')}`, cueId, fullCueText);
          return;
        }
        
        const previousCue = cueTracker.updateCue(cueId, cueData, 'previous');
        
        // If we don't have stored data for this previous cue, try to fetch it
        if (!previousCue.hasStoredData) {
          handleMissingCue(cueId, parseResult.cueList, parseResult.cueNumber);
        }
        
        // CueTracker now handles displaced previous cues automatically through state transitions
      } else {
        logCueEvent('PARSE-ERROR', 'Failed to parse previous cue', '', fullCueText);
      }
    }
  }
  
  } catch (error) {
    logCueEvent('OSC-ERROR', `Error processing message from ${oscMsg.address}: ${error.message}`);
    console.error(`[${getTimestamp()}] [OSC-ERROR] Full error:`, error);
    console.error(`[${getTimestamp()}] [OSC-ERROR] Message data:`, oscMsg);
    
    // Try to extract cue info for error reporting if possible
    try {
      if (oscMsg.args && oscMsg.args[0] && oscMsg.args[0].value) {
        logCueEvent('OSC-ERROR', `Message content`, '', oscMsg.args[0].value);
      }
    } catch (innerError) {
      logCueEvent('OSC-ERROR', 'Could not extract message content');
    }
  }
});

function broadcastActiveCues() {
  // Perform maintenance on the state machine
  cueTracker.performMaintenance();
  
  // Get current state from the tracker
  const trackerActiveCues = cueTracker.getActiveCues();
  const headerCue = cueTracker.getHeaderCue();
  
  // Filter out the header cue from active cues to prevent duplication
  const filteredActiveCues = headerCue ? 
    trackerActiveCues.filter(cue => cue.cueId !== headerCue.cueId) :
    trackerActiveCues;
  
  // Convert state machine cues to format expected by overlay
  const sortedCues = filteredActiveCues.map(cue => ({
    ...cue,
    // Add legacy properties for overlay compatibility
    isRunning: cue.state === CueState.ACTIVE && cue.percentage !== '100%',
    isBackgroundRunning: cue.state === CueState.BACKGROUND,
    isStale: cue.state === CueState.STALE,
    timestamp: cue.discoveredAt || cue.lastUpdate // Use discoveredAt for sorting if available
  }));
  
  // Prepare header cue with running status
  let displayHeaderCue = null;
  if (headerCue) {
    // Include header cue if it has a label (even if just from FIRE event)
    // The overlay can display cues with partial data - better to show something than nothing
    // Only filter out completely invalid cues (no label at all)
    const hasLabel = headerCue.label && headerCue.label.trim() !== '';
    
    if (!hasLabel) {
      logCueEvent('BROADCAST-FILTER', `Filtering header cue ${headerCue.cueId} - no label`);
    } else {
      displayHeaderCue = {
        ...headerCue,
        isRunning: headerCue.state === CueState.ACTIVE && headerCue.percentage !== '100%',
        isBackgroundRunning: headerCue.state === CueState.BACKGROUND,
        isStale: headerCue.state === CueState.STALE,
        timestamp: headerCue.discoveredAt || headerCue.lastUpdate
      };
    }
  }
  
  // Legacy activeCues map no longer needed - data comes from CueTracker
  
  const message = {
    activeCues: sortedCues,
    latestCue: displayHeaderCue
  };
  
  // Check if the state has actually changed before logging
  const debugInfo = cueTracker.getDebugInfo();
  const activeCueIds = sortedCues.map(cue => cue.cueId).join(', ');
  const headerCueId = displayHeaderCue ? displayHeaderCue.cueId : 'none';
  
  const currentBroadcastState = {
    cueCount: debugInfo.cueCount,
    stateDistribution: JSON.stringify(debugInfo.stateDistribution),
    activeCueIds,
    headerCueId
  };
  
  // Only log if state has changed or this is the first time we have cues
  const stateChanged = (
    currentBroadcastState.cueCount !== lastBroadcastState.cueCount ||
    currentBroadcastState.stateDistribution !== lastBroadcastState.stateDistribution ||
    currentBroadcastState.activeCueIds !== lastBroadcastState.activeCueIds ||
    currentBroadcastState.headerCueId !== lastBroadcastState.headerCueId
  );
  
  const hasActiveCues = sortedCues.length > 0;
  const hasHeader = displayHeaderCue !== null;
  
  if (stateChanged && (hasActiveCues || hasHeader)) {
    if (debugInfo.cueCount > 0) {
      logCueEvent('DEBUG', `${debugInfo.cueCount} tracked cues: ${debugInfo.stateDistribution}`);
    }
    logCueEvent('BROADCAST', `Sending ${sortedCues.length} cues [${activeCueIds}], header: ${headerCueId}`);
  }
  
  // Update last broadcast state
  lastBroadcastState = currentBroadcastState;
  
  // Broadcast to all connected WebSocket clients
  let clientCount = 0;
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
      clientCount++;
    }
  });
  
  // Only log client count when state changed and we have meaningful data
  if (stateChanged && (hasActiveCues || hasHeader) && clientCount > 0) {
    logCueEvent('BROADCAST', `Sent to ${clientCount} connected client(s)`);
  }
}

// Periodic maintenance and cleanup - reduced frequency to minimize log noise
setInterval(() => {
  // The state machine handles its own maintenance in broadcastActiveCues
  // This interval ensures regular state checks even without OSC messages
  broadcastActiveCues();
}, 2000); // Check every 2 seconds (reduced from 500ms)

// Periodic cue list refresh (configurable interval) to catch any changes
setInterval(() => {
  if (cueListManager.isConnected) {
    logCueEvent('MAINTENANCE', 'Performing periodic cue list sync');
    cueListManager.syncCueList(CUE_LIST_NUMBER).catch(error => {
      logCueEvent('MAINTENANCE-WARN', `Periodic cue list sync failed: ${error.message}`);
    });
  }
}, SYNC_INTERVAL_MINUTES * 60 * 1000); // Configurable interval

// Enhanced missing cue handler - if we discover a cue from OSC that's not in our stored list, try to fetch it
async function handleMissingCue(cueId, cueList, cueNumber) {
  if (!cueListManager.isConnected) return;
  
  try {
    logCueEvent('MISSING-CUE', `Attempting to fetch missing cue info for ${cueId}`);
    const refreshedCue = await cueListManager.refreshCue(cueList, cueNumber);
    
    if (refreshedCue) {
      logCueEvent('MISSING-CUE', `Successfully fetched missing cue: ${refreshedCue.label}`, cueId);
    } else {
      logCueEvent('MISSING-CUE-WARN', `Could not fetch cue info from console`, cueId);
    }
  } catch (error) {
    logCueEvent('MISSING-CUE-ERROR', `Error fetching missing cue: ${error.message}`, cueId);
  }
}

// --- Startup Initialization ---

// Initialize connections
async function startServer() {
  try {
    // Validate configuration first
    const config = validateConfiguration();
    
    // Start OSC listener/connection
    if (OSC_PROTOCOL === "TCP") {
      logCueEvent('STARTUP', `Connecting to Eos OSC via TCP at ${EOS_CONSOLE_HOST}:${OSC_PORT}`);
      logCueEvent('STARTUP', 'TCP OSC requires:');
      logCueEvent('STARTUP', '  1. Third Party OSC enabled in Eos Shell (Network > Interface Protocols)');
      logCueEvent('STARTUP', '  2. "Allow Remotes" enabled (Setup > Remotes)');
      logCueEvent('STARTUP', '  3. Console configured for TCP OSC with SLIP encoding');
      
      // Add connection timeout to detect if connection never establishes
      const connectionTimeout = setTimeout(() => {
        const socketState = oscPort.socket ? oscPort.socket.readyState : 'no socket';
        if (socketState !== 'open') {
          console.error('⚠️  TCP connection has not established after 10 seconds');
          console.error(`⚠️  Socket state: ${socketState}`);
          console.error('⚠️  Please verify:');
          console.error('   1. Third Party OSC is enabled in Eos Shell (Network > Interface Protocols)');
          console.error('   2. "Allow Remotes" is enabled (Setup > Remotes)');
          console.error('   3. Console is reachable at ' + EOS_CONSOLE_HOST);
          logCueEvent('OSC-TCP-ERROR', `Connection timeout after 10s - socket state: ${socketState}`);
        }
      }, 10000);
      
      // Clear timeout when connection succeeds
      oscPort.once('ready', () => {
        clearTimeout(connectionTimeout);
      });
      
      oscPort.open();
    } else {
      oscPort.open();
      logCueEvent('STARTUP', `Listening for Eos OSC on UDP port ${OSC_PORT}`);
    }
    
    // Attempt to connect to Eos console for enhanced cue list tracking (optional)
    logCueEvent('STARTUP', 'Starting enhanced cue tracking server');
    logCueEvent('STARTUP', `OSC: ${OSC_PROTOCOL} on port ${OSC_PORT}, WebSocket on port ${WEBSOCKET_PORT}`);
    logCueEvent('STARTUP', `Tracking cue list ${CUE_LIST_NUMBER}, sync interval: ${SYNC_INTERVAL_MINUTES} minutes`);
    
    if (USE_EOS_CONSOLE_API) {
      logCueEvent('STARTUP', `Attempting Eos console API connection to ${EOS_CONSOLE_HOST}:${EOS_CONSOLE_PORT}`);
      // Connect to Eos console (non-blocking, will fallback gracefully)
      cueListManager.connect().catch(error => {
        logCueEvent('STARTUP-WARN', `Eos console API connection failed, continuing in OSC-only mode: ${error.message}`);
      });
    } else {
      logCueEvent('STARTUP', 'EosConsole API disabled - using OSC data only');
    }
    
    // Log startup status after a brief delay to see connection results
    setTimeout(() => {
      if (USE_EOS_CONSOLE_API) {
        const status = cueListManager.getStatus();
        if (status.connected) {
          logCueEvent('STARTUP', `✅ Enhanced tracking active: ${status.cueCount} cues loaded from Eos console`);
          logCueEvent('STARTUP', `📊 Mode: Enhanced (OSC + Console data) for more accurate timing`);
        } else {
          logCueEvent('STARTUP', `⚠️  Running in OSC-only mode (console connection attempts: ${status.connectionAttempts}/${cueListManager.maxReconnectAttempts})`);
          logCueEvent('STARTUP', `📊 Mode: OSC-only (percentage-based timing estimates)`);
        }
      } else {
        logCueEvent('STARTUP', `📊 Mode: OSC-only (EosConsole API disabled, using ${OSC_PROTOCOL} OSC)`);
      }
    }, 2000);
    
  } catch (error) {
    logCueEvent('STARTUP-ERROR', `Server startup failed: ${error.message}`);
    console.error('Server startup error:', error);
    process.exit(1);
  }
}

// Graceful shutdown handling
process.on('SIGINT', async () => {
  logCueEvent('SHUTDOWN', 'Received SIGINT, shutting down gracefully...');
  
  try {
    // Disconnect from Eos console (if enabled)
    if (USE_EOS_CONSOLE_API) {
      await cueListManager.disconnect();
    }
    
    // Close WebSocket server
    wss.close(() => {
      logCueEvent('SHUTDOWN', 'WebSocket server closed');
    });
    
    // Close OSC port
    if (oscPort) {
      oscPort.close();
      logCueEvent('SHUTDOWN', `OSC ${OSC_PROTOCOL} port closed`);
    }
    
    logCueEvent('SHUTDOWN', 'Server shutdown complete');
    process.exit(0);
  } catch (error) {
    logCueEvent('SHUTDOWN-ERROR', `Error during shutdown: ${error.message}`);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  logCueEvent('SHUTDOWN', 'Received SIGTERM, shutting down gracefully...');
  if (USE_EOS_CONSOLE_API) {
    await cueListManager.disconnect();
  }
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logCueEvent('FATAL-ERROR', `Uncaught exception: ${error.message}`);
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logCueEvent('FATAL-ERROR', `Unhandled rejection at: ${promise}, reason: ${reason}`);
  console.error('Unhandled rejection:', reason);
});

// Start the server
startServer();