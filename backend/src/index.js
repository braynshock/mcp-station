/**
 * MCP Station — Host Backend
 * Manages MCP server processes, exposes a multiplexed SSE endpoint,
 * and serves the management UI.
 */

import express from 'express';
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);

const PORT = parseInt(process.env.PORT || '3000');
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'changeme';
const CONFIG_FILE = join(DATA_DIR, 'config.json');

// ─── Ensure data directory ────────────────────────────────────────────────────
mkdirSync(DATA_DIR, { recursive: true });

// ─── Config persistence ───────────────────────────────────────────────────────
function loadConfig() {
  if (!existsSync(CONFIG_FILE)) {
    const defaults = { servers: [], agents: [] };
    writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
}

function saveConfig(cfg) {
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();

// ─── Process registry ─────────────────────────────────────────────────────────
const processes = new Map(); // id -> { proc, logs, status, restartCount, restartTimer, pendingRequests, nextId, stdoutBuf, initialized }
const sseClients = new Set(); // connected UI SSE clients

const MAX_RESTARTS = 5;
const RESTART_DELAYS = [5000, 10000, 20000, 40000, 60000]; // exponential backoff (ms)

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

function appendLog(serverId, line) {
  const entry = processes.get(serverId);
  if (entry) {
    const log = { ts: new Date().toISOString(), line };
    entry.logs.push(log);
    if (entry.logs.length > 500) entry.logs.shift(); // ring buffer
    broadcast('log', { serverId, ...log });
  }
}

// ─── Endpoint traffic log ─────────────────────────────────────────────────────
// Captures inbound calls and outbound results for /mcp/sse and /mcp endpoints.
// Uses a synthetic serverId so the UI can filter it like any other log source.
const ENDPOINT_LOG_ID = '__endpoint__';
const endpointLogs = []; // { ts, line }

function appendEndpointLog(line) {
  const log = { ts: new Date().toISOString(), line };
  endpointLogs.push(log);
  if (endpointLogs.length > 500) endpointLogs.shift();
  broadcast('log', { serverId: ENDPOINT_LOG_ID, ...log });
}

// ─── Calls today counter ──────────────────────────────────────────────────────
let callsToday = 0;
let callsTodayDate = new Date().toDateString();

function recordToolCall() {
  const today = new Date().toDateString();
  if (today !== callsTodayDate) {
    callsToday = 0;
    callsTodayDate = today;
  }
  callsToday++;
  broadcast('stats', { callsToday });
}

// ─── MCP JSON-RPC over stdio ───────────────────────────────────────────────────

// Global tool-routing map: toolName -> serverId (rebuilt on demand)
const mcpToolMap = new Map();

/**
 * Send a JSON-RPC request to a running stdio MCP server and await its response.
 */
function mcpRequest(serverId, method, params, timeoutMs = 30000) {
  const entry = processes.get(serverId);
  if (!entry?.proc) return Promise.reject(new Error('Server not running'));
  const id = entry.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      entry.pendingRequests.delete(id);
      reject(new Error(`MCP timeout waiting for ${method}`));
    }, timeoutMs);
    entry.pendingRequests.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject:  (e) => { clearTimeout(timer); reject(e);  },
    });
    entry.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

/**
 * Perform the MCP initialize handshake with a server and cache its tool list.
 */
async function initializeMcpServer(serverId) {
  const entry = processes.get(serverId);
  if (!entry || entry.initialized) return;
  try {
    await mcpRequest(serverId, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-station', version: '0.1.0' },
    });
    // Send initialized notification (no response expected)
    entry.proc.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
    );
    entry.initialized = true;
    // Eagerly populate the global tool map
    const r = await mcpRequest(serverId, 'tools/list', {});
    for (const t of r?.tools ?? []) mcpToolMap.set(t.name, serverId);
    broadcast('stats', { totalTools: mcpToolMap.size });
    appendLog(serverId, `[station] MCP ready — ${r?.tools?.length ?? 0} tool(s) registered`);
  } catch (err) {
    appendLog(serverId, `[station] MCP init failed: ${err.message}`);
  }
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────
function buildCommand(server) {
  switch (server.type) {
    case 'npm':
      return { cmd: 'npx', args: ['-y', server.command, ...(server.args || [])] };
    case 'docker':
      return { cmd: 'docker', args: ['run', '--rm', '-i', server.command, ...(server.args || [])] };
    case 'local':
      return { cmd: server.command, args: server.args || [] };
    default:
      throw new Error(`Unknown server type: ${server.type}`);
  }
}

