# MCP Station

A self-hosted MCP (Model Context Protocol) server manager with a web UI — designed to run as a custom app on **TrueNAS Fangtooth**.

Think Docker Desktop's MCP Toolkit, but self-hosted on your NAS.

![MCP Station UI](./docs/screenshot.png)

---

## Features

- **Web UI** — add, start, stop, and monitor MCP servers from a browser
- **Live updates** — Server-Sent Events stream status changes and logs in real time
- **Agent composer** — group servers into named agents with a single endpoint
- **Marketplace** — browse and one-click install from the official MCP Registry
- **Tools explorer** — view all tools exposed by your running servers
- **Endpoint logs** — inspect MCP traffic in real time
- **Auto-restart** — failed servers restart automatically with exponential backoff
- **Dual transport** — supports both legacy SSE (`/mcp/sse`) and the new Streamable HTTP (`/mcp`) transport
- **TrueNAS-native** — runs as a Docker Compose custom app; config persists on your dataset
- **REST API** — everything the UI does is available via API

---

## Quick Start

### On TrueNAS Fangtooth

1. Go to **Apps → Custom App → Install**
2. Paste the contents of `compose.yaml` into the compose editor
3. Set the environment variables:
   - `AUTH_TOKEN` — a secret token for API access
   - `DATA_PATH` — path to a TrueNAS dataset, e.g. `/mnt/tank/mcp-station`
4. Click **Install** — the app will be available at `http://truenas.local:3000`

### Local Development

```bash
git clone https://github.com/braynshock/mcp-station
cd mcp-station

cp .env.example .env
# Edit .env as needed

cd backend
npm install
npm run dev
```

Open http://localhost:3000

---

## Configuration

All configuration is stored in `config.json` inside `DATA_PATH`. The server hot-reloads config on restart.

See `backend/config/config.example.json` for the full schema.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the UI and API listen on |
| `AUTH_TOKEN` | `changeme` | Bearer token for API auth (auth disabled when set to `changeme`) |
| `DATA_PATH` | `./data` | Where config and logs are persisted |
| `FILES_PATH` | _(optional)_ | Path for a filesystem MCP sidecar container |

---

## Adding MCP Servers

### Via the UI

Click **Add Server** and fill in:
- **Name** — display name
- **Type** — `npm`, `docker`, `local`, or `remote`
- **Command** — the npm package, Docker image, binary path, or SSE/HTTP URL
- **Env** — JSON object of environment variables (API keys etc.)
- **Transport** — `stdio` (default for local), `sse`, or `http`

### Via the API

```bash
curl -X POST http://localhost:3000/api/servers \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Brave Search",
    "type": "npm",
    "command": "@modelcontextprotocol/server-brave-search",
    "transport": "stdio",
    "env": { "BRAVE_API_KEY": "sk-..." }
  }'
```

---

## MCP Endpoints

### Streamable HTTP (recommended — MCP spec 2025-03-26)

Compatible with OpenWebUI and any client supporting the latest MCP spec:

```
POST http://<host>:3000/mcp
GET  http://<host>:3000/mcp   (optional SSE stream)
```

### Legacy SSE Transport

For LiteLLM, Claude Desktop, Cursor, and older MCP clients:

```
http://<host>:3000/mcp/sse
```

Both endpoints aggregate tools from all running `stdio`-based servers into a single multiplexed connection.

**LiteLLM config example:**
```yaml
mcp_servers:
  - name: mcp-station
    url: http://192.168.0.160:3000/mcp/sse
    # If AUTH_TOKEN is set:
    # headers:
    #   Authorization: "Bearer <your-token>"
    # or append ?token=<your-token> to the URL
```

---

## REST API

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/api/stats` | Stats summary (servers, tools, agents, calls today) |
| `GET` | `/api/servers` | List all servers |
| `POST` | `/api/servers` | Register a new server |
| `GET` | `/api/servers/:id` | Get a server |
| `PATCH` | `/api/servers/:id` | Update a server |
| `DELETE` | `/api/servers/:id` | Remove a server |
| `POST` | `/api/servers/:id/start` | Start a server |
| `POST` | `/api/servers/:id/stop` | Stop a server |
| `GET` | `/api/servers/:id/logs` | Get server logs |
| `GET` | `/api/tools` | List all tools from running servers |
| `GET` | `/api/agents` | List agents |
| `POST` | `/api/agents` | Create an agent |
| `PATCH` | `/api/agents/:id` | Update an agent |
| `DELETE` | `/api/agents/:id` | Delete an agent |
| `GET` | `/api/marketplace` | Browse the MCP Registry (supports cursor pagination) |
| `GET` | `/api/endpoint-logs` | Get MCP endpoint traffic logs |
| `GET` | `/api/events` | SSE stream of live UI events |
| `POST` | `/mcp` | MCP Streamable HTTP — JSON-RPC handler |
| `GET` | `/mcp` | MCP Streamable HTTP — optional SSE stream |
| `DELETE` | `/mcp` | MCP Streamable HTTP — terminate session |
| `GET` | `/mcp/sse` | MCP legacy SSE transport |
| `POST` | `/mcp/messages` | MCP legacy SSE — message handler |

All routes except `/health` and `/mcp/messages` require `Authorization: Bearer <AUTH_TOKEN>` (or `?token=<AUTH_TOKEN>`) when `AUTH_TOKEN` is set to a non-default value.

---

## Docker Image

A Docker image is automatically built and published to GitHub Container Registry on every push to `main`:

```bash
docker pull ghcr.io/braynshock/mcp-station:latest
```

---

## Architecture

```
┌─────────────────────────────────────────┐
│            TrueNAS Fangtooth            │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │      mcp-station container      │    │
│  │                                 │    │
│  │  Express (port 3000)            │    │
│  │  ├── GET /          → Web UI    │    │
│  │  ├── /api/*         → REST API  │    │
│  │  ├── /api/events    → UI SSE    │    │
│  │  ├── POST /mcp      → HTTP MCP  │    │
│  │  ├── GET /mcp/sse   → SSE MCP   │    │
│  │  └── POST /mcp/messages → MCP   │    │
│  │                                 │    │
│  │  Process Manager (JSON-RPC)     │    │
│  │  ├── server-filesystem (stdio)  │    │
│  │  ├── server-brave-search (stdio)│    │
│  │  └── github-mcp (docker)        │    │
│  └────────────────┬────────────────┘    │
│                   │ :3000               │
└───────────────────┼─────────────────────┘
                    │
          Claude Desktop / Cursor / LiteLLM / OpenWebUI
          (connects via /mcp or /mcp/sse)
```

---

## Roadmap

- [x] MCP multiplexing — single endpoint for all running servers
- [x] Marketplace — one-click install from MCP Registry
- [x] Tools explorer — view all available tools across servers
- [x] MCP Streamable HTTP transport (2025-03-26 spec, OpenWebUI compatible)
- [x] Endpoint logs — inspect MCP traffic
- [ ] Tool-level access control per agent
- [ ] OAuth / multi-user support
- [ ] Import/export config
- [ ] One-click server updates

---

## Contributing

PRs welcome. Open an issue first for large changes.

---

## License

MIT
