/**
 * ConfigServer — HTTP server providing a browser-based configuration UI.
 *
 * Routes:
 *   GET  /            → config UI HTML page
 *   GET  /api/config  → effective config from config.json + env (via loadConfig)
 *   POST /api/config  → validate + save config.json, then emit 'restart'
 *   GET  /api/status  → bridge running status
 *
 * Emits 'restart' after a successful save so index.ts can stop/reload/start
 * the bridge without killing this server.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { Config, loadConfig, getConfigPath } from '../config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const APP_VERSION: string = require('../../package.json').version;

export class ConfigServer extends EventEmitter {
  private static readonly MAX_CONFIG_BODY_BYTES = 512 * 1024;

  private server: http.Server | null = null;
  private readonly port: number;
  private readonly getStatus: () => any;
  private readonly getConfig: () => Config;

  constructor(options: { port: number; getStatus: () => any; getConfig: () => Config }) {
    super();
    this.port = options.port;
    this.getStatus = options.getStatus;
    this.getConfig = options.getConfig;
  }

  start(): void {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.server.listen(this.port, '0.0.0.0', () => {
      console.log(`[ConfigServer] Config UI: http://127.0.0.1:${this.port}/`);
    });
    this.server.on('error', (err: any) => {
      console.error(`[ConfigServer] Server error on port ${this.port}:`, err.message);
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  // ===== REQUEST HANDLING =====

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = (req.url || '/').split('?')[0];
    const method = req.method || 'GET';

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if ((url === '/' || url === '/index.html') && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(this.buildUI());
      return;
    }

    if (url === '/api/config' && method === 'GET') {
      this.handleGetConfig(res);
      return;
    }

    if (url === '/api/config' && method === 'POST') {
      this.handleSaveConfig(req, res);
      return;
    }

    if (url === '/api/status' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      try {
        res.end(JSON.stringify(this.getStatus()));
      } catch {
        res.end(JSON.stringify({ running: false }));
      }
      return;
    }

    if (url === '/api/shutdown' && method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => this.emit('shutdown'), 150);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  private handleGetConfig(res: http.ServerResponse): void {
    try {
      const cfg = this.getConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cfg, null, 2));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  private handleSaveConfig(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    let size = 0;
    let responded = false;

    const fail = (code: number, message: string): void => {
      if (responded) {
        return;
      }
      responded = true;
      if (!res.headersSent) {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      }
    };

    req.on('error', (err: Error) => {
      console.warn('[ConfigServer] Config POST request error:', err.message);
      fail(400, 'Request aborted');
    });

    req.on('data', (chunk: Buffer) => {
      if (responded) {
        return;
      }
      size += chunk.length;
      if (size > ConfigServer.MAX_CONFIG_BODY_BYTES) {
        fail(413, 'Request body too large');
        req.destroy();
        return;
      }
      body += chunk.toString();
    });

    req.on('end', () => {
      if (responded) {
        return;
      }
      const configPath = getConfigPath();
      try {
        const parsed = JSON.parse(body);
        const clean = this.stripCommentKeys(parsed);

        const previousContent = fs.existsSync(configPath)
          ? fs.readFileSync(configPath, 'utf-8')
          : null;

        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(clean, null, 2), 'utf-8');

        try {
          loadConfig();
        } catch (validationErr: any) {
          if (previousContent !== null) {
            fs.writeFileSync(configPath, previousContent, 'utf-8');
          } else {
            fs.unlinkSync(configPath);
          }
          fail(400, validationErr.message);
          return;
        }

        responded = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Saved. Restarting bridge...' }));
        setTimeout(() => this.emit('restart'), 150);
      } catch (err: any) {
        fail(400, err.message);
      }
    });
  }

  private stripCommentKeys(obj: any): any {
    if (Array.isArray(obj)) return obj.map((v) => this.stripCommentKeys(v));
    if (obj && typeof obj === 'object') {
      const out: any = {};
      for (const k of Object.keys(obj)) {
        if (!k.startsWith('_')) out[k] = this.stripCommentKeys(obj[k]);
      }
      return out;
    }
    return obj;
  }

  // ===== UI HTML =====

  private buildUI(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Eos Bridge — Config</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0f0f0f;--surface:#1a1a1a;--surface2:#222;--border:#2e2e2e;
  --text:#ddd;--muted:#888;--accent:#f26907;--accent-dim:#6b2d02;
  --danger:#e05252;--warn:#e09820;--input-bg:#252525;--radius:6px;
  --font:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --mono:ui-monospace,'Cascadia Code','Fira Mono',monospace;
}
html{background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;line-height:1.5}
body{min-height:100vh;display:flex;flex-direction:column}

/* ── Header ── */
header{
  position:sticky;top:0;z-index:100;
  background:#111;border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;
  padding:0 20px;height:52px;gap:12px
}
.h-title{font-size:15px;font-weight:600;letter-spacing:.02em;white-space:nowrap}
.h-version{font-size:11px;font-weight:400;opacity:.45;margin-left:4px;letter-spacing:0}
.h-indicators{display:flex;align-items:center;gap:20px;flex:1;justify-content:center}
.indicator{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted)}
.indicator-label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-right:2px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--muted);flex-shrink:0;transition:background .3s}
.dot.ok{background:#22c55e}
.dot.warn{background:var(--warn);animation:pulse 1s infinite}
.dot.err{background:var(--danger)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.h-actions{display:flex;gap:8px;align-items:center}

/* ── Buttons ── */
button{cursor:pointer;border:none;border-radius:var(--radius);font:inherit;font-size:13px;padding:6px 14px;transition:opacity .15s,background .15s}
button:disabled{opacity:.4;cursor:not-allowed}
.btn-primary{background:var(--accent);color:#fff;font-weight:600}
.btn-primary:not(:disabled):hover{opacity:.85}
.btn-ghost{background:transparent;color:var(--muted);border:1px solid var(--border)}
.btn-ghost:not(:disabled):hover{color:var(--text);border-color:#555}
.btn-danger{background:transparent;color:var(--danger);border:1px solid var(--danger);padding:2px 8px;font-size:12px}
.btn-danger:hover{background:var(--danger);color:#fff}
.btn-sm{padding:3px 10px;font-size:12px}

/* ── Toast ── */
#toast{
  position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
  background:#1e1e1e;border:1px solid var(--border);border-radius:8px;
  padding:10px 18px;font-size:13px;box-shadow:0 4px 20px #0008;
  display:flex;align-items:center;gap:10px;transition:opacity .3s;z-index:200
}
#toast.hidden{opacity:0;pointer-events:none}
#toast.ok{border-color:var(--accent)}
#toast.err{border-color:var(--danger)}

/* ── Main layout ── */
main{flex:1;max-width:920px;width:100%;margin:0 auto;padding:24px 20px 48px}

/* ── Sections ── */
section{background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:16px;overflow:hidden}
.sec-header{
  display:flex;align-items:center;justify-content:space-between;
  padding:12px 16px;cursor:pointer;user-select:none;
  border-bottom:1px solid var(--border);background:var(--surface2)
}
.sec-header h2{font-size:13px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
.sec-header .chevron{color:var(--muted);transition:transform .2s;font-size:11px}
.sec-header.collapsed .chevron{transform:rotate(-90deg)}
.sec-body{padding:16px}

/* ── Grid ── */
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 16px}
.grid.cols-3{grid-template-columns:1fr 1fr 1fr}
.full{grid-column:1/-1}

/* ── Fields ── */
label.field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)}
label.field span{color:var(--text);font-size:13px}
input[type=text],input[type=number],input[type=password],select,textarea{
  background:var(--input-bg);border:1px solid var(--border);border-radius:var(--radius);
  color:var(--text);font:inherit;font-size:13px;padding:6px 9px;width:100%;
  transition:border-color .15s;outline:none
}
input:focus,select:focus,textarea:focus{border-color:var(--accent)}
textarea{resize:vertical;font-family:var(--mono);font-size:12px;line-height:1.6}
select option{background:var(--surface)}

.checkbox-row{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding:4px 0}
.checkbox-row input[type=checkbox]{
  width:16px;height:16px;accent-color:var(--accent);cursor:pointer;flex-shrink:0
}

.hint{font-size:12px;color:var(--muted);margin-top:8px;line-height:1.6}
.hint code{font-family:var(--mono);color:var(--accent);font-size:12px}
.hint a{color:var(--accent);text-decoration:none}

/* ── OBS collapsible ── */
#obs-fields{margin-top:12px;border-top:1px solid var(--border);padding-top:14px}
#obs-fields.hidden{display:none}

/* ── Chapter markers table ── */
.markers-wrap{margin-top:12px}
.markers-wrap h3{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:600;color:var(--muted);font-size:11px;text-transform:uppercase;padding:4px 8px;border-bottom:1px solid var(--border)}
td{padding:4px 4px;vertical-align:middle}
td input{padding:4px 7px}
.add-row-btn{margin-top:8px}

/* ── Divider ── */
.divider{height:1px;background:var(--border);margin:14px 0}

/* ── Disabled overlay ── */
.disabled-note{font-size:12px;color:var(--muted);font-style:italic;padding:4px 0}

/* ── Connection lost modal ── */
#conn-modal{display:none;position:fixed;inset:0;z-index:200;align-items:center;justify-content:center;background:#000a}
#conn-modal.visible{display:flex}
.conn-box{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:32px 36px;text-align:center;box-shadow:0 8px 40px #000c;max-width:320px;width:90%}
.conn-box h2{margin:0 0 8px;font-size:16px;font-weight:600;color:var(--text)}
.conn-box p{margin:0 0 24px;font-size:13px;color:var(--muted)}
.conn-box .btn-primary{width:100%;justify-content:center}
</style>
</head>
<body>

<div id="conn-modal">
  <div class="conn-box">
    <h2>Unable to connect to server</h2>
    <p>The bridge may have stopped or restarted.</p>
    <button class="btn-primary" id="conn-retry-btn">Retry</button>
  </div>
</div>

<header>
  <div class="h-title">Eos &rarr; OBS Bridge <span class="h-version">v${APP_VERSION}</span></div>
  <div class="h-indicators">
    <div class="indicator">
      <span class="indicator-label">Eos</span>
      <span class="dot" id="eos-dot"></span>
      <span id="eos-text">Loading&hellip;</span>
    </div>
    <div class="indicator">
      <span class="indicator-label">OBS</span>
      <span class="dot" id="obs-dot"></span>
      <span id="obs-text">Loading&hellip;</span>
    </div>
  </div>
  <div class="h-actions">
    <button class="btn-ghost" id="shutdown-btn">Stop Server</button>
    <button class="btn-primary" id="save-btn">Apply</button>
  </div>
</header>

<main>
  <div id="toast" class="hidden"></div>

  <form id="cfg" novalidate>

    <!-- ── Eos Console ── -->
    <section>
      <div class="sec-header" onclick="toggleSection(this)">
        <h2>Eos Console</h2><span class="chevron">&#9660;</span>
      </div>
      <div class="sec-body">
        <div class="grid">
          <label class="field full">
            <span>Hosts <small style="color:var(--muted)">(one per line, tried in order)</small></span>
            <textarea id="eos.hosts" rows="3" placeholder="localhost"></textarea>
          </label>
          <label class="field">
            <span>Port</span>
            <input type="number" id="eos.port" min="1" max="65535" placeholder="3037">
          </label>
          <label class="field">
            <span>Connection Timeout (ms)</span>
            <input type="number" id="eos.connectionTimeout" min="1000" placeholder="10000">
          </label>
          <label class="field">
            <span>Max Reconnect Attempts <small style="color:var(--muted)">(0 = ∞)</small></span>
            <input type="number" id="eos.reconnectMaxAttempts" min="0" placeholder="0">
          </label>
          <label class="field">
            <span>Cue List</span>
            <input type="number" id="cueList" min="1" placeholder="1">
          </label>
          <label class="field">
            <span>Periodic sync interval (ms, 0 = off)</span>
            <input type="number" id="sync.syncInterval" min="0" placeholder="300000">
          </label>
        </div>
      </div>
    </section>

    <!-- ── OBS Control ── -->
    <section>
      <div class="sec-header" onclick="toggleSection(this)">
        <h2>OBS Control</h2><span class="chevron">&#9660;</span>
      </div>
      <div class="sec-body">
        <label class="checkbox-row">
          <input type="checkbox" id="obsControl.enabled" onchange="toggleObsFields()">
          Enable OBS WebSocket control
        </label>

        <div id="obs-fields" class="hidden">
          <div class="grid" style="margin-top:14px">
            <label class="field">
              <span>Host</span>
              <input type="text" id="obsControl.host" placeholder="127.0.0.1">
            </label>
            <label class="field">
              <span>Port</span>
              <input type="number" id="obsControl.port" min="1" max="65535" placeholder="4455">
            </label>
            <label class="field full">
              <span>Password</span>
              <input type="password" id="obsControl.password" placeholder="(leave blank if none)">
            </label>
            <label class="field full">
              <span>Record Start Cues <small style="color:var(--muted)">(comma-separated cue numbers)</small></span>
              <input type="text" id="obsControl.recordStartCueNumbers" placeholder="1, 10, 20">
            </label>
            <label class="field full">
              <span>Record Stop Cues <small style="color:var(--muted)">(comma-separated cue numbers)</small></span>
              <input type="text" id="obsControl.recordStopCueNumbers" placeholder="389, 400">
            </label>
            <label class="field">
              <span>Record Start Delay (ms)</span>
              <input type="number" id="obsControl.recordStartDelayMs" min="0" placeholder="0">
            </label>
            <label class="field">
              <span>Record Stop Delay (ms)</span>
              <input type="number" id="obsControl.recordStopDelayMs" min="0" placeholder="0">
            </label>
            <label class="checkbox-row full">
              <input type="checkbox" id="obsControl.useSceneBreakForChapters">
              Create chapter marker on scene change
            </label>
          </div>

          <div class="markers-wrap">
            <h3>Chapter Markers</h3>
            <table>
              <thead><tr><th>Cue Number</th><th>Label</th><th></th></tr></thead>
              <tbody id="markers-body"></tbody>
            </table>
            <button type="button" class="btn-ghost btn-sm add-row-btn" onclick="addMarkerRow('','')">+ Add Marker</button>
          </div>
        </div>
      </div>
    </section>

    <!-- ── Overlay ── -->
    <section>
      <div class="sec-header" onclick="toggleSection(this)">
        <h2>Overlay / WebSocket</h2><span class="chevron">&#9660;</span>
      </div>
      <div class="sec-body">
        <div class="grid">
          <label class="field">
            <span>Port</span>
            <input type="number" id="websocket.port" min="1" max="65535" placeholder="8081" oninput="updateObsUrl()">
          </label>
        </div>
        <label class="checkbox-row" style="margin-top:12px">
          <input type="checkbox" id="overlay.showSceneHeaders">
          Show Eos scene headers in overlay
        </label>
        <p class="hint" style="margin-top:12px">OBS Browser Source URL: <code id="obs-url">http://127.0.0.1:8081/</code></p>
      </div>
    </section>

    <!-- ── Config UI ── -->
    <section>
      <div class="sec-header collapsed" onclick="toggleSection(this)">
        <h2>Config UI Server</h2><span class="chevron">&#9660;</span>
      </div>
      <div class="sec-body" style="display:none">
        <div class="grid">
          <label class="checkbox-row">
            <input type="checkbox" id="configUI.enabled">
            Enabled (this server)
          </label>
          <label class="field">
            <span>Port</span>
            <input type="number" id="configUI.port" min="1" max="65535" placeholder="8082">
          </label>
        </div>
        <p class="hint" style="margin-top:10px">Changes to Config UI port take effect on next process restart.</p>
      </div>
    </section>

    <!-- ── Logging ── -->
    <section>
      <div class="sec-header" onclick="toggleSection(this)">
        <h2>Logging</h2><span class="chevron">&#9660;</span>
      </div>
      <div class="sec-body">
        <div class="grid cols-3">
          <label class="field">
            <span>Level</span>
            <select id="logging.level">
              <option value="debug">debug</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="error">error</option>
            </select>
          </label>
          <label class="checkbox-row">
            <input type="checkbox" id="logging.logOSC">
            Log OSC messages (verbose)
          </label>
          <label class="checkbox-row">
            <input type="checkbox" id="logging.logState">
            Log state transitions
          </label>
        </div>
      </div>
    </section>

  </form>
</main>

<script>
// ── Utilities ──────────────────────────────────────────────────────────────

function get(obj, path) {
  return path.split('.').reduce(function(o,k){ return o == null ? undefined : o[k]; }, obj);
}

function set(obj, path, value) {
  var parts = path.split('.');
  var o = obj;
  for (var i = 0; i < parts.length - 1; i++) {
    if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}

function showToast(msg, type, duration) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.className = type || '';
  if (t._timer) clearTimeout(t._timer);
  t._timer = setTimeout(function(){ t.className = 'hidden'; }, duration || 4000);
}

function toggleSection(header) {
  var body = header.nextElementSibling;
  var collapsed = header.classList.toggle('collapsed');
  body.style.display = collapsed ? 'none' : '';
}

function toggleObsFields() {
  var enabled = document.getElementById('obsControl.enabled').checked;
  document.getElementById('obs-fields').classList.toggle('hidden', !enabled);
}

function updateObsUrl() {
  var port = document.getElementById('websocket.port').value || '8081';
  document.getElementById('obs-url').textContent = 'http://127.0.0.1:' + port + '/';
}

// ── Chapter markers ────────────────────────────────────────────────────────

function addMarkerRow(cue, label) {
  var tbody = document.getElementById('markers-body');
  var tr = document.createElement('tr');
  tr.innerHTML =
    '<td><input type="text" class="m-cue" value="' + esc(cue) + '" placeholder="10"></td>' +
    '<td><input type="text" class="m-label" value="' + esc(label) + '" placeholder="Act 1 Start"></td>' +
    '<td><button type="button" class="btn-danger" onclick="removeMarkerRow(this)">&#10005;</button></td>';
  tbody.appendChild(tr);
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}

function removeMarkerRow(btn) {
  btn.closest('tr').remove();
}

// ── Populate form from config object ──────────────────────────────────────

var ARRAY_FIELDS = ['obsControl.recordStartCueNumbers', 'obsControl.recordStopCueNumbers'];

function populateForm(cfg) {
  var ids = [
    'eos.port','eos.connectionTimeout','eos.reconnectMaxAttempts','cueList',
    'sync.syncInterval',
    'websocket.port','overlay.showSceneHeaders',
    'logging.level','logging.logOSC','logging.logState',
    'obsControl.enabled','obsControl.host','obsControl.port','obsControl.password',
    'obsControl.recordStartCueNumbers','obsControl.recordStopCueNumbers',
    'obsControl.recordStartDelayMs','obsControl.recordStopDelayMs',
    'obsControl.useSceneBreakForChapters',
    'configUI.enabled','configUI.port'
  ];

  ids.forEach(function(id) {
    var el = document.getElementById(id);
    if (!el) return;
    var val = get(cfg, id);
    if (val === undefined || val === null) return;

    if (el.type === 'checkbox') {
      el.checked = Boolean(val);
    } else if (ARRAY_FIELDS.indexOf(id) !== -1) {
      el.value = Array.isArray(val) ? val.join(', ') : String(val);
    } else {
      el.value = String(val);
    }
  });

  // Hosts textarea
  var hostsEl = document.getElementById('eos.hosts');
  var hosts = get(cfg, 'eos.hosts');
  if (hostsEl && Array.isArray(hosts)) hostsEl.value = hosts.join('\\n');

  // Chapter markers
  var tbody = document.getElementById('markers-body');
  tbody.innerHTML = '';
  var markers = get(cfg, 'obsControl.recordChapterMarkers');
  if (Array.isArray(markers)) {
    markers.forEach(function(m) { addMarkerRow(m.cueNumber, m.label); });
  }

  toggleObsFields();
  updateObsUrl();
}

// ── Collect form → config object ──────────────────────────────────────────

function collectForm() {
  var cfg = {};

  var ids = [
    'eos.port','eos.connectionTimeout','eos.reconnectMaxAttempts','cueList',
    'sync.syncInterval',
    'websocket.port','overlay.showSceneHeaders',
    'logging.level','logging.logOSC','logging.logState',
    'obsControl.enabled','obsControl.host','obsControl.port','obsControl.password',
    'obsControl.recordStartCueNumbers','obsControl.recordStopCueNumbers',
    'obsControl.recordStartDelayMs','obsControl.recordStopDelayMs',
    'obsControl.useSceneBreakForChapters',
    'configUI.enabled','configUI.port'
  ];

  var numFields = new Set([
    'eos.port','eos.connectionTimeout','eos.reconnectMaxAttempts',
    'cueList',
    'sync.syncInterval',
    'websocket.port',
    'obsControl.port','obsControl.recordStartDelayMs','obsControl.recordStopDelayMs',
    'configUI.port'
  ]);

  ids.forEach(function(id) {
    var el = document.getElementById(id);
    if (!el) return;

    if (el.type === 'checkbox') {
      set(cfg, id, el.checked);
    } else if (ARRAY_FIELDS.indexOf(id) !== -1) {
      var parts = el.value.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
      set(cfg, id, parts);
    } else if (numFields.has(id)) {
      var rawNum = el.value.trim();
      if (rawNum === '') return;
      var n = parseFloat(rawNum);
      set(cfg, id, isNaN(n) ? 0 : n);
    } else {
      set(cfg, id, el.value);
    }
  });

  // Hosts
  var hostsEl = document.getElementById('eos.hosts');
  if (hostsEl) {
    var hosts = hostsEl.value.split(/[\\n,]/).map(function(s){ return s.trim(); }).filter(Boolean);
    set(cfg, 'eos.hosts', hosts.length ? hosts : ['localhost']);
  }

  // Chapter markers
  var markers = [];
  document.querySelectorAll('#markers-body tr').forEach(function(tr) {
    var cueNumber = tr.querySelector('.m-cue').value.trim();
    var label = tr.querySelector('.m-label').value.trim();
    if (cueNumber && label) markers.push({ cueNumber: cueNumber, label: label });
  });
  set(cfg, 'obsControl.recordChapterMarkers', markers);

  return cfg;
}

// ── Load config from server ────────────────────────────────────────────────

function loadConfig() {
  fetch('/api/config')
    .then(function(r){ return r.json(); })
    .then(function(cfg){ populateForm(cfg); })
    .catch(function(e){ showToast('Failed to load config: ' + e.message, 'err', 6000); });
}

// ── Save ──────────────────────────────────────────────────────────────────

document.getElementById('shutdown-btn').addEventListener('click', function() {
  var btn = document.getElementById('shutdown-btn');
  btn.disabled = true;
  btn.textContent = 'Stopping…';
  fetch('/api/shutdown', { method: 'POST' })
    .then(function() {
      btn.textContent = 'Stopped';
      document.getElementById('save-btn').disabled = true;
      showToast('Server stopped', 'ok', 0);
    })
    .catch(function() {
      btn.disabled = false;
      btn.textContent = 'Stop Server';
      showToast('Shutdown request failed', 'err', 4000);
    });
});

document.getElementById('save-btn').addEventListener('click', function() {
  var btn = document.getElementById('save-btn');
  btn.disabled = true;
  btn.textContent = 'Applying…';

  var cfg = collectForm();

  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg)
  })
  .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, data: d }; }); })
  .then(function(res) {
    if (!res.ok) {
      showToast('Error: ' + res.data.error, 'err', 8000);
      btn.disabled = false;
      btn.textContent = 'Apply';
      return;
    }
    showToast('Saved. Bridge restarting…', 'ok', 10000);
    btn.textContent = 'Restarting…';
    pollRestart(Date.now());
  })
  .catch(function(e) {
    showToast('Request failed: ' + e.message, 'err', 6000);
    btn.disabled = false;
    btn.textContent = 'Apply';
  });
});

