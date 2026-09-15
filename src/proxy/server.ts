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
  formatAuthority,
  unbracketHost,
  type ParsedUpstreamUrl,
} from "../util.js";
import type { Egress } from "../types.js";

const REALM = 'Basic realm="smart-egress-proxy"';

/**
 * Inactivity budget for anything we open towards an upstream or an origin. It is
 * an idle timer, not a total deadline, so a slow but progressing transfer is
 * never cut short; it only fires when nothing at all moves. Without it a silent
 * or half-dead peer holds a client socket, and its own, for as long as the
 * process lives.
 */
const UPSTREAM_IDLE_TIMEOUT_MS = 60_000;

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

/**
 * Split a "host:port" authority (CONNECT target) with a default port fallback.
 * A bracketed IPv6 literal is found by its closing bracket and returned bare,
 * because scanning for the last ":" would land inside the address and net.connect
 * cannot resolve a bracketed string. Use formatAuthority to put it back together.
 */
function splitHostPort(
  authority: string,
  defaultPort: number,
): { host: string; port: number } {
  if (authority.startsWith("[")) {
    const closing = authority.indexOf("]");
    if (closing === -1) return { host: "", port: defaultPort };
    const host = authority.slice(1, closing);
    const remainder = authority.slice(closing + 1);
    const port = remainder.startsWith(":")
      ? Number(remainder.slice(1)) || defaultPort
      : defaultPort;
    return { host, port };
  }
  const idx = authority.lastIndexOf(":");
  if (idx === -1) return { host: authority, port: defaultPort };
  const host = authority.slice(0, idx);
  const port = Number(authority.slice(idx + 1)) || defaultPort;
  return { host, port };
}

/**
 * Clamp an upstream status code to what ServerResponse accepts. The HTTP parser
 * happily produces any three-digit status, including 0 to 99, while writeHead
 * throws ERR_HTTP_INVALID_STATUS_CODE below 100. Forwarding one verbatim would
 * escape as an uncaught exception and take the whole process down, so anything
 * outside 100 to 999 is reported as a 502 instead.
 */
