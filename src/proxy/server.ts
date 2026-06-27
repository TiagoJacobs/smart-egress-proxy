/**
 * The forward HTTP proxy.
 *
 * A single http.Server handles two kinds of traffic:
 *   - "request" events: plain-HTTP proxying. The client sends an absolute URL in
 *     the request line; we forward it either DIRECT or through an upstream proxy.
 *   - "connect" events: HTTPS tunnelling via the CONNECT method. We open a raw
 *     TCP tunnel (directly, or by issuing CONNECT to an upstream proxy) and then
 *     blindly pipe bytes in both directions.
 *
 * The active egress (DIRECT vs a specific upstream) is resolved per request from
 * the shared store, so flipping the runtime mode takes effect immediately for
 * every new connection. No external proxy library is used: just node http/net.
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

import { store } from "../state.js";
import {
  parseUpstreamUrl,
  buildBasicAuth,
  type ParsedUpstreamUrl,
} from "../util.js";
import type { Egress } from "../types.js";

const REALM = 'Basic realm="smart-egress-proxy"';

/** Headers that must never be forwarded to the target/upstream verbatim. */
const STRIP_HEADERS = ["proxy-authorization", "proxy-connection"];

/** Constant-time string comparison that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Decide whether an incoming proxy request is allowed. When proxyCredentials is
 * anonymous every request passes; otherwise the client must present a matching
 * Basic Proxy-Authorization header.
 */
function clientAuthOk(proxyAuth: string | undefined): boolean {
  const creds = store.getConfig().proxyCredentials;
  if (creds.anonymous) return true;
  if (!proxyAuth) return false;
  const expected = buildBasicAuth(creds.user ?? "", creds.pass ?? "");
  return safeEqual(proxyAuth, expected);
}

/** Copy request headers, dropping anything proxy-hop-specific. */
function forwardHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...headers };
  for (const h of STRIP_HEADERS) delete out[h];
  return out;
}

/**
 * Resolve the parsed upstream proxy connection details for a "proxy" egress.
 * Returns null (and logs) if the egress is not a proxy or its URL is unparseable
 * so callers can fail the request cleanly instead of crashing.
 */
function upstreamForEgress(egress: Egress): ParsedUpstreamUrl | null {
  if (egress.kind !== "proxy" || egress.proxyIndex === undefined) return null;
  const cfg = store.getConfig();
  const upstream = cfg.upstreamProxies[egress.proxyIndex];
  if (upstream === undefined) {
    console.warn(`[proxy] egress ${egress.id} has no matching upstream config`);
    return null;
  }
  try {
    return parseUpstreamUrl(upstream.url);
  } catch (err) {
    console.warn(
      `[proxy] cannot parse upstream "${egress.name}": ${(err as Error).message}`,
    );
    return null;
  }
}

/** Split a "host:port" authority (CONNECT target) with a default port fallback. */
function splitHostPort(
  authority: string,
  defaultPort: number,
): { host: string; port: number } {
  const idx = authority.lastIndexOf(":");
  if (idx === -1) return { host: authority, port: defaultPort };
  const host = authority.slice(0, idx);
  const port = Number(authority.slice(idx + 1)) || defaultPort;
  return { host, port };
}

/** Send a 407 over a normal HTTP response (plain-HTTP path). */
function sendHttp407(res: http.ServerResponse): void {
  const body = "Proxy authentication required";
  res.writeHead(407, {
    "Proxy-Authenticate": REALM,
    "Content-Type": "text/plain",
    "Content-Length": Buffer.byteLength(body),
    Connection: "close",
  });
  res.end(body);
}

/** Send a 407 directly over a CONNECT client socket, then close it. */
function sendSocket407(socket: net.Socket): void {
  socket.write(
    "HTTP/1.1 407 Proxy Authentication Required\r\n" +
      `Proxy-Authenticate: ${REALM}\r\n` +
      "Content-Length: 0\r\n" +
      "Connection: close\r\n\r\n",
  );
  socket.end();
}

/**
 * Wire two sockets together as a bidirectional tunnel and make sure that a
 * failure or close on either side tears down the other. Never throws.
 *
 * `a` is always the client socket and `b` the server socket, so for usage
 * accounting client -> server bytes are OUT (upload) and server -> client bytes
 * are IN (download). When `egressId` is given we attach observer-only "data"
 * listeners that just tally byte counts; they never consume or alter the pipe.
 */
function bidirectionalPipe(a: net.Socket, b: net.Socket, egressId?: string): void {
  a.pipe(b);
  b.pipe(a);

  if (egressId !== undefined) {
    // a = client: bytes leaving the client are upload (OUT).
    a.on("data", (chunk: Buffer) => {
      try {
        store.recordBytes(egressId, 0, chunk.length);
      } catch {
        /* accounting must never disturb the tunnel */
      }
    });
    // b = server: bytes coming from the server are download (IN).
    b.on("data", (chunk: Buffer) => {
      try {
        store.recordBytes(egressId, chunk.length, 0);
      } catch {
        /* accounting must never disturb the tunnel */
      }
    });
  }

  const destroy = (): void => {
    a.destroy();
    b.destroy();
  };
  a.on("error", destroy);
  b.on("error", destroy);
  a.on("close", () => b.destroy());
  b.on("close", () => a.destroy());
}

