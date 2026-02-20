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
const processes = new Map(); // id -> { proc, logs, status }
const sseClients = new Set(); // connected SSE clients

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
    processes.set(server.id, { proc: null, logs: [], status: 'running' });
    broadcast('status', { serverId: server.id, status: 'running' });
    return;
  }

  const { cmd, args } = buildCommand(server);
  const env = { ...process.env, ...(server.env || {}) };

  const proc = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });

  processes.set(server.id, { proc, logs: [], status: 'starting' });

  proc.stdout.on('data', (d) => appendLog(server.id, d.toString().trimEnd()));
  proc.stderr.on('data', (d) => appendLog(server.id, d.toString().trimEnd()));

  proc.on('spawn', () => {
    const entry = processes.get(server.id);
    if (entry) entry.status = 'running';
    broadcast('status', { serverId: server.id, status: 'running' });
    appendLog(server.id, `[station] Process started (pid ${proc.pid})`);
  });

  proc.on('close', (code) => {
    const entry = processes.get(server.id);
    if (entry) entry.status = 'stopped';
    broadcast('status', { serverId: server.id, status: 'stopped', code });
    appendLog(server.id, `[station] Process exited with code ${code}`);
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

// ─── SSE stream (live events) ─────────────────────────────────────────────────
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
  res.json({
    totalServers: config.servers.length,
    runningServers: running,
    totalAgents: config.agents.length,
    sseClients: sseClients.size,
  });
});

// ─── Marketplace (proxies MCP Registry) ───────────────────────────────────────
let _mktCache = null, _mktCacheTs = 0;

app.get('/api/marketplace', requireAuth, async (req, res) => {
  const { q = '', cursor = '' } = req.query;
  const now = Date.now();
  if (!q && !cursor && _mktCache && now - _mktCacheTs < 30 * 60 * 1000) {
    return res.json(_mktCache);
  }
  try {
    const params = new URLSearchParams({ limit: '50' });
    if (q) params.set('q', q);
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
    if (!q && !cursor) { _mktCache = result; _mktCacheTs = now; }
    res.json(result);
  } catch (err) {
    console.error('[marketplace]', err.message);
    res.status(503).json({ error: err.message, items: [], nextCursor: null });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const server = createServer(app);
server.listen(PORT, () => {
  console.log(`[mcp-station] Host running on http://0.0.0.0:${PORT}`);
  console.log(`[mcp-station] Data dir: ${DATA_DIR}`);
  console.log(`[mcp-station] Auth: ${AUTH_TOKEN === 'changeme' ? 'DISABLED (dev mode)' : 'enabled'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[mcp-station] Shutting down...');
  for (const [id] of processes) stopServer(id);
  server.close(() => process.exit(0));
});