function pollRestart(since) {
  setTimeout(function() {
    var btn = document.getElementById('save-btn');
    var elapsed = Date.now() - since;
    if (elapsed > 15000) {
      showToast('Bridge did not report running within 15s. Check the process terminal output.', 'err', 8000);
      btn.disabled = false;
      btn.textContent = 'Apply';
      return;
    }
    fetch('/api/status')
      .then(function(r){ return r.json(); })
      .then(function(s) {
        applyStatus(s);
        if (s.running) {
          showToast('Bridge restarted successfully', 'ok', 3000);
          btn.disabled = false;
          btn.textContent = 'Apply';
          loadConfig();
        } else {
          pollRestart(since);
        }
      })
      .catch(function() {
        pollRestart(since);
      });
  }, 600);
}

// ── Status polling ────────────────────────────────────────────────────────

function applyStatus(s) {
  var eosDot = document.getElementById('eos-dot');
  var eosText = document.getElementById('eos-text');
  var obsDot = document.getElementById('obs-dot');
  var obsText = document.getElementById('obs-text');

  if (!s.running) {
    eosDot.className = 'dot err';
    eosText.textContent = 'Bridge stopped';
    obsDot.className = 'dot';
    obsText.textContent = '—';
    return;
  }

  // Eos indicator
  var eosState = (s.connection && s.connection.state) ? s.connection.state : '';
  if (eosState === 'CONNECTED') {
    eosDot.className = 'dot ok';
    eosText.textContent = 'Connected';
  } else if (eosState === 'CONNECTING' || eosState === 'RECONNECTING') {
    eosDot.className = 'dot warn';
    eosText.textContent = eosState === 'RECONNECTING' ? 'Reconnecting…' : 'Connecting…';
  } else if (eosState === 'ERROR') {
    eosDot.className = 'dot err';
    eosText.textContent = 'Error';
  } else {
    eosDot.className = 'dot err';
    eosText.textContent = 'Disconnected';
  }

  // OBS indicator
  if (!s.obs || !s.obs.enabled) {
    obsDot.className = 'dot';
    obsText.textContent = 'Disabled';
  } else if (s.obs.connected) {
    obsDot.className = 'dot ok';
    obsText.textContent = 'Connected';
  } else {
    obsDot.className = 'dot err';
    obsText.textContent = 'Disconnected';
  }
}

function showConnModal() {
  document.getElementById('conn-modal').classList.add('visible');
  document.getElementById('save-btn').disabled = true;
  document.getElementById('shutdown-btn').disabled = true;
}

function hideConnModal() {
  document.getElementById('conn-modal').classList.remove('visible');
  document.getElementById('save-btn').disabled = false;
  document.getElementById('shutdown-btn').disabled = false;
}

function refreshStatus() {
  fetch('/api/status')
    .then(function(r){ return r.json(); })
    .then(function(s) {
      hideConnModal();
      applyStatus(s);
    })
    .catch(function() {
      showConnModal();
    });
}

document.getElementById('conn-retry-btn').addEventListener('click', function() {
  var btn = document.getElementById('conn-retry-btn');
  btn.disabled = true;
  btn.textContent = 'Retrying…';
  fetch('/api/status')
    .then(function(r){ return r.json(); })
    .then(function(s) {
      hideConnModal();
      applyStatus(s);
      loadConfig();
    })
    .catch(function() {
      btn.disabled = false;
      btn.textContent = 'Retry';
    });
});

// ── Boot ──────────────────────────────────────────────────────────────────

loadConfig();
refreshStatus();
setInterval(refreshStatus, 5000);
</script>
</body>
</html>`;
  }
}
