/**
 * Shared TypeScript types for smart-egress-proxy.
 *
 * These types are the single, authoritative description of the data that flows
 * between the config loader, the in-memory store, the proxy server, the prober
 * and the dashboard API. No runtime code lives here.
 */

/** A single HTTPS URL that the prober periodically checks through every egress. */
export interface MonitoredUrl {
  /** Absolute URL to probe, e.g. "https://www.google.com". */
  url: string;
  /** HTTP status code that is considered healthy, e.g. 200. */
  expectedResponseCode: number;
  /**
   * Maximum number of bytes to download from the response body before the
   * probe stops and releases the socket. The prober measures how long it takes
   * to download up to this many bytes, turning each probe into a bounded
   * throughput check (e.g. fetch 5 MB of a 200 MB file). If the resource is
   * smaller than this, the whole body is downloaded.
   */
  fetchBytesLimit: number;
  /** A probe is considered slow/failed if it takes longer than this (ms). */
  acceptedResponseTimeMs: number;
}

/** A configured upstream proxy that traffic can be routed through. */
export interface UpstreamProxyConfig {
  /** Human-friendly label shown in the dashboard. */
  name: string;
  /** "[http://]user:pass@host:port" or "host:port" for an anonymous upstream. */
  url: string;
  /** Lower number = higher preference when AUTO ranks egresses. */
  priorityOrder: number;
}

/** Credentials block for either the dashboard or the proxy listener. */
export interface Credentials {
  /** When true, no authentication is required. */
  anonymous: boolean;
  /** Username (required when anonymous is false). */
  user?: string;
  /** Password (required when anonymous is false). */
  pass?: string;
}

/** Tunable runtime settings. */
export interface Settings {
  /** How often the prober runs, in minutes. */
  probeIntervalMinutes: number;
  /** Priority assigned to the DIRECT egress when AUTO ranks egresses. */
  directPriorityOrder: number;
  /** Initial mode string: "AUTO" | "DIRECT" | "PROXY:<index>". */
  defaultMode: string;
}

/** The fully-resolved application configuration (after defaults are applied). */
export interface AppConfig {
  monitoredUrls: MonitoredUrl[];
  upstreamProxies: UpstreamProxyConfig[];
  settings: Settings;
  adminDashboardCredentials: Credentials;
  proxyCredentials: Credentials;
}

/**
 * A concrete egress route that outbound traffic can take.
 * `id` is "direct" for the direct connection or "proxy-<index>" for an upstream
 * proxy, where <index> is the 0-based index into AppConfig.upstreamProxies.
 */
export interface Egress {
  id: string;
  name: string;
  kind: "direct" | "proxy";
  priorityOrder: number;
  /** Present only when kind === "proxy"; 0-based index into upstreamProxies. */
  proxyIndex?: number;
  /** Present only when kind === "proxy"; password-masked upstream URL. */
  maskedUrl?: string;
}

/** The runtime routing mode. */
export type Mode =
  | { type: "AUTO" }
  | { type: "DIRECT" }
  | { type: "PROXY"; proxyIndex: number };

/** Result of probing a single monitored URL through a single egress. */
export interface UrlProbeResult {
  url: string;
  ok: boolean;
  responseCode?: number;
  responseTimeMs?: number;
  /** Bytes actually downloaded before hitting fetchBytesLimit or end-of-body. */
  bytesDownloaded?: number;
  error?: string;
  /** ISO-8601 timestamp of when the probe completed. */
  checkedAt: string;
}

/** Aggregated health of a single egress across all monitored URLs. */
export interface EgressHealth {
  egressId: string;
  healthy: boolean;
  results: UrlProbeResult[];
  /** ISO-8601 timestamp of the most recent probe cycle for this egress. */
  lastCheckedAt?: string;
}

/** Per-URL latency breakdown carried inside a single HistorySample. */
export interface HistoryUrlSample {
  /** The monitored URL this entry refers to. */
  url: string;
  /** That URL's responseTimeMs for the cycle; null when undefined. */
  ms: number | null;
  /** That URL's ok flag for the cycle. */
  ok: boolean;
}

/** One per-cycle latency sample for an egress (in-memory ring buffer entry). */
export interface HistorySample {
  /** ISO-8601 timestamp of the probe cycle that produced this sample. */
  t: string;
  /** Rounded average responseTimeMs over results that have a numeric responseTimeMs; null when none. */
  avgMs: number | null;
  healthy: boolean;
  /** One entry per monitored URL probed that cycle. */
  urls: HistoryUrlSample[];
}

/** Per-egress latency history, points ordered oldest -> newest. */
export interface EgressHistory {
  egressId: string;
  points: HistorySample[];
}

/**
 * Cumulative byte/request counters for a single egress route, since the store
 * started. `bytesIn` is download (internet -> client), `bytesOut` is upload
 * (client -> internet); see Usage for the full definitions.
 */
export interface EgressUsage {
  egressId: string;
  bytesIn: number;
  bytesOut: number;
  requests: number;
}

/**
 * Aggregate traffic accounting for everything that has flowed through the proxy
 * since it started.
 *
 * Direction is defined from the client's point of view:
 *   - IN  = download (internet -> client): for a CONNECT tunnel these are the
 *           bytes server -> client; for plain HTTP, the response-body bytes.
 *   - OUT = upload (client -> internet): for a CONNECT tunnel these are the
 *           bytes client -> server; for plain HTTP, the request-body bytes.
 */
export interface Usage {
  bytesIn: number;
  bytesOut: number;
  /** Each handled HTTP request and each CONNECT tunnel counts once. */
  totalRequests: number;
  /** Currently-open requests/tunnels (always >= 0). */
  activeConnections: number;
  /** ISO-8601 timestamp the proxy/store started (uptime = serverTime - startedAt). */
  startedAt: string;
  /** Per-egress breakdown; one entry per known egress id. */
  perEgress: EgressUsage[];
}
