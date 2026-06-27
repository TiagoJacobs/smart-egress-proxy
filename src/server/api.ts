/**
 * Dashboard web server + JSON API.
 *
 * A single Express app that:
 *   - optionally enforces HTTP Basic auth (admin dashboard credentials) on
 *     every route (API and static assets alike);
 *   - exposes a tiny JSON API under /api for the React SPA;
 *   - serves the built SPA from STATIC_DIR with an index.html fallback so
 *     client-side routing works (and a placeholder page when the build is
 *     missing so the server still boots).
 *
 * All state flows through the shared store singleton, and every response is
 * passed through the sanitizers in util.ts so credentials never reach the
 * browser.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";

import type { Mode } from "../types.js";
import { store } from "../state.js";
import { sanitizeConfig, parseMode } from "../util.js";

/** Minimal page shown at "/" when the SPA build is not present yet. */
const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>smart-egress-proxy</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }
      code { background: #f0f0f0; padding: 0.1rem 0.3rem; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>smart-egress-proxy</h1>
    <p>The server is running, but the dashboard has not been built yet.</p>
    <p>Build it with <code>npm run build:dashboard</code>, or query the JSON API at
       <code>/api/status</code>.</p>
  </body>
</html>
`;

/**
 * Constant-time string comparison. Hashing first keeps the comparison
 * constant-time regardless of input length (so neither value's length leaks).
 */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * HTTP Basic auth gate. When the admin dashboard is configured as anonymous it
 * is a no-op; otherwise it requires a matching user/pass on every request and
 * replies 401 with a WWW-Authenticate header so browsers show a login prompt.
 */
function basicAuth(req: Request, res: Response, next: NextFunction): void {
  const creds = store.getConfig().adminDashboardCredentials;
  if (creds.anonymous) {
    next();
    return;
  }

  const header = req.headers.authorization;
  if (header && header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString(
      "utf8",
    );
    const sep = decoded.indexOf(":");
    const user = sep === -1 ? decoded : decoded.slice(0, sep);
    const pass = sep === -1 ? "" : decoded.slice(sep + 1);

    // Compare both fields regardless to avoid short-circuit timing differences.
    const userOk = safeEqual(user, creds.user ?? "");
    const passOk = safeEqual(pass, creds.pass ?? "");
    if (userOk && passOk) {
      next();
      return;
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="smart-egress-proxy", charset="UTF-8"');
  res.status(401).type("text").send("Authentication required.");
}

/** Assemble the full status payload sent to the dashboard. Never leaks secrets. */
function buildStatus(): object {
  const cfg = store.getConfig();
  return {
    config: sanitizeConfig(cfg),
    egresses: store.getEgresses(),
    mode: store.getMode(),
    activeEgressId: store.resolveActiveEgress().id,
    health: store.getHealth(),
    history: store.getHistory(),
    usage: store.getUsage(),
    serverTime: new Date().toISOString(),
  };
}

/**
 * Coerce a request body into a Mode. Accepts either:
 *   { mode: "AUTO" | "DIRECT" | "PROXY:<index>" }
 * or the structured form:
 *   { type: "AUTO" | "DIRECT" | "PROXY", proxyIndex?: number }
 * Throws a clear Error on anything else (callers map this to HTTP 400).
 */
function modeFromBody(body: unknown): Mode {
  if (typeof body !== "object" || body === null) {
    throw new Error('Request body must be a JSON object with "mode" or "type".');
  }
  const b = body as Record<string, unknown>;

  if (typeof b.mode === "string") {
    // parseMode handles "AUTO" | "DIRECT" | "PROXY:<index>" (case-insensitive).
    return parseMode(b.mode);
  }

  if (typeof b.type === "string") {
    const t = b.type.toUpperCase();
    if (t === "AUTO") return { type: "AUTO" };
    if (t === "DIRECT") return { type: "DIRECT" };
    if (t === "PROXY") {
      const idx =
        typeof b.proxyIndex === "number" ? b.proxyIndex : Number(b.proxyIndex);
      if (Number.isInteger(idx)) return { type: "PROXY", proxyIndex: idx };
      throw new Error('PROXY mode requires an integer "proxyIndex".');
    }
    throw new Error(`Invalid mode type "${b.type}" (expected AUTO, DIRECT or PROXY).`);
  }

  throw new Error('Request body must include "mode" or "type".');
}

/**
 * Build, wire and start the dashboard + API HTTP server.
 * Listens on DASHBOARD_PORT (default 443) and returns the http.Server.
 * Must be called after the store has been initialised.
 */
export function createApiServer(): http.Server {
  const app: Express = express();
  app.disable("x-powered-by");

  const staticDir = process.env.STATIC_DIR ?? "./dashboard/dist";
  const indexHtml = path.resolve(staticDir, "index.html");

  // Parse JSON bodies for the API (no-op for non-JSON requests).
  app.use(express.json());

  // Auth gate covers the API and the static dashboard alike.
  app.use(basicAuth);

  // --- JSON API -----------------------------------------------------------

  // Full snapshot of config (sanitised), egresses, mode, active egress, health.
  app.get("/api/status", (_req: Request, res: Response) => {
    res.json(buildStatus());
  });

  // Change the routing mode, then echo the full status back.
  app.post("/api/mode", (req: Request, res: Response) => {
    let mode: Mode;
    try {
      mode = modeFromBody(req.body);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    try {
      store.setMode(mode); // validates proxyIndex range + persists to disk
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    res.json(buildStatus());
  });

  // Trigger an immediate probe cycle (best-effort, fire-and-forget).
  app.post("/api/probe/run", (_req: Request, res: Response) => {
    void (async () => {
      try {
        const prober = await import("../prober/prober.js");
        await prober.runProbeCycle();
      } catch (err) {
        console.warn(`[api] Immediate probe run failed: ${(err as Error).message}`);
      }
    })();
    res.status(202).json({ accepted: true });
  });

  // Unmatched /api/* routes -> JSON 404 (rather than the SPA fallback).
  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  // --- Static SPA ---------------------------------------------------------

  // Serve built assets. A missing directory is harmless: express.static just
  // falls through to the next handler instead of crashing.
  app.use(express.static(staticDir));

  // SPA fallback: any other GET/HEAD serves index.html (client-side routing),
  // or the placeholder page when the build is absent. Everything else is 404.
  app.use((req: Request, res: Response) => {
    if (req.method === "GET" || req.method === "HEAD") {
      if (fs.existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        res.status(200).type("html").send(PLACEHOLDER_HTML);
      }
      return;
    }
    res.status(404).type("text").send("Not found");
  });

  const server = http.createServer(app);
  const port = Number(process.env.DASHBOARD_PORT ?? 443);
  server.listen(port, () => {
    console.log(`[api] Dashboard + API listening on port ${port}`);
  });

  return server;
}
