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
 * Render a host and port back into an authority string, re-bracketing an IPv6
 * literal. `host` values produced by parseUpstreamUrl are always bare, which is
 * what net.connect, tls.connect and net.isIP expect, but anything that composes
 * a URL or a request line needs the brackets back or the result is unparseable.
 * A bare host containing ":" can only be an IPv6 literal, since a DNS name or an
 * IPv4 address never does.
 */
export function formatAuthority(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

/**
 * Strip the brackets from an IPv6 literal host. WHATWG URL keeps them in
 * `hostname`, while net.connect, tls.connect and http.request all need the bare
 * address or they try to resolve the literal string as a DNS name.
 */
export function unbracketHost(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Parse an upstream proxy URL of the form "[http://]user:pass@host:port" or
 * "host:port" (anonymous). The scheme selects TLS-to-the-proxy and is otherwise
 * ignored. The username and password are optional, an IPv6 literal host may be
 * bracketed, and a trailing path or slash is tolerated and discarded. The
 * returned host is never bracketed. Throws a clear Error if host or port are
 * missing or the port is out of range.
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

  // Drop a trailing path. Only now, after the credentials are out of the way, so
  // that a password containing "/" is never mistaken for the start of a path.
  const slashIndex = rest.indexOf("/");
  if (slashIndex !== -1) {
    rest = rest.slice(0, slashIndex);
  }

  // Split the authority. A bracketed IPv6 literal has to be found by its closing
  // bracket, because scanning for the last ":" would land inside the address.
  let host: string;
  let portStr: string;
  if (rest.startsWith("[")) {
    const closing = rest.indexOf("]");
    if (closing === -1) {
      throw new Error(
        `Invalid upstream proxy url "${url}": unterminated IPv6 literal`,
      );
    }
    host = rest.slice(1, closing);
    const remainder = rest.slice(closing + 1);
    if (!remainder.startsWith(":")) {
      throw new Error(
        `Invalid upstream proxy url "${url}": missing port (expected [host]:port)`,
      );
    }
    portStr = remainder.slice(1);
  } else {
    const colonIndex = rest.lastIndexOf(":");
    if (colonIndex === -1) {
      throw new Error(
        `Invalid upstream proxy url "${url}": missing port (expected host:port)`,
      );
    }
    host = rest.slice(0, colonIndex);
    portStr = rest.slice(colonIndex + 1);
  }

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
    const authority = formatAuthority(host, port);
    if (user !== undefined && pass !== undefined) {
      return `${scheme}${user}:***@${authority}`;
    }
    if (user !== undefined) {
      return `${scheme}${user}@${authority}`;
    }
    return `${scheme}${authority}`;
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
