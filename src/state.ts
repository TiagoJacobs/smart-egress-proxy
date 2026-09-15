/**
 * The single in-memory source of truth.
 *
 * Everything the proxy, prober and API need to agree on lives here: the loaded
 * config, the derived list of egresses, the current routing Mode and the latest
 * health per egress. The selected Mode and the latency history are persisted to
 * disk so a restart keeps a manual override and the charts. Persistence is
 * strictly best-effort and never crashes the process.
 */

import fs from "node:fs";
import path from "node:path";

import type {
  AppConfig,
  Egress,
  EgressHealth,
  EgressHistory,
  EgressUsage,
  HistorySample,
  Mode,
  Usage,
} from "./types.js";
import { maskUrl, parseMode, modeToString } from "./util.js";

/** Cumulative byte/request counters for one egress route. */
interface EgressUsageCounters {
  bytesIn: number;
  bytesOut: number;
  requests: number;
}

/** Process-wide traffic totals tracked alongside the per-egress breakdown. */
interface UsageTotals {
  bytesIn: number;
  bytesOut: number;
  totalRequests: number;
  activeConnections: number;
}

interface InternalState {
  config: AppConfig | null;
  /** Derived from config, sorted by priorityOrder ascending. */
  egresses: Egress[];
  mode: Mode;
  /** egressId -> latest health. */
  health: Map<string, EgressHealth>;
  /** egressId -> latency ring buffer, oldest->newest (capped at HISTORY_LIMIT). */
  history: Map<string, HistorySample[]>;
  /** Process-wide traffic totals since startedAt. */
  usageTotals: UsageTotals;
  /** egressId -> cumulative byte/request counters. */
  usageByEgress: Map<string, EgressUsageCounters>;
  /** ISO-8601 timestamp captured in initStore; basis for uptime. */
  startedAt: string;
}

interface PersistedState {
  mode: Mode;
  /**
   * Name of the upstream a persisted PROXY mode referred to. Egress identity is
   * positional, so without this an edit that shifts upstreamProxies silently
   * re-points the restored mode at a different proxy.
   */
  modeUpstreamName?: string;
  history?: Record<string, HistorySample[]>;
}

/** Shape of the shared store. A module-level singleton is exported below. */
export interface Store {
  initStore(config: AppConfig): void;
  getConfig(): AppConfig;
  getEgresses(): Egress[];
  getMode(): Mode;
  setMode(mode: Mode): void;
  getHealth(): EgressHealth[];
  setEgressHealth(h: EgressHealth): void;
  getHistory(): EgressHistory[];
  resolveActiveEgress(): Egress;
  /** Add transferred bytes to an egress (and the process totals). */
  recordBytes(egressId: string, inBytes: number, outBytes: number): void;
  /** Count one handled HTTP request / CONNECT tunnel for an egress. */
  recordRequest(egressId: string): void;
  /** A request/tunnel just opened: increment active connections. */
  connOpened(): void;
  /** A request/tunnel just closed: decrement active connections (clamped at 0). */
  connClosed(): void;
  /** Snapshot of all traffic accounting since the store started. */
  getUsage(): Usage;
}

const DIRECT_EGRESS_ID = "direct";
const HISTORY_LIMIT = 60;

