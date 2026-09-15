/**
 * Background prober.
 *
 * Periodically tests every monitored URL through every egress (the DIRECT
 * connection plus each configured upstream proxy) and records the resulting
 * health in the shared store. The store's AUTO mode then routes live traffic
 * through the highest-priority egress that the prober found healthy.
 *
 * Design notes:
 *  - A cycle iterates egresses sequentially and, within each egress, URLs
 *    sequentially. This keeps load predictable and avoids hammering upstreams.
 *  - Every probe is guarded by a hard timeout (AbortController + undici
 *    headers/body timeouts) so a single hung connection can never stall the
 *    whole cycle.
 *  - All errors are caught and turned into a failed result; one bad egress or
 *    URL never aborts the cycle.
 *  - Each probe downloads at most `fetchBytesLimit` bytes of the response and
 *    times that bounded transfer; the body is then destroyed to release the
 *    socket promptly.
 */

import { request, ProxyAgent, Agent } from "undici";
import type { Dispatcher } from "undici";

import { store } from "../state.js";
import { parseUpstreamUrl, buildBasicAuth, formatAuthority } from "../util.js";
import type {
  AppConfig,
  Egress,
  MonitoredUrl,
  UrlProbeResult,
} from "../types.js";

/**
 * Floor for a probe's hard timeout. The actual ceiling per probe is
 * max(HARD_TIMEOUT_MS, acceptedResponseTimeMs * 2): `acceptedResponseTimeMs`
 * decides healthy/slow, while this hard cap only exists so a dead or trickling
 * connection cannot hang the cycle forever.
 */
const HARD_TIMEOUT_MS = 30_000;

/** How long to wait for a dispatcher to close gracefully before forcing it. */
const CLEANUP_TIMEOUT_MS = 5_000;

/**
 * Resolve `promise`, or fall back to `onTimeout()` once `ms` has elapsed. Nothing
 * in a cycle may outlive its budget: a cycle that never returns holds the
 * in-flight guard forever, and from then on nothing is ever re-probed, health
 * freezes at its last value and failover stops happening at all. `promise` must
 * not reject, or the rejection is left unhandled when the deadline wins.
 */
async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A running prober that can be stopped. */
export interface ProberHandle {
  /** Stop the periodic timer. In-flight cycles are allowed to finish. */
  stop(): void;
}

interface BuiltDispatcher {
  dispatcher: Dispatcher;
  /** Gracefully closes the dispatcher created for this egress. */
  close(): Promise<void>;
  /** Forces it down when a graceful close does not come back. */
  destroy(): Promise<void>;
}

/** Truncate and prefix an unknown error into a short, log-safe string. */
function shortError(err: unknown): string {
  let message: string;
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    message =
      typeof code === "string" && code.length > 0
        ? `${code}: ${err.message}`
        : err.message || err.name || String(err);
  } else {
    message = String(err);
  }
  return message.length > 200 ? `${message.slice(0, 200)}...` : message;
}

/**
 * Build the undici dispatcher used to reach the network for a given egress:
 * a fresh Agent for DIRECT, or a ProxyAgent for an upstream proxy. Throws if a
 * proxy egress references a missing/invalid upstream entry.
 */
function buildDispatcher(egress: Egress, config: AppConfig): BuiltDispatcher {
  if (egress.kind === "direct") {
    const agent = new Agent({
      headersTimeout: HARD_TIMEOUT_MS,
      bodyTimeout: HARD_TIMEOUT_MS,
    });
    return {
      dispatcher: agent,
      close: () => agent.close(),
      destroy: () => agent.destroy(),
    };
  }

  const index = egress.proxyIndex;
  if (
    index === undefined ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= config.upstreamProxies.length
  ) {
    throw new Error(`no upstream proxy at index ${String(index)}`);
  }

  const parsed = parseUpstreamUrl(config.upstreamProxies[index].url);
  const options: ProxyAgent.Options = {
    // formatAuthority re-brackets an IPv6 literal; undici rejects the bare form.
    uri: `${parsed.secure ? "https" : "http"}://${formatAuthority(parsed.host, parsed.port)}`,
    headersTimeout: HARD_TIMEOUT_MS,
    bodyTimeout: HARD_TIMEOUT_MS,
  };
  // Pass credentials via the Proxy-Authorization token so special characters in
  // the password never need URL-encoding inside the proxy URI.
  if (parsed.user !== undefined && parsed.pass !== undefined) {
    options.token = buildBasicAuth(parsed.user, parsed.pass);
  }

  const agent = new ProxyAgent(options);
  return {
    dispatcher: agent,
    close: () => agent.close(),
    destroy: () => agent.destroy(),
  };
}