function startServer(server) {
  if (server.transport === 'remote') {
    // Remote SSE — just mark as connected, no local process
    processes.set(server.id, {
      proc: null, logs: [], status: 'running',
      pendingRequests: new Map(), nextId: 1, stdoutBuf: '', initialized: false,
    });
    broadcast('status', { serverId: server.id, status: 'running' });
    return;
  }

  const { cmd, args } = buildCommand(server);
  const env = { ...process.env, ...(server.env || {}) };

  const proc = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });

  processes.set(server.id, {
    proc, logs: [], status: 'starting',
    pendingRequests: new Map(), nextId: 1, stdoutBuf: '', initialized: false,
    restartCount: 0, restartTimer: null,
  });

  // ── Stdout: try to parse JSON-RPC first, fall back to logging ──────────────
  proc.stdout.on('data', (d) => {
    const entry = processes.get(server.id);
    if (!entry) return;
    entry.stdoutBuf += d.toString();
    const lines = entry.stdoutBuf.split('\n');
    entry.stdoutBuf = lines.pop(); // keep incomplete trailing fragment
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let json = null;
      try { json = JSON.parse(line); } catch (_) {}
      if (json?.jsonrpc && json.id != null) {
        const cb = entry.pendingRequests.get(json.id);
        if (cb) {
          entry.pendingRequests.delete(json.id);
          json.error
            ? cb.reject(Object.assign(new Error(json.error.message ?? 'MCP error'), json.error))
            : cb.resolve(json.result);
          continue; // don't log internal JSON-RPC responses
        }
      }
      appendLog(server.id, raw);
    }
  });

  proc.stderr.on('data', (d) => appendLog(server.id, d.toString().trimEnd()));

  proc.on('spawn', () => {
    const entry = processes.get(server.id);
    if (entry) entry.status = 'running';
    broadcast('status', { serverId: server.id, status: 'running' });
    appendLog(server.id, `[station] Process started (pid ${proc.pid})`);
    // Start MCP handshake in the background; don't block startup
    initializeMcpServer(server.id).catch(() => {});
  });

  proc.on('close', (code) => {
    const entry = processes.get(server.id);
    if (!entry) return;
    const wasManualStop = entry.stoppedManually === true;
    entry.status = 'stopped';
    entry.proc = null;
    entry.initialized = false;
    // Reject any outstanding MCP requests
    for (const [, cb] of entry.pendingRequests) cb.reject(new Error('Server stopped'));
    entry.pendingRequests.clear();
    // Remove this server's tools from the global routing map
    for (const [toolName, sid] of mcpToolMap) {
      if (sid === server.id) mcpToolMap.delete(toolName);
    }
    broadcast('status', { serverId: server.id, status: 'stopped', code });
    appendLog(server.id, `[station] Process exited with code ${code}`);

    // Auto-restart on non-zero exit if server is still enabled and not manually stopped
    const cfg = config.servers.find((s) => s.id === server.id);
    if (!wasManualStop && cfg && cfg.enabled !== false && code !== 0) {
      const count = entry.restartCount || 0;
      if (count < MAX_RESTARTS) {
        const delay = RESTART_DELAYS[Math.min(count, RESTART_DELAYS.length - 1)];
        entry.restartCount = count + 1;
        entry.status = 'restarting';
        broadcast('status', { serverId: server.id, status: 'restarting' });
        appendLog(server.id, `[station] Restart ${count + 1}/${MAX_RESTARTS} in ${delay / 1000}s…`);
        entry.restartTimer = setTimeout(() => {
          const current = processes.get(server.id);
          if (current && current.status === 'restarting') startServer(cfg);
        }, delay);
      } else {
        appendLog(server.id, `[station] Max restarts reached — server marked offline`);
        broadcast('status', { serverId: server.id, status: 'error' });
        entry.status = 'error';
        entry.restartCount = 0;
      }
    } else if (code === 0) {
      entry.restartCount = 0;
    }
  });

  proc.on('error', (err) => {
    const entry = processes.get(server.id);
    if (entry) entry.status = 'error';
    broadcast('status', { serverId: server.id, status: 'error', error: err.message });
    appendLog(server.id, `[station] Error: ${err.message}`);
  });
}