function safeStatusCode(statusCode: number | undefined): number {
  if (statusCode === undefined || !Number.isInteger(statusCode)) return 502;
  if (statusCode < 100 || statusCode > 999) return 502;
  return statusCode;
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

/**
 * Map the active egress onto the options for one outgoing request. Through an
 * upstream proxy the request line carries the full absolute URL and the proxy's
 * own credentials; DIRECT connects straight to the origin in origin form.
 * Returns null when a proxy egress is misconfigured, so callers can fail cleanly.
 *
 * Shared by the plain-HTTP path and the protocol-upgrade path, which differ only
 * in what they do with the response.
 */
function buildForwardOptions(
  egress: Egress,
  req: http.IncomingMessage,
  target: URL,
): { options: https.RequestOptions; useHttps: boolean } | null {
  const headers = forwardHeaders(req.headers);

  if (egress.kind === "proxy") {
    const upstream = upstreamForEgress(egress);
    if (upstream === null) return null;
    if (upstream.user !== undefined) {
      headers["proxy-authorization"] = buildBasicAuth(
        upstream.user,
        upstream.pass ?? "",
      );
    }
    const options: https.RequestOptions = {
      host: upstream.host,
      port: upstream.port,
      method: req.method,
      path: req.url,
      headers,
    };
    // An "https://" upstream means we reach the proxy itself over TLS. `headers`
    // still carries the destination in Host, which is what the upstream proxy
    // needs, but Node derives the TLS servername from that header when it is
    // present. Left alone it would validate the upstream's certificate against
    // the destination hostname and fail every request. Pin it to the proxy
    // instead; an empty string disables SNI for an IP-addressed upstream (RFC
    // 6066 forbids IP servernames), leaving the certificate checked against the
    // IP itself.
    if (upstream.secure) {
      options.servername = net.isIP(upstream.host) ? "" : upstream.host;
    }
    return { options, useHttps: upstream.secure };
  }

  // DIRECT: connect straight to the origin server with an origin-form path.
  // URL.hostname keeps the brackets around an IPv6 literal, which http.request
  // would then try to resolve as a hostname.
  return {
    options: {
      host: unbracketHost(target.hostname),
      port: target.port ? Number(target.port) : 80,
      method: req.method,
      path: (target.pathname || "/") + target.search,
      headers,
    },
    useHttps: false,
  };
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

  const forward = buildForwardOptions(egress, req, target);
  if (forward === null) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Bad Gateway: upstream proxy is misconfigured");
    return;
  }
  const { options, useHttps } = forward;

  console.log(
    `[proxy] HTTP ${req.method ?? "?"} ${target.host} via ${egress.name}`,
  );

  const proxyReq = (useHttps ? https : http).request(options, (proxyRes) => {
    try {
      res.writeHead(safeStatusCode(proxyRes.statusCode), proxyRes.headers);
    } catch (err) {
      // A header the upstream parser accepted can still be rejected on the way
      // out. Fail this one request rather than letting the throw escape the
      // callback, where nothing would catch it.
      console.warn(
        `[proxy] cannot forward upstream response headers: ${(err as Error).message}`,
      );
      proxyRes.destroy();
      if (res.headersSent) {
        res.destroy();
      } else {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("Bad Gateway");
      }
      return;
    }
    proxyRes.pipe(res);

    // A response that dies mid-body must reach the client as a broken response.
    // IncomingMessage swallows its own "error" when nothing listens for it, so
    // without these two handlers a truncated upstream body leaves the client
    // waiting forever for bytes that will never arrive.
    proxyRes.on("error", (err) => {
      console.warn(`[proxy] upstream response error: ${err.message}`);
      res.destroy();
    });
    proxyRes.on("close", () => {
      if (!proxyRes.complete) res.destroy();
    });

    // Response-body bytes from upstream are download (IN). Observer only.
    proxyRes.on("data", (chunk: Buffer) => {
      try {
        store.recordBytes(egressId, chunk.length, 0);
      } catch {
        /* observer only */
      }
    });
  });

  // Covers both the connect phase, where nothing flows yet, and a transfer that
  // stalls halfway. Destroying with an error routes it through the handler below
  // so the client gets a 502 instead of an open socket.
  proxyReq.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
    proxyReq.destroy(
      new Error(`no activity for ${UPSTREAM_IDLE_TIMEOUT_MS}ms`),
    );
  });

  proxyReq.on("error", (err) => {
    console.warn(`[proxy] upstream request error: ${err.message}`);
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Bad Gateway");
  });

  // The client leaving must tear the upstream request down with it. pipe() only
  // unpipes and pauses its source on a dead destination, so every cancelled
  // download or upload would otherwise strand an established upstream socket
  // that nothing ever reads again: one leaked descriptor per cancelled request.
  res.on("close", () => {
    if (!res.writableFinished) proxyReq.destroy();
  });
  // Both directions need this, not just the response. When the origin answers
  // before it has read the whole body, the response can finish while the request
  // body is still in flight; a client that disappears then leaves the upstream
  // waiting for a body that will never arrive, which the check above cannot see.
  req.on("close", () => {
    if (!req.readableEnded) proxyReq.destroy();
  });

  req.pipe(proxyReq);
}

/* ------------------------------------------------------------------ */
/* Protocol upgrades ("upgrade" event)                                 */
/* ------------------------------------------------------------------ */

/**
 * Plain-HTTP protocol upgrades. This is how a browser opens a ws:// WebSocket
 * through a forward proxy: an absolute-form GET carrying Upgrade and Connection
 * headers, never a CONNECT (CONNECT is only used for wss://). The same shape
 * covers h2c and any other plain-HTTP upgrade.
 *
 * Without an "upgrade" listener Node delivered these to the plain-HTTP handler,
 * where the outgoing ClientRequest silently dropped the origin's 101 without
 * emitting an error, so the client waited forever on a socket that would never
 * see a byte. Relay the 101 verbatim and splice the two sockets together.
 */