/**
 * Probe a single monitored URL through the given dispatcher. Never throws:
 * any failure (network error, timeout, bad status, too slow) is returned as a
 * result with ok=false.
 *
 * Downloads at most `fetchBytesLimit` bytes of the body and measures how long
 * that bounded transfer takes, then compares it against `acceptedResponseTimeMs`.
 */
async function runProbe(
  dispatcher: Dispatcher,
  monitored: MonitoredUrl,
): Promise<UrlProbeResult> {
  const hardCap = Math.max(HARD_TIMEOUT_MS, monitored.acceptedResponseTimeMs * 2);
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), hardCap);
  let bytesDownloaded = 0;

  try {
    const res = await request(monitored.url, {
      method: "GET",
      dispatcher,
      signal: controller.signal,
      headersTimeout: HARD_TIMEOUT_MS,
      bodyTimeout: HARD_TIMEOUT_MS,
      // Ask for an undecoded body so the byte count reflects the real,
      // uncompressed transfer size rather than a gzipped wire size.
      headers: {
        "accept-encoding": "identity",
        "user-agent": "smart-egress-proxy-prober",
      },
    });

    const limit = monitored.fetchBytesLimit;
    try {
      for await (const chunk of res.body) {
        bytesDownloaded += (chunk as Buffer).length;
        if (bytesDownloaded >= limit) break;
      }
    } finally {
      // Release the socket as soon as we hit the limit (or the body ends).
      res.body.destroy();
    }

    const elapsed = performance.now() - start;
    const ok =
      res.statusCode === monitored.expectedResponseCode &&
      elapsed <= monitored.acceptedResponseTimeMs;

    return {
      url: monitored.url,
      ok,
      responseCode: res.statusCode,
      responseTimeMs: Math.round(elapsed),
      bytesDownloaded,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    const elapsed = performance.now() - start;
    const error = controller.signal.aborted
      ? `download did not finish within ${hardCap}ms`
      : shortError(err);
    return {
      url: monitored.url,
      ok: false,
      responseTimeMs: Math.round(elapsed),
      bytesDownloaded: bytesDownloaded > 0 ? bytesDownloaded : undefined,
      error,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe one URL, guaranteed to return. The AbortController inside runProbe is not
 * enough on its own: for some dispatcher failures the underlying request promise
 * never settles even after the abort, which used to wedge the whole cycle
 * permanently. Reproduced against an upstream proxy that accepts the connection
 * and then refuses CONNECT, where the request neither resolved nor rejected.
 */
async function probeUrl(
  dispatcher: Dispatcher,
  monitored: MonitoredUrl,
): Promise<UrlProbeResult> {
  const hardCap = Math.max(HARD_TIMEOUT_MS, monitored.acceptedResponseTimeMs * 2);
  const deadline = hardCap + 1_000;
  const start = performance.now();
  // runProbe catches everything and never rejects, so racing it is safe.
  return withDeadline(runProbe(dispatcher, monitored), deadline, () => ({
    url: monitored.url,
    ok: false,
    responseTimeMs: Math.round(performance.now() - start),
    error: `probe did not settle within ${deadline}ms`,
    checkedAt: new Date().toISOString(),
  }));
}

/**
 * Probe every monitored URL through a single egress and write the aggregated
 * health back to the store. An egress is healthy only when every monitored URL
 * is ok (vacuously healthy when no URLs are configured). Never throws.
 */
async function probeEgress(egress: Egress, config: AppConfig): Promise<void> {
  let built: BuiltDispatcher;
  try {
    built = buildDispatcher(egress, config);
  } catch (err) {
    // Could not even build the route: mark every URL failed.
    const message = `egress setup failed: ${shortError(err)}`;
    const results: UrlProbeResult[] = config.monitoredUrls.map((m) => ({
      url: m.url,
      ok: false,
      error: message,
      checkedAt: new Date().toISOString(),
    }));
    store.setEgressHealth({
      egressId: egress.id,
      healthy: false,
      results,
      lastCheckedAt: new Date().toISOString(),
    });
    return;
  }

  try {
    const results: UrlProbeResult[] = [];
    for (const monitored of config.monitoredUrls) {
      results.push(await probeUrl(built.dispatcher, monitored));
    }
    const healthy = results.every((r) => r.ok);
    store.setEgressHealth({
      egressId: egress.id,
      healthy,
      results,
      lastCheckedAt: new Date().toISOString(),
    });
  } finally {
    // A graceful close waits on in-flight requests, so it can hang for exactly
    // the reasons probeUrl guards against. Bound it, then force the teardown.
    const closed = await withDeadline(
      built.close().then(
        () => true,
        () => true,
      ),
      CLEANUP_TIMEOUT_MS,
      () => false,
    );
    if (!closed) {
      void built.destroy().catch(() => undefined);
    }
  }
}

/**
 * Run exactly one probe cycle: probe every egress (sequentially) against every
 * monitored URL and update the store. Resolves once all egresses are recorded.
 * Never rejects, individual egress failures are isolated.
 */
export async function runProbeCycle(): Promise<void> {
  const config = store.getConfig();
  const egresses = store.getEgresses();

  for (const egress of egresses) {
    try {
      await probeEgress(egress, config);
    } catch (err) {
      // Defensive: probeEgress is designed not to throw, but never let one
      // egress abort the cycle.
      console.warn(
        `[prober] unexpected error probing egress "${egress.id}": ${shortError(err)}`,
      );
    }
  }
}

/**
 * True while a cycle is in flight. Module-level so the periodic timer and the
 * dashboard's "probe now" endpoint share one guard.
 */
let cycleRunning = false;

/**
 * Run one cycle unless one is already running, returning false when it declined.
 * The API endpoint used to call runProbeCycle directly, bypassing the timer's
 * guard, so repeated calls piled up unbounded concurrent cycles. Each cycle fans
 * out egresses x urls outbound requests of up to 30s, and 50 of them at once also
 * overwrote the whole 60-point history ring.
 */
export async function runProbeCycleIfIdle(): Promise<boolean> {
  if (cycleRunning) return false;
  cycleRunning = true;
  try {
    await runProbeCycle();
    return true;
  } finally {
    cycleRunning = false;
  }
}

/**
 * Start the prober: run one cycle immediately, then once every
 * settings.probeIntervalMinutes. Overlapping cycles are skipped so a slow cycle
 * cannot pile up. Returns a handle whose stop() clears the timer.
 */
export function startProber(): ProberHandle {
  const { probeIntervalMinutes } = store.getConfig().settings;
  // setInterval takes a 32-bit signed delay: anything larger is silently coerced
  // to 1ms, which would turn a monthly interval into a flat-out probe loop.
  const MAX_TIMER_MS = 2_147_483_647;
  const intervalMs = Math.min(
    Math.max(probeIntervalMinutes, 0) * 60_000 || 60_000,
    MAX_TIMER_MS,
  );

  const tick = (): void => {
    // Declines silently when a cycle is still in flight, including one started
    // from the dashboard.
    runProbeCycleIfIdle().catch((err) => {
      console.warn(`[prober] cycle failed: ${shortError(err)}`);
    });
  };

  // Kick off the first cycle immediately (fire-and-forget).
  tick();

  const handle = setInterval(tick, intervalMs);
  return {
    stop(): void {
      clearInterval(handle);
    },
  };
}