function stopServer(serverId) {
  const entry = processes.get(serverId);
  if (!entry) return;
  // Cancel any pending auto-restart
  if (entry.restartTimer) {
    clearTimeout(entry.restartTimer);
    entry.restartTimer = null;
  }
  entry.restartCount = 0;
  entry.stoppedManually = true;
  // Reject any outstanding MCP requests
  for (const [, cb] of (entry.pendingRequests ?? new Map())) cb.reject(new Error('Server stopped'));
  entry.pendingRequests?.clear();
  entry.initialized = false;
  // Remove tools from global routing map
  for (const [toolName, sid] of mcpToolMap) {
    if (sid === serverId) mcpToolMap.delete(toolName);
  }
  if (entry.proc) {
    entry.proc.kill('SIGTERM');
  }
  entry.status = 'stopped';
  broadcast('status', { serverId, status: 'stopped' });
}

// Auto-start enabled servers on boot
for (const server of config.servers) {
  if (server.enabled !== false) {
    startServer(server);
  }
}

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Serve UI
app.use(express.static(join(ROOT, 'public')));

// Auth middleware for API routes
function requireAuth(req, res, next) {
  if (AUTH_TOKEN === 'changeme') return next(); // dev mode - no auth
  const header = req.headers['authorization']?.replace('Bearer ', '');
  const query = req.query.token; // used by EventSource (no custom header support)
  if (header !== AUTH_TOKEN && query !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '0.1.0', servers: config.servers.length });
});

// ─── SSE stream (live UI events) ──────────────────────────────────────────────
app.get('/api/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);
  res.write('event: connected\ndata: {}\n\n');

  req.on('close', () => sseClients.delete(res));
});

// ─── Servers API ──────────────────────────────────────────────────────────────
app.get('/api/servers', requireAuth, (req, res) => {
  const enriched = config.servers.map((s) => ({
    ...s,
    status: processes.get(s.id)?.status || 'stopped',
    logCount: processes.get(s.id)?.logs.length || 0,
  }));
  res.json(enriched);
});

app.post('/api/servers', requireAuth, (req, res) => {
  const server = { id: randomUUID(), enabled: true, ...req.body };
  config.servers.push(server);
  saveConfig(config);
  startServer(server);
  res.status(201).json(server);
});

