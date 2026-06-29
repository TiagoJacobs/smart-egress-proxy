/**
 * Entrypoint.
 *
 * Wires the whole application together in a single Node.js process:
 *   1. Load and validate the configuration (SEP_CONFIG), a clear error and a
 *      non-zero exit on any problem.
 *   2. Initialise the shared in-memory store (builds egresses, restores the
 *      persisted/default mode).
 *   3. Start the three long-running pieces that share that store:
 *        - the forward HTTP proxy   (PROXY_PORT, default 3128)
 *        - the dashboard + JSON API (DASHBOARD_PORT, default 8080)
 *        - the background prober    (every settings.probeIntervalMinutes)
 *   4. Shut everything down cleanly on SIGTERM / SIGINT.
 *
 * Each sub-server logs its own "listening" line; this module additionally logs a
 * single startup summary (both ports + the initial mode) so the operator sees
 * the effective configuration at a glance.
 */

import { loadConfig } from "./config.js";
import { store } from "./state.js";
import { modeToString } from "./util.js";
import { createProxyServer } from "./proxy/server.js";
import { createApiServer } from "./server/api.js";
import { startProber, type ProberHandle } from "./prober/prober.js";

import type http from "node:http";

/** Resolve the effective ports the way each sub-server resolves them, for logging. */
function resolvePorts(): { proxyPort: number; dashboardPort: number } {
  return {
    proxyPort: Number(process.env.PROXY_PORT || 3128),
    dashboardPort: Number(process.env.DASHBOARD_PORT ?? 8080),
  };
}

function main(): void {
  // 1. Configuration ---------------------------------------------------------
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`[startup] Configuration error:\n${(err as Error).message}`);
    process.exit(1);
    return; // unreachable, but keeps the type-checker happy.
  }

  // 2. Shared store ----------------------------------------------------------
  store.initStore(config);

  // 3. Start the three sub-systems (each begins listening / running here). ----
  const proxyServer: http.Server = createProxyServer();
  const apiServer: http.Server = createApiServer();
  const prober: ProberHandle = startProber();

  const { proxyPort, dashboardPort } = resolvePorts();
  console.log(
    `[startup] smart-egress-proxy ready, proxy on :${proxyPort}, ` +
      `dashboard on :${dashboardPort}, initial mode ${modeToString(store.getMode())}.`,
  );

  // 4. Graceful shutdown -----------------------------------------------------
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] Received ${signal}, shutting down...`);

    // Stop the prober's timer first so no new cycle starts mid-shutdown.
    prober.stop();

    // Close both HTTP servers; once both are done (or after a hard deadline),
    // exit the process.
    let pending = 2;
    const done = (): void => {
      pending -= 1;
      if (pending === 0) {
        console.log("[shutdown] All servers closed. Bye.");
        clearTimeout(forceExit);
        process.exit(0);
      }
    };

    proxyServer.close(() => done());
    apiServer.close(() => done());

    // Safety net: never hang forever waiting on lingering keep-alive sockets.
    const forceExit = setTimeout(() => {
      console.warn("[shutdown] Forcing exit after timeout.");
      process.exit(0);
    }, 10_000);
    // Do not let this timer keep the event loop alive on its own.
    forceExit.unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
