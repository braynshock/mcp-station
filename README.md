# MCP Station 🛰

A self-hosted MCP (Model Context Protocol) server manager with a web UI — designed to run as a custom app on **TrueNAS Fangtooth**.

Think Docker Desktop's MCP Toolkit, but self-hosted on your NAS.

![MCP Station UI](./docs/screenshot.png)

---

## Features

- **Web UI** — add, start, stop, and monitor MCP servers from a browser
- **Live updates** — Server-Sent Events stream status changes and logs in real time
- **Agent composer** — group servers into named agents with a single endpoint
- **Marketplace** — one-click install of popular community MCP servers
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

All configuration is stored in `config.json` inside `DATA_PATH`. You can also edit it directly — the server hot-reloads on restart.

See `backend/config/config.example.json` for the schema.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the UI and API listen on |
| `AUTH_TOKEN` | `changeme` | Bearer token for API (disable auth in dev) |
| `DATA_PATH` | `./data` | Where config and logs are persisted |

---

## Adding MCP Servers

### Via the UI

Click **Add Server** and fill in:
- **Name** — display name
- **Type** — `npm`, `docker`, `local`, or `remote`
- **Command** — the npm package, Docker image, binary path, or SSE URL
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

## REST API

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/api/servers` | List all servers |
| `POST` | `/api/servers` | Register a new server |
| `GET` | `/api/servers/:id` | Get a server |
| `PATCH` | `/api/servers/:id` | Update a server |
| `DELETE` | `/api/servers/:id` | Remove a server |
| `POST` | `/api/servers/:id/start` | Start a server |
| `POST` | `/api/servers/:id/stop` | Stop a server |
| `GET` | `/api/servers/:id/logs` | Get server logs |
| `GET` | `/api/agents` | List agents |
| `POST` | `/api/agents` | Create an agent |
| `PATCH` | `/api/agents/:id` | Update an agent |
| `DELETE` | `/api/agents/:id` | Delete an agent |
| `GET` | `/api/events` | SSE stream of live events |
| `GET` | `/api/stats` | Stats summary |

All API routes (except `/health`) require `Authorization: Bearer <AUTH_TOKEN>` when `AUTH_TOKEN` is set.

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
│  │  └── /api/events    → SSE       │    │
│  │                                 │    │
│  │  Process Manager                │    │
│  │  ├── server-filesystem (stdio)  │    │
│  │  ├── server-brave-search (stdio)│    │
│  │  └── github-mcp (docker)        │    │
│  └────────────────┬────────────────┘    │
│                   │ :3000               │
└───────────────────┼─────────────────────┘
                    │
          Claude Desktop / Cursor
          (connects via SSE)
```

---

## Roadmap

- [ ] MCP multiplexing — expose all servers as a single SSE endpoint
- [ ] Tool-level access control per agent
- [ ] OAuth / multi-user support
- [ ] Metrics & call history dashboard
- [ ] Import/export config
- [ ] One-click server updates

---

## Contributing

PRs welcome! Open an issue first for large changes.

---

## License

MIT