app.get('/api/servers/:id', requireAuth, (req, res) => {
  const server = config.servers.find((s) => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  res.json({ ...server, status: processes.get(server.id)?.status || 'stopped' });
});

app.patch('/api/servers/:id', requireAuth, (req, res) => {
  const idx = config.servers.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  config.servers[idx] = { ...config.servers[idx], ...req.body };
  saveConfig(config);
  res.json(config.servers[idx]);
});

app.delete('/api/servers/:id', requireAuth, (req, res) => {
  stopServer(req.params.id);
  processes.delete(req.params.id);
  config.servers = config.servers.filter((s) => s.id !== req.params.id);
  saveConfig(config);
  res.status(204).end();
});

app.post('/api/servers/:id/start', requireAuth, (req, res) => {
  const server = config.servers.find((s) => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  startServer(server);
  res.json({ status: 'starting' });
});

app.post('/api/servers/:id/stop', requireAuth, (req, res) => {
  stopServer(req.params.id);
  res.json({ status: 'stopped' });
});

app.get('/api/servers/:id/logs', requireAuth, (req, res) => {
  const entry = processes.get(req.params.id);
  res.json(entry?.logs || []);
});

app.get('/api/endpoint-logs', requireAuth, (req, res) => {
  res.json(endpointLogs);
});

// ─── Agents API ───────────────────────────────────────────────────────────────
app.get('/api/agents', requireAuth, (req, res) => res.json(config.agents));

app.post('/api/agents', requireAuth, (req, res) => {
  const agent = { id: randomUUID(), ...req.body };
  config.agents.push(agent);
  saveConfig(config);
  res.status(201).json(agent);
});

app.patch('/api/agents/:id', requireAuth, (req, res) => {
  const idx = config.agents.findIndex((a) => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  config.agents[idx] = { ...config.agents[idx], ...req.body };
  saveConfig(config);
  res.json(config.agents[idx]);
});

app.delete('/api/agents/:id', requireAuth, (req, res) => {
  config.agents = config.agents.filter((a) => a.id !== req.params.id);
  saveConfig(config);
  res.status(204).end();
});

// ─── Stats API ────────────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, (req, res) => {
  const running = [...processes.values()].filter((p) => p.status === 'running').length;
  const today = new Date().toDateString();
  const todayCalls = today !== callsTodayDate ? 0 : callsToday;
  res.json({
    totalServers: config.servers.length,
    runningServers: running,
    totalAgents: config.agents.length,
    sseClients: sseClients.size,
    totalTools: mcpToolMap.size,
    callsToday: todayCalls,
  });
});

// ─── Marketplace (proxies MCP Registry) ───────────────────────────────────────
let _mktCache = null, _mktCacheTs = 0;

app.get('/api/marketplace', requireAuth, async (req, res) => {
  const { cursor = '' } = req.query;
  const now = Date.now();
  if (!cursor && _mktCache && now - _mktCacheTs < 30 * 60 * 1000) {
    return res.json(_mktCache);
  }
  try {
    const params = new URLSearchParams({ limit: '50' });
    if (cursor) params.set('cursor', cursor);
    const r = await fetch(`https://registry.modelcontextprotocol.io/v0/servers?${params}`);
    if (!r.ok) throw new Error(`Registry HTTP ${r.status}`);
    const data = await r.json();
    const items = (data.servers || []).map(entry => {
      const s = entry.server;
      if (!s) return null;
      const pkg = s.packages?.[0];
      const rem = s.remotes?.[0];
      let type, command;
      if (pkg) {
        type = pkg.registryType === 'oci' ? 'docker' : (pkg.registryType || 'npm');
        command = pkg.identifier;
      } else if (rem) {
        type = 'remote';
        command = rem.url;
      } else return null;
      const rawName = s.title || s.name.split('/').pop();
      return {
        name: rawName.replace(/-mcp(-server)?$/i, '').replace(/-/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase()).trim() || rawName,
        icon: s.icons?.[0]?.src || null,
        desc: s.description || '',
        type,
        command,
        githubUrl: s.repository?.url || null,
        websiteUrl: s.websiteUrl || null,
      };
    }).filter(Boolean);
    const result = { items, nextCursor: data.metadata?.nextCursor || null };
    if (!cursor) { _mktCache = result; _mktCacheTs = now; }
    res.json(result);
  } catch (err) {
    console.error('[marketplace]', err.message);
    res.status(503).json({ error: err.message, items: [], nextCursor: null });
  }
});

// ─── MCP SSE transport (for LiteLLM and other MCP clients) ───────────────────
//
// Implements the MCP SSE transport spec:
//   GET  /mcp/sse          → open SSE stream; server sends "endpoint" event
//   POST /mcp/messages     → client sends JSON-RPC; responses arrive via SSE
//
// This is a multiplexing gateway: all running stdio-based servers are
// aggregated behind a single endpoint.

const mcpSessions = new Map(); // sessionId -> SSE response object

/**
 * Collect tools from all running stdio servers.
 * Updates the global mcpToolMap and returns the aggregated tool list.
 */
async function collectAllTools() {
  const tools = [];
  for (const server of config.servers) {
    if (server.transport === 'remote') continue;
    const entry = processes.get(server.id);
    if (!entry || entry.status !== 'running') continue;
    try {
      if (!entry.initialized) await initializeMcpServer(server.id);
      const r = await mcpRequest(server.id, 'tools/list', {});
      for (const t of r?.tools ?? []) {
        mcpToolMap.set(t.name, server.id);
        tools.push(t);
      }
    } catch (err) {
      console.error(`[mcp] tools/list failed for server ${server.id}:`, err.message);
    }
  }
  return tools;
}

// GET /mcp/sse — establish SSE session, reply with message endpoint URL
app.get('/mcp/sse', requireAuth, (req, res) => {
  const sessionId = randomUUID();
  const shortId = sessionId.slice(0, 8);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  mcpSessions.set(sessionId, res);
  appendEndpointLog(`[mcp/sse] client connected, session=${shortId}`);

  // Tell the client where to POST JSON-RPC messages
  res.write(`event: endpoint\ndata: /mcp/messages?sessionId=${sessionId}\n\n`);

  req.on('close', () => {
    mcpSessions.delete(sessionId);
    appendEndpointLog(`[mcp/sse] client disconnected, session=${shortId}`);
  });
});

// POST /mcp/messages — receive JSON-RPC from client, route to subprocess, respond via SSE
app.post('/mcp/messages', async (req, res) => {
  const { sessionId } = req.query;
  const sseRes = mcpSessions.get(sessionId);
  if (!sseRes) return res.status(404).json({ error: 'Session not found' });

  // Acknowledge receipt immediately (MCP SSE transport requires 202)
  res.status(202).end();

  const msg = req.body;
  if (!msg || !msg.method) return;

  const shortId = sessionId?.slice(0, 8) ?? '?';
  const isNotification = msg.id === undefined;

  const send = (payload) =>
    sseRes.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);

  const sendError = (id, code, message) =>
    send({ jsonrpc: '2.0', id, error: { code, message } });

  try {
    switch (msg.method) {
      // ── Notifications (no response) ────────────────────────────────────────
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/progress':
        appendEndpointLog(`[mcp/sse] ← ${msg.method} (notification), session=${shortId}`);
        return;

      // ── Handshake ──────────────────────────────────────────────────────────
      case 'initialize': {
        const clientName = msg.params?.clientInfo?.name ?? 'unknown';
        appendEndpointLog(`[mcp/sse] ← initialize (client: ${clientName}), session=${shortId}`);
        const result = {
          protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'mcp-station', version: '0.1.0' },
        };
        send({ jsonrpc: '2.0', id: msg.id, result });
        appendEndpointLog(`[mcp/sse] → initialize ok, session=${shortId}`);
        return;
      }

      // ── Tool discovery ─────────────────────────────────────────────────────
      case 'tools/list': {
        appendEndpointLog(`[mcp/sse] ← tools/list, session=${shortId}`);
        const tools = await collectAllTools();
        send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
        appendEndpointLog(`[mcp/sse] → tools/list ok (${tools.length} tool${tools.length === 1 ? '' : 's'}), session=${shortId}`);
        return;
      }

      // ── Tool invocation ────────────────────────────────────────────────────
      case 'tools/call': {
        const toolName = msg.params?.name;
        appendEndpointLog(`[mcp/sse] ← tools/call: ${toolName}, session=${shortId}`);
        let serverId = mcpToolMap.get(toolName);

        // Cache miss → refresh tool map and try once more
        if (!serverId) {
          await collectAllTools();
          serverId = mcpToolMap.get(toolName);
        }
        if (!serverId) {
          const errMsg = `Tool not found: ${toolName}`;
          sendError(msg.id, -32601, errMsg);
          appendEndpointLog(`[mcp/sse] → tools/call error: ${errMsg}, session=${shortId}`);
          return;
        }

        const result = await mcpRequest(serverId, 'tools/call', msg.params);
        send({ jsonrpc: '2.0', id: msg.id, result });
        recordToolCall();
        appendEndpointLog(`[mcp/sse] → tools/call ok, session=${shortId}`);
        return;
      }

      // ── Ping ───────────────────────────────────────────────────────────────
      case 'ping':
        appendEndpointLog(`[mcp/sse] ← ping, session=${shortId}`);
        send({ jsonrpc: '2.0', id: msg.id, result: {} });
        appendEndpointLog(`[mcp/sse] → ping ok, session=${shortId}`);
        return;

      // ── Unknown method ─────────────────────────────────────────────────────
      default:
        appendEndpointLog(`[mcp/sse] ← ${msg.method}, session=${shortId}`);
        if (!isNotification) {
          sendError(msg.id, -32601, `Method not found: ${msg.method}`);
          appendEndpointLog(`[mcp/sse] → ${msg.method} error: Method not found, session=${shortId}`);
        }
    }
  } catch (err) {
    if (!isNotification) {
      sendError(msg.id, -32603, err.message);
      appendEndpointLog(`[mcp/sse] → ${msg.method} error: ${err.message}, session=${shortId}`);
    }
  }
});

