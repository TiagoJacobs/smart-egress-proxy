import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ApiError,
  fetchStatus,
  runProbe,
  setMode as apiSetMode,
  type EgressHealth,
  type ModeString,
  type StatusResponse,
} from "./api";
import { Header } from "./components/Header";
import { HistoryChart } from "./components/HistoryChart";
import { MatrixTable } from "./components/MatrixTable";
import { ModeSelector } from "./components/ModeSelector";
import { SectionHeading } from "./components/SectionHeading";
import { UrlCharts } from "./components/UrlCharts";
import { UsagePanel } from "./components/UsagePanel";

const POLL_INTERVAL_MS = 10_000;

export default function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authError, setAuthError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pendingMode, setPendingMode] = useState<ModeString | null>(null);
  const [probing, setProbing] = useState(false);
  const inFlight = pendingMode !== null || probing;
  const timerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchStatus();
      setStatus(data);
      setError(null);
      setAuthError(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setAuthError(true);
        setError("Not authorized. Reload the page and sign in to view the dashboard.");
      } else {
        setAuthError(false);
        setError(err instanceof Error ? err.message : "Failed to load status.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + 10s polling.
  useEffect(() => {
    void load();
    timerRef.current = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, [load]);

  const handleSetMode = useCallback(
    async (mode: ModeString) => {
      setPendingMode(mode);
      try {
        await apiSetMode(mode);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to set mode.");
      } finally {
        setPendingMode(null);
      }
    },
    [load],
  );

  const handleRunProbe = useCallback(async () => {
    setProbing(true);
    try {
      await runProbe();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run probe.");
    } finally {
      setProbing(false);
    }
  }, [load]);

  // egressId -> health, for quick column lookup.
  const healthById = useMemo(() => {
    const map = new Map<string, EgressHealth>();
    for (const h of status?.health ?? []) map.set(h.egressId, h);
    return map;
  }, [status]);

  if (loading && status === null) {
    return (
      <main className="page">
        <p className="muted center">Loading…</p>
      </main>
    );
  }

  if (status === null) {
    return (
      <main className="page">
        <div className={`banner ${authError ? "banner--warn" : "banner--error"}`}>
          {error ?? "Unable to load the dashboard."}
        </div>
      </main>
    );
  }

  const activeEgress = status.egresses.find((e) => e.id === status.activeEgressId);

  return (
    <main className="page">
      <Header
        activeEgress={activeEgress}
        mode={status.mode}
        serverTime={status.serverTime}
        polling={!inFlight}
      />

      {error !== null ? (
        <div className={`banner ${authError ? "banner--warn" : "banner--error"}`}>
          {error}
        </div>
      ) : null}

      <section className="section">
        <SectionHeading eyebrow="Usage" title="Traffic through the proxy" />
        <UsagePanel
          usage={status.usage}
          egresses={status.egresses}
          serverTime={status.serverTime}
        />
      </section>

      <section className="section">
        <SectionHeading eyebrow="Routing mode" title="How egress is selected" />
        <ModeSelector
          mode={status.mode}
          upstreamProxies={status.config.upstreamProxies}
          pendingMode={pendingMode}
          probing={probing}
          onSelect={handleSetMode}
          onRunProbe={handleRunProbe}
        />
      </section>

      <section className="section">
        <SectionHeading
          eyebrow="Probing"
          title="Health checks across egresses"
        />

        <div className="panel">
          <div className="panel__head">
            <span className="eyebrow">Status matrix</span>
            <span className="muted matrix-hint">Hover a cell for details</span>
          </div>
          <MatrixTable
            monitoredUrls={status.config.monitoredUrls}
            egresses={status.egresses}
            healthById={healthById}
            activeEgressId={status.activeEgressId}
          />
        </div>

        <div className="panel">
          <div className="panel__head">
            <span className="eyebrow">Response time</span>
          </div>
          <HistoryChart
            egresses={status.egresses}
            history={status.history ?? []}
            activeEgressId={status.activeEgressId}
          />

          <div className="panel__subhead">
            <span className="eyebrow">Per URL</span>
          </div>
          <UrlCharts
            egresses={status.egresses}
            history={status.history ?? []}
            activeEgressId={status.activeEgressId}
            monitoredUrls={status.config.monitoredUrls}
          />
        </div>
      </section>

      <footer className="foot muted">
        Polling every {POLL_INTERVAL_MS / 1000}s &middot; probe interval{" "}
        {status.config.settings.probeIntervalMinutes} min
      </footer>
    </main>
  );
}
