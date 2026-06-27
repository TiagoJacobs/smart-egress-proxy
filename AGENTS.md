# AGENTS.md

Engineering notes for developers and AI coding agents working on
smart-egress-proxy. End-user documentation lives in [README.md](./README.md);
this file is about how the thing is built and how to change it.

## Overview

One Docker image, one Node.js process, three components that share a single
in-memory store:

| Component | File | Port | Role |
| --- | --- | --- | --- |
| Forward proxy | `src/proxy/server.ts` | `3128` | Forwards HTTP and tunnels HTTPS (CONNECT), DIRECT or through an upstream proxy. |
| Dashboard API + SPA | `src/server/api.ts` | `443` | Express JSON API that also serves the built React app. |
| Prober | `src/prober/prober.ts` | (background) | Periodically measures every egress's health; drives `AUTO` routing. |

`src/index.ts` wires them together: `loadConfig()` → `store.initStore()` →
`createProxyServer()` + `createApiServer()` + `startProber()`, with graceful
shutdown on `SIGTERM`/`SIGINT`.

## Tech stack

- **Node.js 22 + TypeScript, ESM.** The server is run with **`tsx`**; there is no
  compile/emit step. `tsc` is used only for typechecking (`npm run typecheck`).
- **Runtime dependencies (the whole list):** `express`, `undici`, `zod`, `tsx`.
  Keep it this small; do not add dependencies without a strong reason.
- **Dashboard:** Vite + React 18, a self-contained package under `dashboard/`.

## Repository layout

```
src/
  types.ts          All shared types (the authoritative data shapes).
  util.ts           parseUpstreamUrl, buildBasicAuth, maskUrl, sanitizeConfig, parseMode, modeToString.
  config.ts         loadConfig(): SEP_CONFIG -> JSON -> zod validation + defaults -> AppConfig.
  state.ts          The shared in-memory store (single source of truth) + mode persistence.
  proxy/server.ts   createProxyServer(): the forward proxy.
  prober/prober.ts  startProber(), runProbeCycle(): the background prober.
  server/api.ts     createApiServer(): Express API + static SPA hosting.
  index.ts          Entry point that wires everything together.
dashboard/          Vite + React SPA (own package.json); builds to dashboard/dist.
Dockerfile          Multi-stage build.
config.json.example Template config (the real config.json is git-ignored).
```

## How each component works

### Config (`src/config.ts`, `src/types.ts`)

The entire configuration arrives as a JSON string in the `SEP_CONFIG` env var.
`loadConfig()` parses it, validates with a zod schema, applies every documented
default, and returns a fully-populated `AppConfig`. Invalid input throws a single
multi-line `Error` listing every problem with its path.

### Store (`src/state.ts`)

The single source of truth shared by all three components. Key methods:

- `getEgresses()`: `direct` (priority = `settings.directPriorityOrder`) plus one
  `proxy-<index>` per upstream proxy, sorted by `priorityOrder` ascending.
- `getMode()` / `setMode()`: the runtime mode; `setMode` persists it to
  `STATE_DIR/state.json` (best-effort; a read-only dir only logs a warning).
- `getHealth()` / `setEgressHealth()`: per-egress probe results.
- `resolveActiveEgress()` makes the routing decision: `DIRECT`/`PROXY:n` are
  explicit; `AUTO` returns the first **healthy** egress by `priorityOrder`,
  falling back to `direct` when nothing is healthy.

### Proxy (`src/proxy/server.ts`)

A single `http.Server` with no proxy library:

- `"request"` event = plain-HTTP forwarding. DIRECT hits the origin; via an
  upstream it sends the absolute-form request with a `Proxy-Authorization` header.
- `"connect"` event = HTTPS tunnelling. DIRECT opens a raw TCP socket; via an
  upstream it issues its own `CONNECT` and splices the sockets.
- **Upstream over TLS:** an `https://` upstream proxy is reached with `tls.connect`
  (CONNECT path) / `https.request` (plain-HTTP path); an `http://` (or scheme-less)
  upstream uses `net.connect` / `http.request`.
- Client auth via `proxyCredentials` (407 when missing/wrong, constant-time
  compare). Hop-by-hop `proxy-*` headers are stripped before forwarding.

