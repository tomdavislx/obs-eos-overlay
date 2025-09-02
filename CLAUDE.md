# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an OSC-to-WebSocket bridge application that receives lighting cue data from ETC Eos lighting consoles via OSC (Open Sound Control) and forwards it to OBS Studio overlays via WebSocket. The system consists of:

- **server.js**: Node.js bridge server that listens for OSC messages and forwards them via WebSocket
- **overlay.html**: Browser-based overlay that connects to the WebSocket server and displays cue information

## Architecture

The application follows a bridge pattern with sophisticated cue state management:

### Core Components
- **OSC Server**: Listens on UDP for messages from Eos console using the `osc` library
- **WebSocket Server**: Serves real-time connections to overlay clients using the `ws` library  
- **CueTracker State Machine**: Manages cue lifecycle with states (DISCOVERED, ACTIVE, COMPLETING, BACKGROUND, FINISHED, TERMINATED, STALE, ERROR)
- **HTML Overlay**: Browser-based display with automatic reconnection and visual state feedback

### Message Processing
1. **OSC Input**: Processes messages from `/eos/out/active/cue/text`, `/eos/out/previous/cue/text`, and `/eos/out/event/cue/*/fire`
2. **Robust Parsing**: Handles active cue format `[LIST]/[NUMBER] [LABEL] [TIME] [PERCENTAGE]` and previous cue format `[LIST]/[NUMBER] [LABEL] [TIME]`
3. **State Management**: Tracks cue transitions through defined lifecycle with validation
4. **WebSocket Broadcast**: Sends structured data to overlay clients with current and background cues

### State Machine (CueTracker class)
- Manages multiple concurrent cues with proper state transitions
- Handles background cue completion estimation and cleanup
- Provides stale cue detection and automatic cleanup
- Maintains state history for debugging

## Common Commands

```bash
# Start the bridge server
npm start

# Install dependencies
npm install
```

## Configuration

Default ports (configured in server.js:5-6):
- OSC_PORT: 8001 (receives from Eos)
- WEBSOCKET_PORT: 8081 (serves overlays)

## Usage in OBS

The overlay.html file should be added as a Browser Source in OBS Studio, pointing to the local file path. The overlay displays:
- Main cue in large text with visual state indicators (running=green, completed=white, stale=red)
- Background running cues in smaller text below
- Flash animation for newly detected cues
- Special handling for instant cues (0-second duration)

## Code Architecture

### Key Classes and Functions
- `CueTracker`: Main state machine class managing all cue lifecycle
- `parseActiveCue()`: Robust parsing for active cue messages  
- `parsePreviousCue()`: Parsing for previous/background cue messages
- `validateOSCMessage()` / `validateCueData()`: Input validation
- `broadcastActiveCues()`: WebSocket message distribution with state maintenance

### Error Handling
- Comprehensive OSC message validation
- Graceful fallbacks for unparsed cue data
- State transition validation with logging
- WebSocket reconnection logic in overlay

### Debugging
- Extensive logging with timestamps and cue IDs
- State history tracking per cue
- Debug utilities in `getDebugInfo()` method
- Console logging in overlay for troubleshooting

## Testing

The test directory exists but no test framework is currently configured. The package.json test script returns an error indicating tests need to be implemented.