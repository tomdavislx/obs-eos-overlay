/**
 * OverlayServer
 * HTTP (overlay page) + WebSocket (cue updates) on one port.
 * OBS Browser Source often fails WebSocket from file://; use http://127.0.0.1:PORT/ in OBS.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import WebSocket, { WebSocketServer } from 'ws';
import { CueData } from '../types/cue';
import { OverlayMessageType, OverlayMessage } from '../types/websocket';

interface Client {
  id: string;
  socket: WebSocket;
  connectedAt: number;
  lastPing?: number;
}

export class OverlayServer extends EventEmitter {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients: Map<string, Client> = new Map();
  private port: number;
  private pingInterval: number;
  private pingTimer: NodeJS.Timeout | null = null;
  private nextClientId: number = 1;
  private readonly overlayHtmlPath: string;

  constructor(config: { port: number; pingInterval: number }) {
    super();
    this.port = config.port;
    this.pingInterval = config.pingInterval;
    this.overlayHtmlPath = path.join(__dirname, '..', '..', 'overlay.html');
  }

  /**
   * Start HTTP + WebSocket server (same TCP port)
   */
  start(): void {
    if (this.httpServer || this.wss) {
      throw new Error('OverlayServer is already running');
    }

    console.log(`[OverlayServer] Starting HTTP + WebSocket on port ${this.port}...`);

    let overlayBody: string;
    try {
      overlayBody = fs.readFileSync(this.overlayHtmlPath, 'utf8');
    } catch (e) {
      console.error('[OverlayServer] Could not read overlay.html at', this.overlayHtmlPath, e);
      throw e;
    }

    this.httpServer = http.createServer((req, res) => {
      const rawUrl = req.url?.split('?')[0] || '/';
      if (req.method === 'GET' && (rawUrl === '/' || rawUrl === '/overlay.html')) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(overlayBody);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    });

    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (socket: WebSocket) => {
      this.handleConnection(socket);
    });

    this.wss.on('error', (error: Error) => {
      console.error('[OverlayServer] WebSocket server error:', error);
      this.emit('error', error);
    });

    this.httpServer.on('error', (error: Error) => {
      console.error('[OverlayServer] HTTP server error:', error);
      this.emit('error', error);
    });

    this.httpServer.listen(this.port, '0.0.0.0', () => {
      console.log(
        `[OverlayServer] Overlay page: http://127.0.0.1:${this.port}/  (OBS: use this URL, not a local file — CEF blocks file→WebSocket)`
      );
      console.log(
        `[OverlayServer] WebSocket: ws://127.0.0.1:${this.port}  (from another PC: http://<bridge-LAN-IP>:${this.port}/ )`
      );
      this.emit('started');
    });

    this.startPingInterval();
  }

  /**
   * Stop HTTP + WebSocket server
   */
  stop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    for (const client of this.clients.values()) {
      try {
        client.socket.close();
      } catch (err) {
        // Ignore errors during cleanup
      }
    }
    this.clients.clear();

    const wss = this.wss;
    const httpServer = this.httpServer;
    this.wss = null;
    this.httpServer = null;

    if (wss) {
      wss.close((err) => {
        if (err) {
          console.error('[OverlayServer] WebSocketServer.close:', err);
        }
        if (httpServer) {
          httpServer.close(() => {
            console.log('[OverlayServer] HTTP/WebSocket server stopped');
            this.emit('stopped');
          });
        } else {
          this.emit('stopped');
        }
      });
    } else if (httpServer) {
      httpServer.close(() => {
        console.log('[OverlayServer] HTTP server stopped');
        this.emit('stopped');
      });
    } else {
      this.emit('stopped');
    }
  }

  /**
   * Broadcast cue update to all connected clients
   */
  broadcastCueUpdate(activeCues: CueData[]): void {
    const latestCue = activeCues.length > 0 ? activeCues[0] : null;

    const message: OverlayMessage = {
      type: OverlayMessageType.CUE_UPDATE,
      timestamp: Date.now(),
      data: {
        activeCues,
        latestCue,
        totalTrackedCues: activeCues.length,
      },
    };

    this.broadcast(message);
  }

  /**
   * Broadcast connection status to all clients
   * Status: 'connecting' | 'syncing' | 'connected' | 'disconnected' | 'reconnecting'
   */
  broadcastConnectionStatus(status: string, message?: string): void {
    const msg: OverlayMessage = {
      type: OverlayMessageType.CONNECTION_STATUS,
      timestamp: Date.now(),
      data: {
        status,
        message,
        connected: status === 'connected',
        clientCount: this.clients.size,
      },
    };

    this.broadcast(msg);
  }

  /**
   * Broadcast error message to all clients
   */
  broadcastError(error: string, recoverable: boolean = true): void {
    const message: OverlayMessage = {
      type: OverlayMessageType.ERROR,
      timestamp: Date.now(),
      data: {
        error,
        recoverable,
      },
    };

    this.broadcast(message);
  }

  /**
   * Get number of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Get client list
   */
  getClients(): Client[] {
    return Array.from(this.clients.values());
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.stop();
    this.removeAllListeners();
  }

  // ===== PRIVATE METHODS =====

  /**
   * Handle new client connection
   */
  private handleConnection(socket: WebSocket): void {
    const clientId = `client-${this.nextClientId++}`;

    const client: Client = {
      id: clientId,
      socket,
      connectedAt: Date.now(),
    };

    this.clients.set(clientId, client);

    console.log(`[OverlayServer] Client connected: ${clientId} (total: ${this.clients.size})`);

    // Set up socket event handlers
    socket.on('message', (data: WebSocket.Data) => {
      this.handleMessage(client, data);
    });

    socket.on('close', () => {
      this.handleDisconnect(client);
    });

    socket.on('error', (error: Error) => {
      console.error(`[OverlayServer] Client ${clientId} error:`, error);
    });

    socket.on('pong', () => {
      client.lastPing = Date.now();
    });

    this.emit('client-connected', client);
  }

  /**
   * Handle client disconnect
   */
  private handleDisconnect(client: Client): void {
    this.clients.delete(client.id);

    console.log(`[OverlayServer] Client disconnected: ${client.id} (remaining: ${this.clients.size})`);

    this.emit('client-disconnected', client);
  }

  /**
   * Handle message from client
   */
  private handleMessage(client: Client, data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString());
      this.emit('client-message', { client, message });
    } catch (error) {
      console.error(`[OverlayServer] Failed to parse message from ${client.id}:`, error);
    }
  }

  /**
   * Broadcast message to all connected clients
   */
  private broadcast(message: OverlayMessage): void {
    const messageStr = JSON.stringify(message);
    let sentCount = 0;
    let failedCount = 0;

    for (const client of this.clients.values()) {
      try {
        if (client.socket.readyState === WebSocket.OPEN) {
          client.socket.send(messageStr);
          sentCount++;
        }
      } catch (error) {
        console.error(`[OverlayServer] Failed to send to ${client.id}:`, error);
        failedCount++;
      }
    }

    if (sentCount > 0) {
      this.emit('broadcast', { messageType: message.type, sentCount, failedCount });
    }
  }

  /**
   * Start ping interval
   */
  private startPingInterval(): void {
    if (this.pingTimer) {
      return; // Already started
    }

    this.pingTimer = setInterval(() => {
      this.pingClients();
    }, this.pingInterval);
  }

  /**
   * Ping all clients
   */
  private pingClients(): void {
    const staleClients: string[] = [];

    for (const client of this.clients.values()) {
      try {
        if (client.socket.readyState === WebSocket.OPEN) {
          client.socket.ping();
        } else {
          // Client socket is not open, mark for removal
          staleClients.push(client.id);
        }
      } catch (error) {
        console.error(`[OverlayServer] Failed to ping ${client.id}:`, error);
        staleClients.push(client.id);
      }
    }

    // Remove stale clients
    for (const clientId of staleClients) {
      const client = this.clients.get(clientId);
      if (client) {
        try {
          client.socket.close();
        } catch (err) {
          // Ignore
        }
        this.clients.delete(clientId);
        console.log(`[OverlayServer] Removed stale client: ${clientId}`);
      }
    }
  }
}
