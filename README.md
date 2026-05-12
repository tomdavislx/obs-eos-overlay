# Eos → OBS Bridge

Displays live lighting cue information as an overlay in OBS Studio, synced in real-time with an ETC Eos lighting console.

## What it does

- Shows the active cue number and label on screen as cues fire
- Displays background (running) cues below the main cue
- Connects directly to your Eos console over the network
- Keeps the overlay up to date automatically — no manual intervention needed

## Download

Download the latest release for your Mac from the [Releases](../../releases) page:

- **Apple Silicon (M1/M2/M3/M4)** → `eos-obs-bridge-vX.X.X-macos-arm64.zip`
- **Intel Mac** → `eos-obs-bridge-vX.X.X-macos-x64.zip`

Unzip and you'll have:

```
eos-obs-bridge      ← the application
overlay.html        ← the OBS overlay page
styles.css          ← overlay styling
config.json         ← your configuration (edit this)
```

## Setup

### 1. Configure the bridge

Open `config.json` in any text editor. At minimum, set the IP address of your Eos console:

```json
{
  "eos": {
    "hosts": ["10.101.100.101"]
  }
}
```

All other settings can be adjusted through the built-in web interface once the bridge is running.

### 2. Prepare your Eos console

Two settings are required in Eos:

1. **Enable Third Party OSC** — `[Displays]` key → Shell tab → enable "Third Party OSC"
2. **Allow Remotes** — `[Setup]` → System Settings → System → Show Control → check "Allow Remotes"

### 3. Run the bridge

Open Terminal, navigate to the folder, and run:

```bash
./eos-obs-bridge
```

The bridge will print its status as it starts up. Leave this Terminal window open while you're using it.

### 4. Add the overlay in OBS

1. Add a **Browser Source** in OBS
2. Set the URL to **`http://127.0.0.1:8081/`**
3. Set the dimensions to match your canvas (e.g. 1920×1080)

> **Important:** use the HTTP URL above — do not point OBS at the `overlay.html` file directly. OBS's browser blocks WebSocket connections from local files.

If your bridge is running on a different machine to OBS, use that machine's IP address instead of `127.0.0.1`.

### 5. Configure via the web interface

Open **`http://127.0.0.1:8082/`** in a browser to access the configuration UI. From here you can adjust all settings and apply them without restarting manually.

## OBS Control (optional)

The bridge can trigger OBS recording and insert chapter markers based on cue fires. Enable this in the web interface under **OBS Control**, and enter your OBS WebSocket details (found in OBS under Tools → WebSocket Server Settings).

## Stopping the bridge

Click **Stop Server** in the web interface, or press `Ctrl+C` in the Terminal window.

## Troubleshooting

**Overlay shows "Waiting for connection..."**
The bridge isn't reachable from OBS. Check the bridge is running and that you're using `http://127.0.0.1:8081/` as the Browser Source URL (not a file path).

**Bridge can't connect to Eos**
Verify the IP address in `config.json`, and confirm both "Third Party OSC" and "Allow Remotes" are enabled on the console. The bridge will keep retrying automatically.

**macOS says the app can't be opened**
Right-click the `eos-obs-bridge` file and choose Open, then confirm. You only need to do this once.
