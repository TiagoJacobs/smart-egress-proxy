<div align="center">

# Smart Egress Proxy

### One small container that routes your traffic through the fastest working way out to the internet, and fails over the instant a route dies.

[![CI](https://github.com/TiagoJacobs/smart-egress-proxy/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/TiagoJacobs/smart-egress-proxy/actions/workflows/docker-publish.yml)
[![Docker version](https://img.shields.io/docker/v/tdjac0bs/smart-egress-proxy?sort=semver&logo=docker&label=docker)](https://hub.docker.com/r/tdjac0bs/smart-egress-proxy)
[![Docker pulls](https://img.shields.io/docker/pulls/tdjac0bs/smart-egress-proxy?logo=docker)](https://hub.docker.com/r/tdjac0bs/smart-egress-proxy)
[![Image size](https://img.shields.io/docker/image-size/tdjac0bs/smart-egress-proxy/latest?logo=docker)](https://hub.docker.com/r/tdjac0bs/smart-egress-proxy)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

<img src="docs/hero.png" alt="Smart Egress Proxy dashboard" width="860">

</div>

## Why

Some of the APIs and sites you rely on are slow, rate-limited, or blocked depending
on where your traffic leaves from. Smart Egress Proxy runs on your machine, keeps
testing every way out you give it (a direct connection plus any upstream proxies),
and sends your traffic through the fastest one that is currently healthy. When a
route breaks or slows down, it moves you to the next best one on its own. Point your
browser at it once and forget it is there.

## Highlights

- 🔀 **Automatic failover.** Always uses the fastest healthy route, and switches the moment one degrades. No babysitting.
- ⚡ **Throughput-aware.** Routes are graded by downloading real bytes and timing them, so slow routes get caught, not just dead ones.
- 🌐 **Direct, HTTP, or HTTPS proxies.** Chain through authenticated or anonymous upstreams, including TLS (`https://`) proxies.
- 📊 **A dashboard you will actually open.** Per-route health matrix, response-time history per URL, and live traffic usage. One click to override the route.
- 🔒 **Secure by default.** Bound to `localhost`. Passwords never reach the browser or the API.
- 📦 **One image.** Proxy, prober, and dashboard in a single multi-arch container (amd64 + arm64).

## Quick start

```bash
# 1. start from the template and edit it
cp config.json.example config.json

# 2. run it, bound to 127.0.0.1 (only your machine can reach it)
docker run -d --name smart-egress-proxy \
  -p 127.0.0.1:3128:3128 \
  -p 127.0.0.1:443:443 \
  -e SEP_CONFIG="$(cat config.json)" \
  -v "$PWD/data:/data" \
  tdjac0bs/smart-egress-proxy:latest
```

Then:

- Point your browser or OS **HTTP and HTTPS proxy** at `127.0.0.1:3128`.
- Open the dashboard at **http://127.0.0.1:443/**.
- Watch it route, and try flipping between `AUTO`, `DIRECT`, and a specific proxy.

```bash
# see which way out you are using right now
curl -x http://127.0.0.1:3128 https://api.ipify.org
```

<div align="center">
  <details>
    <summary><b>See the full dashboard</b> (usage, status matrix, and a chart per monitored URL)</summary>
    <br>
    <img src="docs/dashboard.png" alt="Full Smart Egress Proxy dashboard" width="820">
  </details>
</div>

## Configuration

Everything is one JSON object in the `SEP_CONFIG` environment variable. It is
validated on startup, so a bad config fails fast with a clear message. Minimal example:

```json
{
  "monitoredUrls": [
    { "url": "https://www.google.com", "expectedResponseCode": 200, "fetchBytesLimit": 1048576, "acceptedResponseTimeMs": 2000 }
  ],
  "upstreamProxies": [
    { "name": "eu", "url": "https://user:pass@proxy.example.com:443", "priorityOrder": 1 }
  ],
  "settings": { "probeIntervalMinutes": 5, "directPriorityOrder": 100, "defaultMode": "AUTO" },
  "adminDashboardCredentials": { "anonymous": false, "user": "admin", "pass": "change-me" },
  "proxyCredentials": { "anonymous": true }
}
```

<details>
<summary><b>Full field reference</b></summary>

**`monitoredUrls[]`**: the URLs tested through every route to decide its health.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `url` | string | (required) | The HTTPS URL to test. |
| `expectedResponseCode` | number | `200` | The HTTP status that counts as healthy. |
| `fetchBytesLimit` | number | `1048576` | How many bytes to download (and time) per check. This turns each probe into a throughput test (e.g. fetch 5 MB of a 200 MB file). If the resource is smaller, the whole body is downloaded. |
| `acceptedResponseTimeMs` | number | `2000` | The route is slow/failing if downloading `fetchBytesLimit` takes longer than this. |

**`upstreamProxies[]`**: the upstream proxies your traffic can route through.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | (required) | Friendly label shown in the dashboard. |
| `url` | string | (required) | `[http://\|https://]user:pass@host:port`, or `host:port` for an anonymous proxy. `https://` means the proxy itself is reached over TLS. |
| `priorityOrder` | number | (required) | Lower number = higher preference. |

**`settings`**

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `probeIntervalMinutes` | number | `5` | How often every route is re-tested. |
| `directPriorityOrder` | number | `100` | Where the **direct** connection ranks in `AUTO`. The default makes it the last-resort fallback. |
| `defaultMode` | string | `"AUTO"` | Initial mode: `"AUTO"`, `"DIRECT"`, or `"PROXY:<index>"` (0-based into `upstreamProxies`). |

**`adminDashboardCredentials`** and **`proxyCredentials`** are each a `Credentials` object: `{ "anonymous": true }`, or `{ "anonymous": false, "user": "...", "pass": "..." }`. `proxyCredentials` defaults to anonymous because the proxy is meant to run on `localhost`.

**Environment variables** (only `SEP_CONFIG` is required):

| Variable | Default | Meaning |
| --- | --- | --- |
| `SEP_CONFIG` | (required) | The whole configuration, as a JSON string. |
| `PROXY_PORT` | `3128` | Forward proxy port. |
| `DASHBOARD_PORT` | `443` | Dashboard port. |
| `BIND_ADDR` | (all interfaces) | Interface both servers listen on. Leave unset with the `-p 127.0.0.1:...` mapping above. Set to `127.0.0.1` when running with `--network host`. |
| `PROXY_BIND_ADDR` | (falls back to `BIND_ADDR`) | Interface for the forward proxy alone. |
| `DASHBOARD_BIND_ADDR` | (falls back to `BIND_ADDR`) | Interface for the dashboard alone. |
| `STATE_DIR` | `/data` | Where the selected mode and chart history are persisted. |
| `STATIC_DIR` | `./dashboard/dist` | Location of the built dashboard files. |

</details>

## Routing modes

Each route has an id: `direct`, or `proxy-0`, `proxy-1`, and so on. The active route follows the current mode, which you set in `settings.defaultMode` and change live from the dashboard:

- **`AUTO`**: the first healthy route by priority. The direct connection takes part using `directPriorityOrder`. If nothing is healthy, it falls back to direct.
- **`DIRECT`**: always the direct connection.
- **`PROXY:<index>`**: always that upstream proxy, even if unhealthy. A manual override.

## Security

Smart Egress Proxy is meant to run on **localhost**. Always bind its ports to
`127.0.0.1` (as shown above). An open forward proxy exposed to an untrusted network
can be abused to relay other people's traffic. Protect the dashboard with
`adminDashboardCredentials` if you ever expose it. Proxy and credential passwords are
never returned by the API or sent to the browser.

Running with `--network host`? There is no Docker port mapping to constrain you, so
set `BIND_ADDR=127.0.0.1` to keep the proxy and dashboard on loopback. To expose only
the dashboard (for example over a VPN) while keeping the proxy unreachable, set
`PROXY_BIND_ADDR=127.0.0.1` and `DASHBOARD_BIND_ADDR=0.0.0.0`, and gate the dashboard
with `adminDashboardCredentials`.

## How it works and contributing

Architecture, the per-component internals, and local development are in
[AGENTS.md](./AGENTS.md).

## License

MIT © Tiago Jacobs