// ─── MCP Streamable HTTP transport (MCP 2025-03-26, for OpenWebUI etc.) ───────
//
// Single endpoint:
//   POST   /mcp  → JSON-RPC in, direct JSON response out (or 202 for notifications)
//   GET    /mcp  → optional SSE stream for server-initiated messages
//   DELETE /mcp  → terminate session
//
// Session lifecycle:
//   1. Client POSTs initialize (no Mcp-Session-Id) → server creates session,
//      returns Mcp-Session-Id header in response.
//   2. All subsequent requests include Mcp-Session-Id header.
//   3. Client DELETEs /mcp to end the session.

const httpSessions = new Map(); // sessionId -> { sseRes: null | Response }

// POST /mcp — main JSON-RPC handler
app.post('/mcp', requireAuth, async (req, res) => {
  const msg = req.body;
  if (!msg || !msg.method) return res.status(400).json({ error: 'Invalid JSON-RPC request' });

  const sessionId = req.headers['mcp-session-id'];
  const isNotification = msg.id === undefined;

  // initialize — create a new session (no existing session required)
  if (msg.method === 'initialize') {
    const newSessionId = randomUUID();
    const shortId = newSessionId.slice(0, 8);
    const clientName = msg.params?.clientInfo?.name ?? 'unknown';
    appendEndpointLog(`[mcp] ← initialize (client: ${clientName})`);
    httpSessions.set(newSessionId, { sseRes: null });
    res
      .set('Mcp-Session-Id', newSessionId)
      .json({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'mcp-station', version: '0.1.0' },
        },
      });
    appendEndpointLog(`[mcp] → initialize ok, session=${shortId}`);
    return;
  }

  const shortId = sessionId?.slice(0, 8) ?? '?';

  // All other methods require a valid session
  if (!sessionId) return res.status(400).json({ error: 'Missing Mcp-Session-Id header' });
  if (!httpSessions.has(sessionId)) return res.status(404).json({ error: 'Session not found' });

  // Notifications (no id) — acknowledge and return
  if (isNotification) {
    appendEndpointLog(`[mcp] ← ${msg.method} (notification), session=${shortId}`);
    return res.status(202).end();
  }

  try {
    switch (msg.method) {
      case 'tools/list': {
        appendEndpointLog(`[mcp] ← tools/list, session=${shortId}`);
        const tools = await collectAllTools();
        res.json({ jsonrpc: '2.0', id: msg.id, result: { tools } });
        appendEndpointLog(`[mcp] → tools/list ok (${tools.length} tool${tools.length === 1 ? '' : 's'}), session=${shortId}`);
        return;
      }

      case 'tools/call': {
        const toolName = msg.params?.name;
        appendEndpointLog(`[mcp] ← tools/call: ${toolName}, session=${shortId}`);
        let serverId = mcpToolMap.get(toolName);
        if (!serverId) {
          await collectAllTools();
          serverId = mcpToolMap.get(toolName);
        }
        if (!serverId) {
          const errMsg = `Tool not found: ${toolName}`;
          res.json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: errMsg } });
          appendEndpointLog(`[mcp] → tools/call error: ${errMsg}, session=${shortId}`);
          return;
        }
        const result = await mcpRequest(serverId, 'tools/call', msg.params);
        res.json({ jsonrpc: '2.0', id: msg.id, result });
        recordToolCall();
        appendEndpointLog(`[mcp] → tools/call ok, session=${shortId}`);
        return;
      }

      case 'ping': {
        appendEndpointLog(`[mcp] ← ping, session=${shortId}`);
        res.json({ jsonrpc: '2.0', id: msg.id, result: {} });
        appendEndpointLog(`[mcp] → ping ok, session=${shortId}`);
        return;
      }

      default: {
        appendEndpointLog(`[mcp] ← ${msg.method}, session=${shortId}`);
        res.json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
        appendEndpointLog(`[mcp] → ${msg.method} error: Method not found, session=${shortId}`);
        return;
      }
    }
  } catch (err) {
    res.json({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } });
    appendEndpointLog(`[mcp] → ${msg.method} error: ${err.message}, session=${shortId}`);
  }
});

