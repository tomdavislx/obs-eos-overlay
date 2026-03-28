# Configuration Guide

## Quick Console Setup

The easiest way to configure your Eos console connection is using `config.json`.

### First-Time Setup

1. Copy the example config:
   ```bash
   cp config.example.json config.json
   ```

2. Edit `config.json` with your console IP:
   ```json
   {
     "eos": {
       "host": "10.101.100.101",
       "port": 3037
     },
     "cueList": 1
   }
   ```

3. Restart the server:
   ```bash
   npm run dev
   ```

### Multiple Consoles

You can create multiple config files for different consoles:

```bash
# Your main console
config.json

# Backup console
config.backup.json

# Rehearsal console
config.rehearsal.json
```

Then copy the one you need:
```bash
cp config.backup.json config.json
npm run dev
```

## Configuration Priority

Settings are loaded in this order (highest priority first):

1. **Environment Variables** - Override everything
2. **config.json** - Your local settings
3. **Defaults** - Built-in defaults

## Available Settings

See `config.example.json` for all available options with comments.

### Most Common Settings

- **eos.host** - Console IP address (e.g., "10.101.100.101")
- **eos.port** - Console port (default: 3037)
- **cueList** - Which cue list to track (default: 1)
- **websocket.port** - Serves the overlay page **and** the WebSocket on this port (default: 8081). In OBS, use **`http://127.0.0.1:<port>/`** as the Browser Source URL (not a local `file://` path).

## Environment Variables (Optional)

You can also use environment variables instead of `config.json`:

```bash
EOS_HOST=10.101.100.101 npm run dev
```

Available variables:
- `EOS_HOST` - Console IP
- `EOS_PORT` - Console port
- `CUE_LIST` - Cue list number
- `WEBSOCKET_PORT` - Overlay HTTP + WebSocket port (same port for both)
- `LOG_OSC` - Log OSC messages (true/false)
- `LOG_STATE` - Log state transitions (true/false)

See `src/config.ts` for complete list.
