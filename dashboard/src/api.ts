/**
 * Tiny typed client for the smart-egress-proxy dashboard API.
 *
 * All endpoints are same-origin (`/api/*`). In dev, Vite proxies them to the
 * Node server (see vite.config.ts). The types here mirror the server contract;
 * they intentionally describe only the *sanitized* shape (no secrets ever
 * reach the browser).
 */

/** A monitored URL as exposed by the (sanitized) config. */
export interface MonitoredUrl {
  url: string;
  expectedResponseCode: number;
  fetchBytesLimit: number;
  acceptedResponseTimeMs: number;
}

/** An upstream proxy entry with its URL password masked. */
export interface UpstreamProxyConfig {
  name: string;
  /** Password-masked: "user:***@host:port". */
  url: string;
  priorityOrder: number;
}

export interface Settings {
  probeIntervalMinutes: number;
  directPriorityOrder: number;
  defaultMode: string;
}

/** Credentials with the password stripped for transport. */
export interface SanitizedCredentials {
  anonymous: boolean;
  user?: string;
}

/** The sanitized config delivered by GET /api/status. */
export interface SanitizedConfig {
  monitoredUrls: MonitoredUrl[];
  upstreamProxies: UpstreamProxyConfig[];
  settings: Settings;
  adminDashboardCredentials: SanitizedCredentials;
  proxyCredentials: SanitizedCredentials;
}

/** An egress route summary as exposed by the API. */
export interface EgressSummary {
  id: string;
  name: string;
  kind: "direct" | "proxy";
  priorityOrder: number;
  /** Present only for proxy egresses; 0-based index into upstreamProxies. */
  proxyIndex?: number;
  /** Present only for proxy egresses; password-masked upstream URL. */
  maskedUrl?: string;
}

export type Mode =
  | { type: "AUTO" }
  | { type: "DIRECT" }
  | { type: "PROXY"; proxyIndex: number };

export interface UrlProbeResult {
  url: string;
  ok: boolean;
  responseCode?: number;
  responseTimeMs?: number;
  bytesDownloaded?: number;
  error?: string;
  checkedAt: string;
}

export interface EgressHealth {
  egressId: string;
  healthy: boolean;
  results: UrlProbeResult[];
  lastCheckedAt?: string;
}

/** Per-URL breakdown carried by each history sample (contract v2). */
export interface HistoryUrlSample {
  url: string;
  /** That URL's responseTimeMs this cycle, or null when undefined. */
  ms: number | null;
  /** That URL's ok flag this cycle. */
  ok: boolean;
}

/** One per-cycle latency sample for an egress (matches backend ring buffer). */
export interface HistoryPoint {
  t: string;
  avgMs: number | null;
  healthy: boolean;
  /** One entry per monitored URL probed that cycle. */
  urls: HistoryUrlSample[];
}

/** Per-egress latency history, points ordered oldest -> newest. */
export interface EgressHistory {
  egressId: string;
  points: HistoryPoint[];
}

/** Per-egress traffic counters carried by `usage.perEgress`. */
export interface EgressUsage {
  egressId: string;
  /** Download bytes (internet -> client) routed through this egress. */
  bytesIn: number;
  /** Upload bytes (client -> internet) routed through this egress. */
  bytesOut: number;
  /** Handled HTTP requests + CONNECT tunnels on this egress. */
  requests: number;
}

/** Aggregate traffic that has flowed through the proxy. */
export interface Usage {
  /** Total download bytes (internet -> client). */
  bytesIn: number;
  /** Total upload bytes (client -> internet). */
  bytesOut: number;
  /** Each handled HTTP request and each CONNECT tunnel counts once. */
  totalRequests: number;
  /** Currently-open requests/tunnels (>= 0). */
  activeConnections: number;
  /** ISO timestamp the proxy/store started (uptime = serverTime - startedAt). */
  startedAt: string;
  perEgress: EgressUsage[];
}

/** Response body of GET /api/status. */
export interface StatusResponse {
  config: SanitizedConfig;
  egresses: EgressSummary[];
  mode: Mode;
  activeEgressId: string;
  health: EgressHealth[];
  history: EgressHistory[];
  usage: Usage;
  serverTime: string;
}

/** Canonical mode strings accepted by POST /api/mode. */
export type ModeString = "AUTO" | "DIRECT" | `PROXY:${number}`;

/** Error carrying the HTTP status so callers can special-case 401, etc. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...init?.headers,
      },
    });
  } catch (err) {
    // Network/connection failure (server down, TLS issue, etc.).
    throw new ApiError(
      err instanceof Error ? err.message : "Network request failed",
      0,
    );
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    const suffix = detail ? `: ${detail}` : "";
    throw new ApiError(
      `${res.status} ${res.statusText}${suffix}`.trim(),
      res.status,
    );
  }

  const text = await res.text();
  return (text.length > 0 ? (JSON.parse(text) as T) : (undefined as T));
}

/** GET /api/status, full dashboard snapshot. */
export function fetchStatus(): Promise<StatusResponse> {
  return request<StatusResponse>("/api/status");
}

/** POST /api/mode, switch the routing mode. */
export function setMode(mode: ModeString): Promise<void> {
  return request<void>("/api/mode", {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
}

/** POST /api/probe/run, trigger an immediate probe cycle. */
export function runProbe(): Promise<void> {
  return request<void>("/api/probe/run", { method: "POST" });
}

/** Convert a Mode object to its canonical wire string. */
export function modeToString(mode: Mode): ModeString {
  switch (mode.type) {
    case "AUTO":
      return "AUTO";
    case "DIRECT":
      return "DIRECT";
    case "PROXY":
      return `PROXY:${mode.proxyIndex}`;
  }
}