// GET /mcp — optional SSE stream for server-initiated messages
app.get('/mcp', requireAuth, (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !httpSessions.has(sessionId)) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const shortId = sessionId.slice(0, 8);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(': connected\n\n');

  const session = httpSessions.get(sessionId);
  session.sseRes = res;
  appendEndpointLog(`[mcp] SSE stream opened, session=${shortId}`);
  req.on('close', () => {
    if (session.sseRes === res) session.sseRes = null;
    appendEndpointLog(`[mcp] SSE stream closed, session=${shortId}`);
  });
});

// DELETE /mcp — terminate session
app.delete('/mcp', requireAuth, (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId) {
    appendEndpointLog(`[mcp] session terminated, session=${sessionId.slice(0, 8)}`);
    httpSessions.delete(sessionId);
  }
  res.status(200).end();
});

// ─── Start ────────────────────────────────────────────────────────────────────
const server = createServer(app);
server.listen(PORT, () => {
  console.log(`[mcp-station] Host running on http://0.0.0.0:${PORT}`);
  console.log(`[mcp-station] Data dir: ${DATA_DIR}`);
  console.log(`[mcp-station] Auth: ${AUTH_TOKEN === 'changeme' ? 'DISABLED (dev mode)' : 'enabled'}`);
  console.log(`[mcp-station] MCP SSE endpoint:         http://0.0.0.0:${PORT}/mcp/sse`);
  console.log(`[mcp-station] MCP Streamable HTTP:      http://0.0.0.0:${PORT}/mcp`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[mcp-station] Shutting down...');
  for (const [id] of processes) stopServer(id);
  server.close(() => process.exit(0));
});