/**
 * Account for a single in-flight request/tunnel against the active-connections
 * gauge. Calls connOpened() immediately and connClosed() exactly once when any
 * of the supplied emitters first emits "close" or "error" (a guard prevents the
 * error+close pair from double-decrementing). Never throws.
 */
function trackConnection(emitters: NodeJS.EventEmitter[]): void {
  try {
    store.connOpened();
  } catch {
    /* accounting must never disturb traffic */
  }
  let closed = false;
  const done = (): void => {
    if (closed) return;
    closed = true;
    try {
      store.connClosed();
    } catch {
      /* accounting must never disturb traffic */
    }
  };
  for (const em of emitters) {
    em.on("close", done);
    em.on("error", done);
  }
}

/* ------------------------------------------------------------------ */
/* Plain-HTTP proxying ("request" event)                               */
/* ------------------------------------------------------------------ */

function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  // Defensive: a socket-level error must never bubble up and crash the process.
  req.on("error", () => res.destroy());
  res.on("error", () => req.destroy());

  if (!clientAuthOk(req.headers["proxy-authorization"])) {
    sendHttp407(res);
    return;
  }

  // For plain-HTTP proxying req.url is an absolute URL ("http://host/path").
  let target: URL;
  try {
    target = new URL(req.url ?? "");
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad Request: expected an absolute proxy URL");
    return;
  }

  const egress = store.resolveActiveEgress();
  const egressId = egress.id;

  // Usage accounting: count this request once and track it as an open
  // connection for its whole lifetime. Request-body bytes from the client are
  // upload (OUT); the response-body counter is attached on proxyRes below.
  try {
    store.recordRequest(egressId);
  } catch {
    /* accounting must never disturb the request */
  }
  trackConnection([req, res]);
  req.on("data", (chunk: Buffer) => {
    try {
      store.recordBytes(egressId, 0, chunk.length);
    } catch {
      /* observer only */
    }
  });

  const headers = forwardHeaders(req.headers);

  let options: http.RequestOptions;
  let useHttps = false;
  if (egress.kind === "proxy") {
    const upstream = upstreamForEgress(egress);
    if (upstream === null) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Bad Gateway: upstream proxy is misconfigured");
      return;
    }
    // An "https://" upstream means we must reach the proxy itself over TLS.
    useHttps = upstream.secure;
    if (upstream.user !== undefined) {
      headers["proxy-authorization"] = buildBasicAuth(
        upstream.user,
        upstream.pass ?? "",
      );
    }
    // Through an upstream proxy the request line carries the full absolute URL.
    options = {
      host: upstream.host,
      port: upstream.port,
      method: req.method,
      path: req.url,
      headers,
    };
  } else {
    // DIRECT: connect straight to the origin server with an origin-form path.
    options = {
      host: target.hostname,
      port: target.port ? Number(target.port) : 80,
      method: req.method,
      path: (target.pathname || "/") + target.search,
      headers,
    };
  }

  console.log(
    `[proxy] HTTP ${req.method ?? "?"} ${target.host} via ${egress.name}`,
  );

  const proxyReq = (useHttps ? https : http).request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res);
    // Response-body bytes from upstream are download (IN). Observer only.
    proxyRes.on("data", (chunk: Buffer) => {
      try {
        store.recordBytes(egressId, chunk.length, 0);
      } catch {
        /* observer only */
      }
    });
  });

  proxyReq.on("error", (err) => {
    console.warn(`[proxy] upstream request error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Bad Gateway");
    } else {
      res.destroy();
    }
  });

  req.pipe(proxyReq);
}

/* ------------------------------------------------------------------ */
/* HTTPS tunnelling ("connect" event)                                  */
/* ------------------------------------------------------------------ */

function handleConnect(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
): void {
  // Attach an error handler immediately so a reset client never crashes us.
  clientSocket.on("error", () => clientSocket.destroy());

  if (!clientAuthOk(req.headers["proxy-authorization"])) {
    sendSocket407(clientSocket);
    return;
  }

  // For CONNECT, req.url is the "host:port" authority to tunnel to.
  const { host, port } = splitHostPort(req.url ?? "", 443);
  if (host === "") {
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    clientSocket.end();
    return;
  }

  const egress = store.resolveActiveEgress();
  const egressId = egress.id;
  console.log(`[proxy] CONNECT ${host}:${port} via ${egress.name}`);

  // Usage accounting: a CONNECT tunnel counts as one request, and stays an open
  // connection until the client socket closes. Byte counters are attached when
  // the tunnel is spliced (see bidirectionalPipe).
  try {
    store.recordRequest(egressId);
  } catch {
    /* accounting must never disturb the tunnel */
  }
  trackConnection([clientSocket]);

  if (egress.kind === "proxy") {
    const upstream = upstreamForEgress(egress);
    if (upstream === null) {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.end();
      return;
    }
    connectViaUpstream(clientSocket, head, host, port, upstream, egressId);
  } else {
    connectDirect(clientSocket, head, host, port, egressId);
  }
}

/** DIRECT tunnel: open a TCP socket to the origin and pipe both ways. */
function connectDirect(
  clientSocket: net.Socket,
  head: Buffer,
  host: string,
  port: number,
  egressId: string,
): void {
  const serverSocket = net.connect(port, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) serverSocket.write(head);
    bidirectionalPipe(clientSocket, serverSocket, egressId);
  });

  serverSocket.on("error", (err) => {
    console.warn(`[proxy] CONNECT direct error to ${host}:${port}: ${err.message}`);
    if (!clientSocket.destroyed) {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.end();
    }
  });
}

/**
 * Upstream tunnel: open a TCP socket to the upstream proxy, send our own CONNECT
 * line (with Proxy-Authorization if the upstream needs auth), parse its status
 * line and, on 200, splice the two sockets together.
 */
function connectViaUpstream(
  clientSocket: net.Socket,
  head: Buffer,
  host: string,
  port: number,
  upstream: ParsedUpstreamUrl,
  egressId: string,
): void {
  let serverSocket: net.Socket;

  const sendConnect = (): void => {
    let connectReq =
      `CONNECT ${host}:${port} HTTP/1.1\r\n` + `Host: ${host}:${port}\r\n`;
    if (upstream.user !== undefined) {
      connectReq += `Proxy-Authorization: ${buildBasicAuth(
        upstream.user,
        upstream.pass ?? "",
      )}\r\n`;
    }
    connectReq += "\r\n";
    serverSocket.write(connectReq);
  };

  // An "https://" upstream proxy must be reached over TLS; a plain one over TCP.
  serverSocket = upstream.secure
    ? tls.connect(
        { host: upstream.host, port: upstream.port, servername: upstream.host },
        sendConnect,
      )
    : net.connect(upstream.port, upstream.host, sendConnect);

  // Accumulate the upstream's CONNECT response until we have its header block.
  let buffer = Buffer.alloc(0);
  const onData = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    const sep = buffer.indexOf("\r\n\r\n");
    if (sep === -1) {
      // Guard against an upstream that never finishes its response headers.
      if (buffer.length > 65536) {
        serverSocket.destroy();
        if (!clientSocket.destroyed) {
          clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          clientSocket.end();
        }
      }
      return;
    }

    serverSocket.removeListener("data", onData);

    const statusLine = buffer.slice(0, sep).toString("ascii").split("\r\n")[0];
    const m = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine);
    const status = m ? Number(m[1]) : 0;

    if (status === 200) {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      // Forward any tunnelled bytes that arrived past the CONNECT headers.
      const leftover = buffer.slice(sep + 4);
      if (leftover.length > 0) clientSocket.write(leftover);
      if (head.length > 0) serverSocket.write(head);
      bidirectionalPipe(clientSocket, serverSocket, egressId);
    } else {
      console.warn(
        `[proxy] upstream ${upstream.host}:${upstream.port} refused CONNECT ` +
          `(${statusLine || "no status line"})`,
      );
      serverSocket.destroy();
      if (!clientSocket.destroyed) {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        clientSocket.end();
      }
    }
  };

  serverSocket.on("data", onData);
  serverSocket.on("error", (err) => {
    console.warn(
      `[proxy] upstream connect error to ${upstream.host}:${upstream.port}: ${err.message}`,
    );
    if (!clientSocket.destroyed) {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.end();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Server factory                                                      */
/* ------------------------------------------------------------------ */

/**
 * Create, start and return the forward proxy http.Server, listening on
 * PROXY_PORT (default 3128). The store must already be initialized.
 */
export function createProxyServer(): http.Server {
  const server = http.createServer(handleRequest);
  server.on("connect", handleConnect);

  // Malformed requests from a client must not take the whole server down.
  server.on("clientError", (err: NodeJS.ErrnoException, socket: net.Socket) => {
    if (socket.writable && !socket.destroyed) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } else {
      socket.destroy();
    }
  });

  const port = Number(process.env.PROXY_PORT || 3128);
  // BIND_ADDR scopes the listening interface. Unset → Node's default (all
  // interfaces), preserving the documented bridge usage where Docker's
  // `-p 127.0.0.1:3128:3128` provides the loopback guard. Set it to 127.0.0.1
  // when running with `--network host`, where there is no Docker port mapping
  // to constrain exposure and binding all interfaces would publish on the LAN.
  const host = process.env.BIND_ADDR || undefined;
  server.listen(port, host, () => {
    console.log(`[proxy] forward proxy listening on ${host ?? "0.0.0.0"}:${port}`);
  });

  return server;
}