### Prober (`src/prober/prober.ts`)

Builds one undici dispatcher per egress (`Agent` for direct; `ProxyAgent` with an
`http://` or `https://` uri for proxies; the scheme comes from the parsed
upstream URL). For each monitored URL it downloads up to `fetchBytesLimit` bytes,
times the bounded transfer, and marks it `ok` only when `statusCode ===
expectedResponseCode` **and** the elapsed time `<= acceptedResponseTimeMs`. It
requests `Accept-Encoding: identity` so the byte count reflects the real transfer,
and uses a per-probe hard cap of `max(30s, acceptedResponseTimeMs * 2)`. An egress
is healthy only when every monitored URL is `ok`.

### Dashboard backend (`src/server/api.ts`)

Express. Global Basic-auth middleware when `adminDashboardCredentials` is not
anonymous (covers both the API and the static files, so the browser prompts once).
Serves `STATIC_DIR` (default `./dashboard/dist`) with an SPA fallback. Endpoints:

- `GET /api/status` → `{ config (sanitized), egresses, mode, activeEgressId, health, serverTime }`
- `POST /api/mode` `{ "mode": "AUTO" | "DIRECT" | "PROXY:<index>" }` → new status; `400` on invalid
- `POST /api/probe/run` → `202`, triggers an immediate probe cycle

Everything browser-facing passes through `sanitizeConfig()` / `maskUrl()`; no
password is ever emitted.

### Dashboard frontend (`dashboard/`)

A Vite/React SPA. `src/api.ts` is the typed client; `App.tsx` polls
`GET /api/status` every 10s and after each action. In dev, `vite.config.ts` proxies
`/api` to `http://localhost:443`.

## Upstream proxy URL format

`[http://|https://]user:pass@host:port`, or `host:port` for an anonymous upstream.
`parseUpstreamUrl()` returns `{ host, port, secure, user?, pass? }`, where `secure`
is `true` for an `https://` proxy (TLS to the proxy itself). Passwords may contain
`@` (the parser splits on the last `@`).

## Conventions

- **ESM with explicit `.js` extensions** on relative imports (the tsconfig uses
  NodeNext). `import { store } from "../state.js";` resolves `state.ts` at runtime.
- **Never leak secrets.** Anything sent to the browser or returned by the API must
  go through `sanitizeConfig()` / `maskUrl()`.
- **The store is the only coordination point.** Components don't call each other;
  they read/write the shared store.
- **Keep dependencies minimal** (`express`, `undici`, `zod`, `tsx`, plus the
  dashboard's `vite`/`react`).

## Development

Prerequisites: Node.js 22+.

```bash
npm install                 # root deps
npm run typecheck           # tsc --noEmit over src/**
npm run build:dashboard     # installs + vite-builds dashboard/ -> dashboard/dist

# Run locally on non-privileged ports (443 needs root):
SEP_CONFIG="$(cat config.json)" PROXY_PORT=13128 DASHBOARD_PORT=18443 STATE_DIR=/tmp/sep npm start

# Live frontend dev (separate terminal); it proxies /api to :443:
npm --prefix dashboard run dev
```

Environment variables: `SEP_CONFIG` (required), `PROXY_PORT` (3128),
`DASHBOARD_PORT` (443), `STATE_DIR` (/data), `STATIC_DIR` (./dashboard/dist).

## Docker

Multi-stage build on `node:22-slim`: the build stage installs deps and runs the
Vite build; the runtime stage copies the source, `node_modules`, and
`dashboard/dist`, then runs `npx tsx src/index.ts`. Exposes `3128` and `443`.

```bash
docker build -t smart-egress-proxy .
```

## Testing changes

There is no automated test suite yet. The pragmatic smoke test:

1. `npm run typecheck` and `npm run build:dashboard` must pass.
2. Boot with a real `config.json` on alternate ports, then verify routing actually
   changes the egress IP per mode:
   `curl -s -x http://127.0.0.1:13128 https://api.ipify.org` after
   `POST /api/mode {"mode":"PROXY:0"}` (and `DIRECT`) should return different IPs.
3. Check `GET /api/status` shows the prober's per-egress health.