function handleUpgrade(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
): void {
  clientSocket.on("error", () => clientSocket.destroy());

  if (!clientAuthOk(req.headers["proxy-authorization"])) {
    sendSocket407(clientSocket);
    return;
  }

  let target: URL;
  try {
    target = new URL(req.url ?? "");
  } catch {
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    clientSocket.end();
    return;
  }

  const egress = store.resolveActiveEgress();
  const egressId = egress.id;
  console.log(
    `[proxy] UPGRADE ${String(req.headers.upgrade ?? "?")} ${target.host} ` +
      `via ${egress.name}`,
  );

  try {
    store.recordRequest(egressId);
  } catch {
    /* accounting must never disturb the upgrade */
  }
  trackConnection([clientSocket]);

  const forward = buildForwardOptions(egress, req, target);
  if (forward === null) {
    clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    clientSocket.end();
    return;
  }

  const proxyReq = (forward.useHttps ? https : http).request(forward.options);
  const guard = guardTunnelHandshake(
    clientSocket,
    proxyReq,
    head,
    `UPGRADE ${target.host} via ${egress.name}`,
  );

  proxyReq.on("upgrade", (proxyRes, serverSocket, serverHead) => {
    const pending = guard.release();
    const raw = proxyRes.rawHeaders;
    let response = `HTTP/1.1 ${proxyRes.statusCode ?? 101} ${
      proxyRes.statusMessage ?? "Switching Protocols"
    }\r\n`;
    for (let i = 0; i + 1 < raw.length; i += 2) {
      response += `${raw[i]}: ${raw[i + 1]}\r\n`;
    }
    clientSocket.write(`${response}\r\n`);
    if (serverHead.length > 0) clientSocket.write(serverHead);
    if (pending.length > 0) serverSocket.write(pending);
    bidirectionalPipe(clientSocket, serverSocket, egressId);
  });

  proxyReq.on("response", (proxyRes) => {
    // The peer declined the upgrade and answered normally (426, 404, 200...).
    // Relay that answer instead of a 502, so the client sees the real reason, and
    // frame it by closing: the body we pipe is already decoded, so the upstream's
    // own framing headers must not be forwarded.
    guard.release();
    const raw = proxyRes.rawHeaders;
    let response = `HTTP/1.1 ${safeStatusCode(proxyRes.statusCode)} ${
      proxyRes.statusMessage ?? ""
    }\r\n`;
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const name = raw[i].toLowerCase();
      if (name === "transfer-encoding" || name === "content-length") continue;
      response += `${raw[i]}: ${raw[i + 1]}\r\n`;
    }
    response += "Connection: close\r\n\r\n";
    if (clientSocket.destroyed) {
      proxyRes.destroy();
      return;
    }
    clientSocket.write(response);
    proxyRes.pipe(clientSocket);
    proxyRes.on("error", () => clientSocket.destroy());
  });

  proxyReq.on("error", (err) => guard.fail(err.message));

  // An upgrade request carries no body.
  proxyReq.end();
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
  console.log(
    `[proxy] CONNECT ${formatAuthority(host, port)} via ${egress.name}`,
  );

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

/**
 * Cap on client bytes buffered before a tunnel is spliced. A TLS ClientHello is
 * a few hundred bytes, so anything approaching this is not a real client.
 */
const MAX_PENDING_CLIENT_BYTES = 65536;

/**
 * Own the window between accepting a CONNECT and splicing the tunnel. That window
 * used to have no owner at all: the client could leave, and the peer could go
 * quiet or hang up, with nothing noticing either way.
 *
 * Returns two one-shot callbacks. `fail` answers the client 502 and tears both
 * sockets down; `release` ends the guarding and returns the client bytes that
 * arrived in the meantime, for the caller to forward. Because
 * they are one-shot, a 502 that belongs to a failed handshake can never be
 * written into a tunnel that already carries traffic.
 *
 * The far side is anything with destroy() and setTimeout(), which covers both a
 * raw socket (CONNECT) and an outgoing ClientRequest (protocol upgrades).
 */
interface HandshakePeer {
  destroy(): void;
  setTimeout(msecs: number, callback?: () => void): unknown;
}

function guardTunnelHandshake(
  clientSocket: net.Socket,
  serverSocket: HandshakePeer,
  head: Buffer,
  label: string,
): { release: () => Buffer; fail: (reason: string) => void } {
  let settled = false;
  let pending = head;

  const fail = (reason: string): void => {
    if (settled) return;
    settled = true;
    console.warn(`[proxy] ${label} failed: ${reason}`);
    serverSocket.destroy();
    if (!clientSocket.destroyed) {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.end();
    }
  };

  // Read the client's early bytes instead of leaving the socket paused. Paused
  // with nobody reading it, a client that hangs up mid-handshake is never
  // noticed: its FIN sits unread, so the client socket stays in CLOSE-WAIT and
  // the peer socket stays established, two descriptors held for the life of the
  // process. Whatever arrives here is handed to the peer at splice time, so
  // nothing the client sends ahead of the 200 is lost or reordered.
  const onClientData = (chunk: Buffer): void => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > MAX_PENDING_CLIENT_BYTES) {
      fail("client sent too much data before the tunnel was established");
    }
  };
  const onClientGone = (): void => fail("client went away during the handshake");

  clientSocket.on("data", onClientData);
  clientSocket.once("end", onClientGone);
  clientSocket.once("close", onClientGone);

  // Nothing bounded this wait before, so a peer that accepted the connection and
  // then said nothing held the client open indefinitely. This also covers a
  // blackholed SYN, where the kernel would otherwise decide the deadline.
  serverSocket.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
    fail(`no response within ${UPSTREAM_IDLE_TIMEOUT_MS}ms`);
  });

  const release = (): Buffer => {
    settled = true;
    clientSocket.removeListener("data", onClientData);
    clientSocket.removeListener("end", onClientGone);
    clientSocket.removeListener("close", onClientGone);
    // Drop the idle timer: a spliced tunnel is allowed to sit quiet for as long
    // as both ends want (an idle WebSocket, a held-open session), and from here
    // bidirectionalPipe owns teardown on both sides.
    serverSocket.setTimeout(0);
    return pending;
  };

  return { release, fail };
}

