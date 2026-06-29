# Smart Egress Proxy

A small, self-contained **forward proxy for your own machine** that automatically
routes your traffic through the fastest healthy way out to the internet (a direct
connection or any of several upstream proxies) and fails over automatically when a
route breaks or slows down. Ships with a live web dashboard.

**One image, one process, three parts:** an HTTP/HTTPS forward proxy, a background
health prober, and a dashboard.

## Features

- **Forward proxy** on port `3128`: HTTP and HTTPS (via the `CONNECT` method).
- **Multiple egress routes:** a direct connection plus any number of upstream
  proxies (**HTTP or HTTPS**), authenticated or anonymous.
- **Automatic failover** (`AUTO`) based on live health, with manual overrides
  (`DIRECT`, or a specific proxy).
- **Throughput-aware probing:** each route is tested by downloading a bounded number
  of bytes and timing it, so slow routes are caught, not just dead ones.
- **Live dashboard** on port `8080`: per-route health, one-click route switching, and
  a comparative response-time history.
- **Secrets stay secret:** proxy and dashboard passwords are never returned by the
  API or shown in the dashboard.

## Quick start

Create a `config.json` (see below), then run, binding the ports to `127.0.0.1`
so only your machine can reach them:

```bash
docker run -d --name smart-egress-proxy \
  -p 127.0.0.1:3128:3128 \
  -p 127.0.0.1:8080:8080 \
  -e SEP_CONFIG="$(cat config.json)" \
  -v "$PWD/data:/data" \
  tdjac0bs/smart-egress-proxy:latest
```

Then:

- Point your browser/OS **HTTP and HTTPS proxy** at `127.0.0.1:3128`.
- Open the dashboard at **http://127.0.0.1:8080/**.

(The `-v .../data` mount is optional; it remembers your selected route across restarts.)

## Configuration

The entire configuration is a JSON object passed in the `SEP_CONFIG` environment
variable. Minimal example:

```json
{
  "monitoredUrls": [
    { "url": "https://www.google.com", "expectedResponseCode": 200, "fetchBytesLimit": 1048576, "acceptedResponseTimeMs": 2000 }
  ],
  "upstreamProxies": [
    { "name": "proxy-eu", "url": "https://user:pass@proxy.example.com:443", "priorityOrder": 1 }
  ],
  "settings": { "probeIntervalMinutes": 5, "directPriorityOrder": 100, "defaultMode": "AUTO" },
  "adminDashboardCredentials": { "anonymous": false, "user": "admin", "pass": "change-me" },
  "proxyCredentials": { "anonymous": true }
}
```

- `monitoredUrls[]`: URLs probed through every route. `fetchBytesLimit` caps how many
  bytes are downloaded (and timed) per check; `acceptedResponseTimeMs` is the slow/fail threshold.
- `upstreamProxies[].url`: `[http://|https://]user:pass@host:port` (scheme optional;
  `https://` = the proxy itself is reached over TLS). Lower `priorityOrder` = preferred.
- `settings.directPriorityOrder`: where the direct connection ranks in `AUTO`.
- `*Credentials`: `{ "anonymous": true }`, or `{ "anonymous": false, "user": "...", "pass": "..." }`.

**Routing modes:** `AUTO` (first healthy route by priority), `DIRECT`, or `PROXY:<index>`
(0-based into `upstreamProxies`). Switch live from the dashboard.

## Ports & environment

| Port | Service |
| --- | --- |
| `3128` | Forward proxy |
| `8080` | Dashboard (HTTP) |

| Variable | Default | Meaning |
| --- | --- | --- |
| `SEP_CONFIG` | (required) | Configuration as a JSON string. |
| `PROXY_PORT` | `3128` | Forward proxy port. |
| `DASHBOARD_PORT` | `8080` | Dashboard port. |
| `STATE_DIR` | `/data` | Where the selected route is persisted. |

## Tags

- `latest`: the most recent build.

## Security

Smart Egress Proxy is meant to run on **localhost**. Always bind its ports to
`127.0.0.1` (as shown above). An open forward proxy exposed to an untrusted network
can be abused to relay other people's traffic. Protect the dashboard with
`adminDashboardCredentials` if you ever expose it.

## Source & license

MIT © Tiago Jacobs. Source, full documentation and issues:
**https://github.com/TiagoJacobs/smart-egress-proxy**
