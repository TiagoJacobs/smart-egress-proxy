# smart-egress-proxy

A small, self-contained forward proxy for your own machine. It continuously
tests every available way out to the internet (a direct connection plus any
upstream proxies you configure) and automatically routes your traffic through
the fastest healthy one. When a route breaks or slows down, it fails over to the
next. A built-in dashboard shows live status and lets you switch routes by hand.

It runs as a **single Docker image**, designed to sit on `localhost` as your
personal egress proxy.

## Features

- **Forward proxy** on port `3128` for HTTP and HTTPS (via the `CONNECT` method).
- **Multiple routes out:** a direct connection plus any number of upstream proxies (authenticated or anonymous).
- **Automatic failover** (`AUTO`) based on live health, with manual overrides (`DIRECT`, or a specific proxy).
- **Throughput-aware checks:** each route is tested by downloading a bounded number of bytes and timing it, so slow routes are caught, not just dead ones.
- **Dashboard** on port `443` to watch health and switch routes with one click.
- **Secrets stay secret:** proxy and dashboard passwords are never shown in the dashboard or the API.

## Quick start

1. **Build the image:**

   ```bash
   docker build -t smart-egress-proxy .
   ```

2. **Create your config** from the template and edit it (see [Configuration](#configuration)):

   ```bash
   cp config.json.example config.json
   ```

   Your `config.json` is git-ignored, so your real credentials never get committed.

3. **Run it**, binding the ports to `127.0.0.1` so only your machine can reach them:

   ```bash
   docker run --rm \
     -p 127.0.0.1:3128:3128 \
     -p 127.0.0.1:443:443 \
     -e SEP_CONFIG="$(cat config.json)" \
     -v "$PWD/data:/data" \
     smart-egress-proxy
   ```

   The `-v "$PWD/data:/data"` mount is optional; it remembers your selected route across restarts.

4. **Point your browser or OS at the proxy** `127.0.0.1:3128` (see [Point your OS / browser at the proxy](#point-your-os--browser-at-the-proxy)).

5. **Open the dashboard** at <http://127.0.0.1:443/>.

## Configuration

The whole configuration is a single JSON object passed in the `SEP_CONFIG`
environment variable. It is validated when the container starts; a bad config
fails fast with a clear message telling you what to fix. Start from
[`config.json.example`](./config.json.example):

```json
{
  "monitoredUrls": [
    {
      "url": "https://www.google.com",
      "expectedResponseCode": 200,
      "fetchBytesLimit": 1048576,
      "acceptedResponseTimeMs": 2000
    }
  ],
  "upstreamProxies": [
    {
      "name": "proxy-eu",
      "url": "euuser:eupass@proxy-eu.example.com:8080",
      "priorityOrder": 1
    }
  ],
  "settings": {
    "probeIntervalMinutes": 5,
    "directPriorityOrder": 100,
    "defaultMode": "AUTO"
  },
  "adminDashboardCredentials": {
    "anonymous": false,
    "user": "admin",
    "pass": "change-me"
  },
  "proxyCredentials": {
    "anonymous": true
  }
}
```

### Fields

**`monitoredUrls[]`**: the URLs that are tested through every route to decide its health.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `url` | string | (required) | The HTTPS URL to test. |
| `expectedResponseCode` | number | `200` | The HTTP status that counts as healthy. |
| `fetchBytesLimit` | number | `1048576` | How many bytes to download from the response before stopping. The download is timed, so this turns each check into a throughput test (e.g. fetch 5 MB of a 200 MB file). If the resource is smaller, the whole body is downloaded. |
| `acceptedResponseTimeMs` | number | `2000` | The route is considered slow/failing if downloading `fetchBytesLimit` takes longer than this. |

**`upstreamProxies[]`**: the upstream proxies your traffic can be routed through.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | (required) | Friendly label shown in the dashboard. |
| `url` | string | (required) | `[http://]user:pass@host:port` for authenticated proxies, or `host:port` for anonymous ones. The `http://` scheme is optional. |
| `priorityOrder` | number | (required) | Lower number = higher preference. |

**`settings`**

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `probeIntervalMinutes` | number | `5` | How often every route is re-tested. |
| `directPriorityOrder` | number | `100` | Where the **direct** connection ranks in `AUTO` mode. The default makes direct the last-resort fallback. |
| `defaultMode` | string | `"AUTO"` | Initial mode: `"AUTO"`, `"DIRECT"`, or `"PROXY:<index>"` (0-based index into `upstreamProxies`). |

**`adminDashboardCredentials`** and **`proxyCredentials`** are each a `Credentials` object:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `anonymous` | boolean | `true` | If `true`, no login is required. If `false`, both `user` and `pass` must be set. |
| `user` | string | (none) | Username (required when `anonymous` is `false`). |
| `pass` | string | (none) | Password (required when `anonymous` is `false`). |

`proxyCredentials` defaults to `anonymous: true` because the proxy is meant to run on `localhost`.

## Routing modes (AUTO / DIRECT / PROXY)

Each route has an **id**: `direct`, or `proxy-0`, `proxy-1`, and so on (0-based into `upstreamProxies`). The active route is decided by the current mode:

- **`AUTO`**: use the first **healthy** route by priority (lowest `priorityOrder` first). The direct connection takes part using `settings.directPriorityOrder`. If nothing is healthy, it falls back to the direct connection. This is the main behavior: as routes break, traffic automatically moves to the next best healthy one.
- **`DIRECT`**: always use the direct connection, regardless of health.
- **`PROXY:<index>`**: always use upstream proxy `<index>` (0-based), regardless of health. A manual override.

You set the starting mode with `settings.defaultMode` and change it live from the dashboard. Your choice is saved to `STATE_DIR/state.json`, so it survives restarts.

## Point your OS / browser at the proxy

Configure your system or browser to use the HTTP proxy at `127.0.0.1` port `3128` for both HTTP and HTTPS.

- **Firefox:** Settings → Network Settings → *Manual proxy configuration*. Set HTTP Proxy `127.0.0.1` port `3128` and tick *Also use this proxy for HTTPS*.
- **macOS:** System Settings → Network → your connection → Details → Proxies → enable *Web Proxy (HTTP)* and *Secure Web Proxy (HTTPS)*, both `127.0.0.1:3128`.
- **Linux (GNOME):** Settings → Network → Network Proxy → *Manual*, HTTP/HTTPS proxy `127.0.0.1:3128`.
- **Per-command (curl):** `https_proxy=http://127.0.0.1:3128 http_proxy=http://127.0.0.1:3128 curl https://example.com`

## Dashboard

Open <http://127.0.0.1:443/>. The dashboard shows every route and its live health
(per test URL: status code, response time, and bytes downloaded), highlights the
route currently in use, and lets you switch between automatic and manual modes
with one click. If you set `adminDashboardCredentials`, your browser will ask for
the username and password the first time you open it.

## Environment variables

`SEP_CONFIG` is the only one you normally need; the rest have sensible defaults.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SEP_CONFIG` | (required) | The configuration as a JSON string. |
| `PROXY_PORT` | `3128` | Forward proxy port. |
| `DASHBOARD_PORT` | `443` | Dashboard port. |
| `STATE_DIR` | `/data` | Where the selected mode is saved. The app keeps running in-memory if this is missing or unwritable. |
| `STATIC_DIR` | `./dashboard/dist` | Location of the built dashboard files. |
| `BIND_ADDR` | (all interfaces) | Interface the proxy and dashboard listen on. Leave unset for the documented bridge setup, where `-p 127.0.0.1:3128:3128` already constrains exposure. Set to `127.0.0.1` when running with `--network host`, where there is no Docker port mapping and the default would otherwise publish on every interface. |
| `PROXY_BIND_ADDR` | (falls back to `BIND_ADDR`) | Interface for the **forward proxy** alone. Overrides `BIND_ADDR` for the proxy. Use it to pin the proxy to `127.0.0.1` while the dashboard listens elsewhere. |
| `DASHBOARD_BIND_ADDR` | (falls back to `BIND_ADDR`) | Interface for the **dashboard/API** alone. Overrides `BIND_ADDR` for the dashboard. Lets you expose only the dashboard (e.g. on a VPN-routed LAN address) while the proxy stays on loopback. |

## Security

smart-egress-proxy is meant to run on **localhost**, for your own machine. Always
bind its ports to `127.0.0.1` (as shown above). Do not expose `3128` or `443` to
a network you don't fully trust, since an open forward proxy can be abused to
relay other people's traffic. If you must expose the dashboard, protect it with
`adminDashboardCredentials`. Proxy and credential passwords are never returned by
the API or sent to the browser.

When you run with `--network host` (no Docker port mapping to fall back on),
set `BIND_ADDR=127.0.0.1` so the proxy and dashboard stay on loopback instead of
binding every interface.

To expose **only the dashboard** (for example over a VPN, where the tunnel
already encrypts traffic) while keeping the forward proxy unreachable, set
`PROXY_BIND_ADDR=127.0.0.1` and `DASHBOARD_BIND_ADDR=0.0.0.0`. The proxy stays on
loopback (it must never be an open relay) while the dashboard binds a reachable
interface — gate it with `adminDashboardCredentials`.

## Architecture & development

Want to understand how it works internally, build it from source, or contribute?
See [AGENTS.md](./AGENTS.md).

## License

MIT © Tiago Jacobs