/** DIRECT tunnel: open a TCP socket to the origin and pipe both ways. */
function connectDirect(
  clientSocket: net.Socket,
  head: Buffer,
  host: string,
  port: number,
  egressId: string,
): void {
  const serverSocket = net.connect(port, host);
  const guard = guardTunnelHandshake(
    clientSocket,
    serverSocket,
    head,
    `CONNECT direct to ${formatAuthority(host, port)}`,
  );

  serverSocket.on("connect", () => {
    const pending = guard.release();
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (pending.length > 0) serverSocket.write(pending);
    bidirectionalPipe(clientSocket, serverSocket, egressId);
  });

  // One-shot: once spliced, teardown belongs to bidirectionalPipe, so a later
  // reset can no longer inject an HTTP 502 into an established byte stream.
  serverSocket.on("error", (err) => guard.fail(err.message));
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
  const target = formatAuthority(host, port);
  const via = formatAuthority(upstream.host, upstream.port);
  let serverSocket: net.Socket;

  const sendConnect = (): void => {
    let connectReq = `CONNECT ${target} HTTP/1.1\r\n` + `Host: ${target}\r\n`;
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
  // The servername is pinned to the proxy, never to the destination. RFC 6066
  // forbids an IP servername and Node deprecates setting one, so an IP-addressed
  // upstream sends no SNI and its certificate is checked against the IP itself.
  serverSocket = upstream.secure
    ? tls.connect(
        {
          host: upstream.host,
          port: upstream.port,
          ...(net.isIP(upstream.host) ? {} : { servername: upstream.host }),
        },
        sendConnect,
      )
    : net.connect(upstream.port, upstream.host, sendConnect);

  const guard = guardTunnelHandshake(
    clientSocket,
    serverSocket,
    head,
    `CONNECT ${target} via ${via}`,
  );

  // Accumulate the upstream's CONNECT response until we have its header block.
  let buffer = Buffer.alloc(0);
  const onData = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);

    // Loop so that interim 1xx responses, each its own header block, are skipped
    // rather than mistaken for the final status.
    for (;;) {
      const sep = buffer.indexOf("\r\n\r\n");
      if (sep === -1) {
        // Guard against an upstream that never finishes its response headers.
        if (buffer.length > 65536) {
          guard.fail("response headers exceeded 64 KiB");
        }
        return;
      }

      const statusLine = buffer.slice(0, sep).toString("ascii").split("\r\n")[0];
      const m = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine);
      const status = m ? Number(m[1]) : 0;

      if (status >= 100 && status < 200) {
        buffer = buffer.slice(sep + 4);
        continue;
      }

      serverSocket.removeListener("data", onData);

      if (status !== 200) {
        guard.fail(`refused (${statusLine || "no status line"})`);
        return;
      }

      const pending = guard.release();
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      // Forward any tunnelled bytes that arrived past the CONNECT headers.
      const leftover = buffer.slice(sep + 4);
      if (leftover.length > 0) clientSocket.write(leftover);
      if (pending.length > 0) serverSocket.write(pending);
      bidirectionalPipe(clientSocket, serverSocket, egressId);
      return;
    }
  };

  serverSocket.on("data", onData);
  serverSocket.on("error", (err) => guard.fail(err.message));

  // A clean FIN is not an error, so an upstream that hangs up before completing
  // its response would otherwise leave the client waiting on a socket that will
  // never carry either a 200 or a 502. Both are no-ops once spliced.
  const closedEarly = (): void =>
    guard.fail("upstream closed before completing its CONNECT response");
  serverSocket.on("end", closedEarly);
  serverSocket.on("close", closedEarly);
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
  // Registering this listener is what stops Node from funnelling ws:// upgrades
  // into the plain-HTTP handler, where the 101 was dropped and the client hung.
  server.on("upgrade", handleUpgrade);

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
  // PROXY_BIND_ADDR overrides BIND_ADDR for the proxy alone, useful to keep the
  // forward proxy on loopback while the dashboard binds elsewhere (see api.ts).
  const host = process.env.PROXY_BIND_ADDR || process.env.BIND_ADDR || undefined;
  server.listen(port, host, () => {
    console.log(`[proxy] forward proxy listening on ${host ?? "0.0.0.0"}:${port}`);
  });

  return server;
}