export function createStore(): Store {
  const state: InternalState = {
    config: null,
    egresses: [],
    mode: { type: "AUTO" },
    health: new Map<string, EgressHealth>(),
    history: new Map<string, HistorySample[]>(),
    usageTotals: { bytesIn: 0, bytesOut: 0, totalRequests: 0, activeConnections: 0 },
    usageByEgress: new Map<string, EgressUsageCounters>(),
    startedAt: new Date().toISOString(),
  };

  function stateDir(): string {
    return process.env.STATE_DIR ?? "/data";
  }

  function stateFilePath(): string {
    return path.join(stateDir(), "state.json");
  }

  function requireConfig(): AppConfig {
    if (state.config === null) {
      throw new Error("Store not initialized: call initStore() first.");
    }
    return state.config;
  }

  function buildEgresses(config: AppConfig): Egress[] {
    const egresses: Egress[] = [
      {
        id: DIRECT_EGRESS_ID,
        name: "DIRECT",
        kind: "direct",
        priorityOrder: config.settings.directPriorityOrder,
      },
    ];

    config.upstreamProxies.forEach((proxy, index) => {
      egresses.push({
        id: `proxy-${index}`,
        name: proxy.name,
        kind: "proxy",
        priorityOrder: proxy.priorityOrder,
        proxyIndex: index,
        maskedUrl: maskUrl(proxy.url),
      });
    });

    // Lower priorityOrder number = higher preference.
    egresses.sort((a, b) => a.priorityOrder - b.priorityOrder);
    return egresses;
  }

  function isValidMode(mode: Mode, config: AppConfig): boolean {
    if (mode.type === "PROXY") {
      return (
        Number.isInteger(mode.proxyIndex) &&
        mode.proxyIndex >= 0 &&
        mode.proxyIndex < config.upstreamProxies.length
      );
    }
    return true;
  }

  /**
   * Monitored URLs that failed through every egress we have actually measured.
   * A URL that is down everywhere is evidence about the site, not about any
   * route, so it must not be allowed to condemn every egress at once. Health used
   * to be a plain AND over all URLs, which meant one unrelated site outage marked
   * every route unhealthy in a single cycle.
   */
  function siteWideFailures(): Set<string> {
    const measured = [...state.health.values()].filter(
      (h) => h.results.length > 0,
    );
    const out = new Set<string>();
    if (measured.length === 0) return out;

    const tally = new Map<string, { ok: number; seen: number }>();
    for (const health of measured) {
      for (const result of health.results) {
        const entry = tally.get(result.url) ?? { ok: 0, seen: 0 };
        entry.seen += 1;
        if (result.ok) entry.ok += 1;
        tally.set(result.url, entry);
      }
    }
    for (const [url, entry] of tally) {
      if (entry.ok === 0 && entry.seen === measured.length) out.add(url);
    }
    return out;
  }

  /**
   * Score an egress in [0, 1]: the share of monitored URLs it served, ignoring
   * URLs that no egress could serve. An egress with nothing left to judge by,
   * because it has never been probed or because every URL was excluded, scores a
   * neutral 0.5, so "not measured yet" outranks "measured and failing" and loses
   * to "measured and working". That neutral value is what stops a fresh restart
   * from treating unknown as unhealthy and dumping all traffic on DIRECT for the
   * length of the first probe cycle.
   */
  function egressScore(egressId: string, excluded: Set<string>): number {
    const health = state.health.get(egressId);
    if (health === undefined) return 0.5;
    const relevant = health.results.filter((r) => !excluded.has(r.url));
    if (relevant.length === 0) return 0.5;
    return relevant.filter((r) => r.ok).length / relevant.length;
  }

  function persistState(): void {
    const history: Record<string, HistorySample[]> = {};
    for (const [id, buf] of state.history) history[id] = buf;
    const payload: PersistedState = { mode: state.mode, history };
    if (state.mode.type === "PROXY" && state.config !== null) {
      const upstream = state.config.upstreamProxies[state.mode.proxyIndex];
      if (upstream !== undefined) payload.modeUpstreamName = upstream.name;
    }
    try {
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.writeFileSync(stateFilePath(), JSON.stringify(payload), "utf8");
    } catch (err) {
      console.warn(
        `[state] Could not persist state to ${stateFilePath()}: ${(err as Error).message}. Continuing in-memory.`,
      );
    }
  }

  function parsePersistedMode(m: unknown): Mode | null {
    if (m !== null && typeof m === "object" && "type" in m) {
      const type = (m as { type: unknown }).type;
      if (type === "AUTO") return { type: "AUTO" };
      if (type === "DIRECT") return { type: "DIRECT" };
      if (type === "PROXY") {
        const idx = (m as { proxyIndex?: unknown }).proxyIndex;
        if (typeof idx === "number" && Number.isInteger(idx)) {
          return { type: "PROXY", proxyIndex: idx };
        }
      }
    }
    return null;
  }

  /** Tolerantly validate a persisted history array, capped at HISTORY_LIMIT. */
  function sanitizeHistoryPoints(pts: unknown): HistorySample[] {
    if (!Array.isArray(pts)) return [];
    const out: HistorySample[] = [];
    for (const p of pts) {
      if (p === null || typeof p !== "object") continue;
      const o = p as Record<string, unknown>;
      if (typeof o.t !== "string") continue;
      const avgMs =
        typeof o.avgMs === "number" && Number.isFinite(o.avgMs) ? o.avgMs : null;
      const urls = Array.isArray(o.urls)
        ? o.urls.flatMap(
            (u): { url: string; ms: number | null; ok: boolean }[] => {
              if (u === null || typeof u !== "object") return [];
              const uo = u as Record<string, unknown>;
              if (typeof uo.url !== "string") return [];
              const ms =
                typeof uo.ms === "number" && Number.isFinite(uo.ms) ? uo.ms : null;
              return [{ url: uo.url, ms, ok: uo.ok === true }];
            },
          )
        : [];
      out.push({ t: o.t, avgMs, healthy: o.healthy === true, urls });
    }
    return out.slice(-HISTORY_LIMIT);
  }

  /** Read the persisted mode + history (best-effort; defaults on any error). */
  function readPersisted(): {
    mode: Mode | null;
    modeUpstreamName: string | null;
    history: Map<string, HistorySample[]>;
  } {
    const result = {
      mode: null as Mode | null,
      modeUpstreamName: null as string | null,
      history: new Map<string, HistorySample[]>(),
    };
    try {
      const raw = fs.readFileSync(stateFilePath(), "utf8");
      const data: unknown = JSON.parse(raw);
      if (data !== null && typeof data === "object") {
        result.mode = parsePersistedMode((data as { mode?: unknown }).mode);
        const name = (data as { modeUpstreamName?: unknown }).modeUpstreamName;
        if (typeof name === "string" && name !== "") result.modeUpstreamName = name;
        const h = (data as { history?: unknown }).history;
        if (h !== null && typeof h === "object") {
          for (const [id, pts] of Object.entries(h as Record<string, unknown>)) {
            const arr = sanitizeHistoryPoints(pts);
            if (arr.length > 0) result.history.set(id, arr);
          }
        }
      }
    } catch {
      // Missing or unreadable/invalid state file: fall back to defaults.
    }
    return result;
  }

  return {
    initStore(config: AppConfig): void {
      state.config = config;
      state.egresses = buildEgresses(config);
      state.health = new Map<string, EgressHealth>();
      state.history = new Map<string, HistorySample[]>();

      // Reset all traffic accounting and stamp the new start time.
      state.usageTotals = {
        bytesIn: 0,
        bytesOut: 0,
        totalRequests: 0,
        activeConnections: 0,
      };
      state.usageByEgress = new Map<string, EgressUsageCounters>();
      state.startedAt = new Date().toISOString();

      // Initial mode comes from settings.defaultMode...
      let mode: Mode;
      try {
        mode = parseMode(config.settings.defaultMode);
      } catch {
        mode = { type: "AUTO" };
      }

      // ...overridden by a previously persisted manual selection, if any. Say so
      // out loud: on a persistent volume this silently discards a changed
      // settings.defaultMode, which is baffling to debug from the outside.
      const persisted = readPersisted();
      if (persisted.mode !== null) {
        const persistedStr = modeToString(persisted.mode);
        if (persistedStr !== modeToString(mode)) {
          console.log(
            `[state] Persisted mode ${persistedStr} overrides ` +
              `settings.defaultMode ${modeToString(mode)}.`,
          );
        }
        mode = persisted.mode;

        // Egress identity is positional, so a config edit that inserts or
        // reorders upstreams would silently re-point this mode at a different
        // proxy. Follow the name that was persisted with it instead.
        if (mode.type === "PROXY" && persisted.modeUpstreamName !== null) {
          const name = persisted.modeUpstreamName;
          if (config.upstreamProxies[mode.proxyIndex]?.name !== name) {
            const moved = config.upstreamProxies.findIndex((u) => u.name === name);
            if (moved === -1) {
              console.warn(
                `[state] Persisted mode pinned upstream "${name}", which is no ` +
                  `longer configured. Falling back to AUTO.`,
              );
              mode = { type: "AUTO" };
            } else {
              console.warn(
                `[state] Upstream "${name}" moved from index ` +
                  `${mode.proxyIndex} to ${moved}; following it.`,
              );
              mode = { type: "PROXY", proxyIndex: moved };
            }
          }
        }
      }

      // Guard against a now-out-of-range PROXY index (config may have changed).
      if (!isValidMode(mode, config)) {
        mode = { type: "AUTO" };
      }

      state.mode = mode;

      // Restore persisted latency history for egresses that still exist.
      for (const e of state.egresses) {
        const pts = persisted.history.get(e.id);
        if (pts !== undefined && pts.length > 0) {
          state.history.set(e.id, pts);
        }
      }
    },

    getConfig(): AppConfig {
      return requireConfig();
    },

    getEgresses(): Egress[] {
      return state.egresses.map((e) => ({ ...e }));
    },

    getMode(): Mode {
      return { ...state.mode };
    },

    setMode(mode: Mode): void {
      const config = requireConfig();
      if (!isValidMode(mode, config)) {
        throw new Error(
          `Invalid mode: proxyIndex must be an integer in range 0..${config.upstreamProxies.length - 1}.`,
        );
      }
      state.mode = mode;
      persistState();
    },

    getHealth(): EgressHealth[] {
      return state.egresses.map(
        (e) =>
          state.health.get(e.id) ?? { egressId: e.id, healthy: false, results: [] },
      );
    },

    setEgressHealth(h: EgressHealth): void {
      state.health.set(h.egressId, h);

      // Append one history sample per egress per cycle (FIXED contract).
      const times = h.results
        .map((r) => r.responseTimeMs)
        .filter((v): v is number => typeof v === "number");
      const avgMs =
        times.length > 0
          ? Math.round(times.reduce((a, b) => a + b, 0) / times.length)
          : null;
      const urls = h.results.map((r) => ({
        url: r.url,
        ms: r.responseTimeMs ?? null,
        ok: r.ok,
      }));
      const sample: HistorySample = {
        t: h.lastCheckedAt ?? new Date().toISOString(),
        avgMs,
        healthy: h.healthy,
        urls,
      };
      const buf = state.history.get(h.egressId) ?? [];
      buf.push(sample);
      if (buf.length > HISTORY_LIMIT) buf.splice(0, buf.length - HISTORY_LIMIT);
      state.history.set(h.egressId, buf);

      // Persist mode + history so the charts survive a restart (best-effort).
      persistState();
    },

    getHistory(): EgressHistory[] {
      return state.egresses.map((e) => ({
        egressId: e.id,
        points: (state.history.get(e.id) ?? []).map((p) => ({ ...p })),
      }));
    },

    resolveActiveEgress(): Egress {
      const direct = state.egresses.find((e) => e.id === DIRECT_EGRESS_ID);
      if (direct === undefined) {
        throw new Error("Store not initialized: no DIRECT egress available.");
      }

      const mode = state.mode;

      if (mode.type === "DIRECT") {
        return { ...direct };
      }

      if (mode.type === "PROXY") {
        // Manual override: honor it even if the proxy is currently unhealthy.
        const target = state.egresses.find(
          (e) => e.kind === "proxy" && e.proxyIndex === mode.proxyIndex,
        );
        return { ...(target ?? direct) };
      }

      // AUTO: the best-scoring egress, breaking ties by priority. state.egresses
      // is already sorted by priorityOrder ascending, so scanning in order gives
      // the most preferred among equals, and DIRECT competes on its own
      // directPriorityOrder instead of being a hard-coded last resort. That
      // matters: the old rule returned the first fully healthy egress and
      // otherwise went DIRECT, so an egress serving 1 of 2 URLs lost to DIRECT
      // serving 0 of 2.
      const excluded = siteWideFailures();
      let best = direct;
      let bestScore = -1;
      for (const egress of state.egresses) {
        const score = egressScore(egress.id, excluded);
        if (score === 1) return { ...egress };
        if (score > bestScore) {
          bestScore = score;
          best = egress;
        }
      }
      return { ...best };
    },

    recordBytes(egressId: string, inBytes: number, outBytes: number): void {
      // Accounting must never throw: coerce/guard everything defensively.
      const inB = Number.isFinite(inBytes) && inBytes > 0 ? inBytes : 0;
      const outB = Number.isFinite(outBytes) && outBytes > 0 ? outBytes : 0;
      if (inB === 0 && outB === 0) return;

      state.usageTotals.bytesIn += inB;
      state.usageTotals.bytesOut += outB;

      const counters = state.usageByEgress.get(egressId) ?? {
        bytesIn: 0,
        bytesOut: 0,
        requests: 0,
      };
      counters.bytesIn += inB;
      counters.bytesOut += outB;
      state.usageByEgress.set(egressId, counters);
    },

    recordRequest(egressId: string): void {
      state.usageTotals.totalRequests += 1;

      const counters = state.usageByEgress.get(egressId) ?? {
        bytesIn: 0,
        bytesOut: 0,
        requests: 0,
      };
      counters.requests += 1;
      state.usageByEgress.set(egressId, counters);
    },

    connOpened(): void {
      state.usageTotals.activeConnections += 1;
    },

    connClosed(): void {
      // Clamp at 0 so a double-close can never drive the gauge negative.
      state.usageTotals.activeConnections = Math.max(
        0,
        state.usageTotals.activeConnections - 1,
      );
    },

    getUsage(): Usage {
      // Start from every known egress id (so routes with no traffic still show
      // up as zeros), then fold in any recorded ids not in the current config.
      const perEgress: EgressUsage[] = [];
      const seen = new Set<string>();
      for (const e of state.egresses) {
        const c = state.usageByEgress.get(e.id);
        perEgress.push({
          egressId: e.id,
          bytesIn: c?.bytesIn ?? 0,
          bytesOut: c?.bytesOut ?? 0,
          requests: c?.requests ?? 0,
        });
        seen.add(e.id);
      }
      for (const [egressId, c] of state.usageByEgress) {
        if (seen.has(egressId)) continue;
        perEgress.push({
          egressId,
          bytesIn: c.bytesIn,
          bytesOut: c.bytesOut,
          requests: c.requests,
        });
      }

      return {
        bytesIn: state.usageTotals.bytesIn,
        bytesOut: state.usageTotals.bytesOut,
        totalRequests: state.usageTotals.totalRequests,
        activeConnections: state.usageTotals.activeConnections,
        startedAt: state.startedAt,
        perEgress,
      };
    },
  };
}

/** The shared module-level singleton store. */
export const store: Store = createStore();

// Convenience named exports bound to the singleton. These closures do not use
// `this`, so destructuring/extracting them is safe.
export const initStore = store.initStore;
export const getConfig = store.getConfig;
export const getEgresses = store.getEgresses;
export const getMode = store.getMode;
export const setMode = store.setMode;
export const getHealth = store.getHealth;
export const setEgressHealth = store.setEgressHealth;
export const getHistory = store.getHistory;
export const resolveActiveEgress = store.resolveActiveEgress;
export const recordBytes = store.recordBytes;
export const recordRequest = store.recordRequest;
export const connOpened = store.connOpened;
export const connClosed = store.connClosed;
export const getUsage = store.getUsage;
