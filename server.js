const osc = require("osc");
const WebSocket = require("ws");

// --- Configuration ---
const OSC_PORT = 8001; // Port to listen for OSC from Eos
const WEBSOCKET_PORT = 8081; // Port for the OBS overlay to connect to

// --- OSC Server Setup ---
const udpPort = new osc.UDPPort({
  localAddress: "0.0.0.0",
  localPort: OSC_PORT,
  metadata: true,
});

udpPort.on("ready", () => {
  console.log(`Listening for Eos OSC on port ${OSC_PORT}`);
});

udpPort.on("error", (err) => {
  console.error("OSC Error:", err);
});

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
  [CueState.FINISHED]: [], // Terminal state
  [CueState.TERMINATED]: [], // Terminal state
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
      // Save as last header cue if it's recent enough
      if (!this.lastHeaderCue || cue.lastUpdate > this.lastHeaderCue.lastUpdate) {
        this.lastHeaderCue = { ...cue };
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
      // Check for stale cues
      if (now - cue.lastUpdate > this.STALE_TIMEOUT && cue.state !== CueState.STALE) {
        this.transitionCueState(cueId, CueState.STALE, 'No updates received');
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
      
      // Check for terminated cues (if newer cue was fired)
      if (this.lastFiredCue && 
          cue.state === CueState.ACTIVE &&
          this.lastFiredCue.fireTimestamp > cue.lastUpdate &&
          this.lastFiredCue.cueId !== cueId) {
        this.transitionCueState(cueId, CueState.TERMINATED, `Interrupted by ${this.lastFiredCue.cueId}`);
        this.cleanupFinishedCue(cueId);
      }
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
    
    // Priority: ACTIVE > COMPLETING > BACKGROUND > lastHeaderCue
    const priorityCue = activeCues.find(cue => cue.state === CueState.ACTIVE) ||
                       activeCues.find(cue => cue.state === CueState.COMPLETING) ||
                       activeCues.find(cue => cue.state === CueState.BACKGROUND) ||
                       activeCues[0];
    
    if (priorityCue) {
      // Update lastHeaderCue if we have a current priority cue
      if (!this.lastHeaderCue || priorityCue.lastUpdate > this.lastHeaderCue.lastUpdate) {
        this.lastHeaderCue = { ...priorityCue };
      }
      return priorityCue;
    }
    
    return this.lastHeaderCue;
  }

  // Calculate estimated completion time based on progress rate
  estimateCompletionTime(cueId) {
    const cue = this.cues.get(cueId);
    if (!cue || !cue.progressHistory || cue.progressHistory.length < 2) {
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
    return Math.max(0, Math.round(estimatedRemainingTime));
  }

  // Predict when background cues will complete and schedule cleanup
  scheduleBackgroundCueCompletion(cueId) {
    const cue = this.cues.get(cueId);
    if (!cue || cue.state !== CueState.BACKGROUND) return;
    
    // Try percentage-based estimation first
    let estimatedTime = this.estimateCompletionTime(cueId);
    
    // Fallback to time-based calculation if estimation fails
    if (estimatedTime === null && cue.time && cue.time > 0) {
      const elapsedSinceDiscovered = Date.now() - cue.discoveredAt;
      const totalTime = cue.time * 1000;
      estimatedTime = Math.max(0, totalTime - elapsedSinceDiscovered);
      logCueEvent('BACKGROUND', `Using time-based estimation: ${estimatedTime}ms remaining`, cueId);
    }
    
    if (estimatedTime !== null && estimatedTime >= 0) {
      logCueEvent('BACKGROUND', `Estimated completion in ${estimatedTime}ms`, cueId);
      
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

// Initialize the cue tracker
const cueTracker = new CueTracker();

// Track last broadcast state to avoid duplicate logging
let lastBroadcastState = {
  cueCount: 0,
  stateDistribution: {},
  activeCueIds: '',
  headerCueId: 'none'
};

// Legacy variables for compatibility (will be phased out)
const activeCues = new Map(); // Track multiple active cues by cueId  
let lastStartedCue = null; // Track the most recently started cue for header display
let previousCues = new Set(); // Track which cues are currently in PREVIOUS list
let lastHeaderCue = null; // Always keep the last cue for header display
const STALE_TIMEOUT = 2000; // 2 seconds without updates = stale cue
let lastFiredCue = null; // Track the most recently fired cue from FIRE events

// --- Robust Parsing Functions ---
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
  
  // Extract the time (decimal number before percentage)
  const timeMatch = withoutPercentage.match(/\s+(\d+(?:\.\d+)?)$/);
  if (!timeMatch) {
    return null; // No time found before percentage
  }
  const time = timeMatch[1];
  const withoutTime = withoutPercentage.slice(0, -timeMatch[0].length);
  
  // Extract cue list and number from the beginning
  const cueMatch = withoutTime.match(/^(\d+)\/(\d+)\s+(.+)$/);
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
    time: parseFloat(time),
    percentage,
    raw: fullCueText
  };
}

function parsePreviousCue(fullCueText) {
  // Expected format: [CUE_LIST]/[CUE_NUMBER] [CUE_LABEL] [CUE_TIME]
  // Strategy: Work backwards from the end to avoid label interference
  
  // Extract the time (decimal number at the end)
  const timeMatch = fullCueText.match(/\s+(\d+(?:\.\d+)?)$/);
  if (!timeMatch) {
    return null; // No time found at end
  }
  const time = timeMatch[1];
  const withoutTime = fullCueText.slice(0, -timeMatch[0].length);
  
  // Extract cue list and number from the beginning
  const cueMatch = withoutTime.match(/^(\d+)\/(\d+)\s+(.+)$/);
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
    time: parseFloat(time),
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
udpPort.on("message", (oscMsg) => {
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
  if (oscMsg.address === "/eos/out/active/cue/text") {
    const fullCueText = oscMsg.args[0].value;
    logCueEvent('OSC-IN', `ACTIVE cue message`, '', fullCueText);
  } else if (oscMsg.address.startsWith("/eos/out/event/cue/") && oscMsg.address.endsWith("/fire")) {
    // Extract cue list and number from the address pattern /eos/out/event/cue/X/Y/fire
    const pathParts = oscMsg.address.split('/');
    if (pathParts.length >= 7) {
      const cueList = pathParts[5];
      const cueNumber = pathParts[6];
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
      
      // Legacy compatibility
      lastFiredCue = cueTracker.lastFiredCue;
      
      // Check if this fire event should terminate other active cues
      for (const [otherCueId, cue] of cueTracker.cues) {
        if (otherCueId !== cueId && 
            cue.state === CueState.ACTIVE &&
            fireTimestamp > cue.lastUpdate) {
          cueTracker.transitionCueState(otherCueId, CueState.TERMINATED, `Interrupted by fire of ${cueId}`);
        }
      }
    }
  }
  
  if (oscMsg.address === "/eos/out/active/cue/text") {
    const fullCueText = oscMsg.args[0].value;

    // Use robust parsing function
    const parseResult = parseActiveCue(fullCueText);
    
    if (parseResult) {
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
      
      cueTracker.updateCue(cueId, cueData, 'active');
      
      // Update legacy variables for compatibility during transition
      const updatedCue = cueTracker.cues.get(cueId);
      if (updatedCue) {
        activeCues.set(cueId, updatedCue);
        
        // Handle instant cues logging
        if (updatedCue.time === 0 && updatedCue.percentage === '100%') {
          logCueEvent('CUE-TYPE', 'INSTANT CUE (0-second cue)', cueId);
        }
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
      
      // Legacy cleanup for compatibility
      previousCues.forEach(cueId => {
        if (activeCues.has(cueId)) {
          logCueEvent('LEGACY', 'REMOVING FROM PREVIOUS', cueId);
          activeCues.delete(cueId);
        }
      });
      previousCues.clear();
      
      broadcastActiveCues();
    } else {
      // Use robust parsing function for previous cues
      const parseResult = parsePreviousCue(fullCueText);
      
      if (parseResult) {
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
        
        cueTracker.updateCue(cueId, cueData, 'previous');
        
        // Legacy compatibility - clean up displaced previous cues
        const cuesToRemove = Array.from(previousCues).filter(prevCueId => prevCueId !== cueId);
        cuesToRemove.forEach(prevCueId => {
          // Transition displaced cues to finished
          if (cueTracker.cues.has(prevCueId)) {
            cueTracker.transitionCueState(prevCueId, CueState.FINISHED, 'Displaced by new previous cue');
            cueTracker.cleanupFinishedCue(prevCueId);
          }
          
          if (activeCues.has(prevCueId)) {
            logCueEvent('LEGACY', 'REMOVING DISPLACED PREVIOUS', prevCueId);
            activeCues.delete(prevCueId);
          }
          previousCues.delete(prevCueId);
        });
        
        // Update legacy tracking
        previousCues.add(cueId);
        const updatedCue = cueTracker.cues.get(cueId);
        if (updatedCue) {
          activeCues.set(cueId, updatedCue);
        }
        
        if (cuesToRemove.length > 0) {
          broadcastActiveCues();
        }
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
  
  // Convert state machine cues to format expected by overlay
  const sortedCues = trackerActiveCues.map(cue => ({
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
    displayHeaderCue = {
      ...headerCue,
      isRunning: headerCue.state === CueState.ACTIVE && headerCue.percentage !== '100%',
      isBackgroundRunning: headerCue.state === CueState.BACKGROUND,
      isStale: headerCue.state === CueState.STALE,
      timestamp: headerCue.discoveredAt || headerCue.lastUpdate
    };
  }
  
  // Update legacy activeCues for compatibility during transition
  activeCues.clear();
  sortedCues.forEach(cue => {
    activeCues.set(cue.cueId, cue);
  });
  
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

// Open the OSC port
udpPort.open();