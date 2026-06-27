/**
 * Small, dependency-free helpers shared across the proxy, prober and API.
 */

import type { AppConfig, Credentials, Mode } from "./types.js";

/** Parsed components of an upstream proxy URL. */
export interface ParsedUpstreamUrl {
  host: string;
  port: number;
  /** True when the proxy itself is reached over TLS (an "https://" proxy). */
  secure: boolean;
  user?: string;
  pass?: string;
}

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Parse an upstream proxy URL of the form "[http://]user:pass@host:port" or
 * "host:port" (anonymous). The scheme, if present, is ignored. The username
 * and password are optional. Throws a clear Error if host or port are missing
 * or the port is out of range.
 */
export function parseUpstreamUrl(url: string): ParsedUpstreamUrl {
  let rest = url.trim();
  if (rest === "") {
    throw new Error("Invalid upstream proxy url: empty string");
  }

  // Detect and strip an optional scheme. "https://" marks an HTTPS proxy (the
  // connection to the proxy is TLS-encrypted); "http://" or no scheme is plain.
  let secure = false;
  const schemeMatch = SCHEME_RE.exec(rest);
  if (schemeMatch) {
    secure = /^https:/i.test(schemeMatch[0]);
    rest = rest.slice(schemeMatch[0].length);
  }

  let user: string | undefined;
  let pass: string | undefined;

  // Use the last "@" so passwords containing "@" still parse the host correctly.
  const atIndex = rest.lastIndexOf("@");
  if (atIndex !== -1) {
    const auth = rest.slice(0, atIndex);
    rest = rest.slice(atIndex + 1);
    const colonIndex = auth.indexOf(":");
    if (colonIndex === -1) {
      user = auth;
    } else {
      user = auth.slice(0, colonIndex);
      pass = auth.slice(colonIndex + 1);
    }
  }

  const colonIndex = rest.lastIndexOf(":");
  if (colonIndex === -1) {
    throw new Error(
      `Invalid upstream proxy url "${url}": missing port (expected host:port)`,
    );
  }

  const host = rest.slice(0, colonIndex);
  const portStr = rest.slice(colonIndex + 1);
  const port = Number(portStr);

  if (host === "") {
    throw new Error(`Invalid upstream proxy url "${url}": missing host`);
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid upstream proxy url "${url}": invalid port "${portStr}"`);
  }

  const result: ParsedUpstreamUrl = { host, port, secure };
  if (user !== undefined && user !== "") result.user = user;
  if (pass !== undefined) result.pass = pass;
  return result;
}

/** Build an HTTP Basic Authorization header value: "Basic base64(user:pass)". */
export function buildBasicAuth(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

/**
 * Return a display-safe version of an upstream proxy URL with the password
 * replaced by "***". Best-effort: if the URL cannot be parsed it falls back to
 * a regex mask so a raw password can never leak.
 */
export function maskUrl(url: string): string {
  try {
    const { host, port, user, pass, secure } = parseUpstreamUrl(url);
    const scheme = secure ? "https://" : "http://";
    if (user !== undefined && pass !== undefined) {
      return `${scheme}${user}:***@${host}:${port}`;
    }
    if (user !== undefined) {
      return `${scheme}${user}@${host}:${port}`;
    }
    return `${scheme}${host}:${port}`;
  } catch {
    // Fallback: blunt-mask anything that looks like "user:pass@".
    return url.replace(/([^/@:]+):([^@/]+)@/, (_m, u: string) => `${u}:***@`);
  }
}

/** Mask a Credentials object for transport to the browser (drops the password). */
function maskCredentials(c: Credentials): { anonymous: boolean; user?: string } {
  const out: { anonymous: boolean; user?: string } = { anonymous: c.anonymous };
  if (c.user !== undefined) out.user = c.user;
  return out;
}

/**
 * Produce a deep copy of the config that is safe to send to the browser: every
 * password is removed and upstream proxy URLs are masked. The return type is
 * deliberately `object` to discourage callers from depending on secret fields.
 */
export function sanitizeConfig(cfg: AppConfig): object {
  return {
    monitoredUrls: cfg.monitoredUrls.map((u) => ({ ...u })),
    upstreamProxies: cfg.upstreamProxies.map((p) => ({
      name: p.name,
      url: maskUrl(p.url),
      priorityOrder: p.priorityOrder,
    })),
    settings: { ...cfg.settings },
    adminDashboardCredentials: maskCredentials(cfg.adminDashboardCredentials),
    proxyCredentials: maskCredentials(cfg.proxyCredentials),
  };
}

/**
 * Parse a mode string ("AUTO" | "DIRECT" | "PROXY:<index>") into a Mode object.
 * Case-insensitive. Throws a clear Error on anything else.
 */
export function parseMode(s: string): Mode {
  const t = s.trim().toUpperCase();
  if (t === "AUTO") return { type: "AUTO" };
  if (t === "DIRECT") return { type: "DIRECT" };
  const m = t.match(/^PROXY:(\d+)$/);
  if (m) return { type: "PROXY", proxyIndex: Number(m[1]) };
  throw new Error(`Invalid mode "${s}" (expected "AUTO", "DIRECT" or "PROXY:<index>")`);
}

/** Serialize a Mode back into its canonical string form. */
export function modeToString(mode: Mode): string {
  switch (mode.type) {
    case "AUTO":
      return "AUTO";
    case "DIRECT":
      return "DIRECT";
    case "PROXY":
      return `PROXY:${mode.proxyIndex}`;
  }
}
