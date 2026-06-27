import { useMemo, useState } from "react";

import type {
  EgressHealth,
  EgressSummary,
  MonitoredUrl,
  UrlProbeResult,
} from "../api";
import { formatBytes, shortUrl } from "../util/format";

interface MatrixTableProps {
  monitoredUrls: MonitoredUrl[];
  egresses: EgressSummary[];
  healthById: Map<string, EgressHealth>;
  activeEgressId: string;
}

/** A precomputed egress column: health + url->result lookup. */
interface Column {
  egress: EgressSummary;
  healthy: boolean;
  active: boolean;
  byUrl: Map<string, UrlProbeResult>;
}

/** What the floating tooltip needs to render the (url, egress) detail. */
interface TipState {
  x: number;
  y: number;
  url: string;
  egressName: string;
  exp: MonitoredUrl;
  result: UrlProbeResult | undefined;
}

/**
 * Status matrix: ROWS = monitored URLs, COLUMNS = egresses (priority order,
 * including the direct egress). Every cell is the OK/FAIL status of that URL
 * through that egress; hovering a cell shows the full per-result detail in a
 * viewport-fixed tooltip (never clipped by the table's horizontal scroll). The
 * active egress column is highlighted.
 */
export function MatrixTable({
  monitoredUrls,
  egresses,
  healthById,
  activeEgressId,
}: MatrixTableProps) {
  const [tip, setTip] = useState<TipState | null>(null);

  const columns: Column[] = useMemo(
    () =>
      egresses.map((e) => {
        const health = healthById.get(e.id);
        const byUrl = new Map<string, UrlProbeResult>();
        for (const r of health?.results ?? []) byUrl.set(r.url, r);
        return {
          egress: e,
          healthy: health?.healthy === true,
          active: e.id === activeEgressId,
          byUrl,
        };
      }),
    [egresses, healthById, activeEgressId],
  );

  if (monitoredUrls.length === 0) {
    return <p className="muted">No monitored URLs configured.</p>;
  }

  return (
    <div className="matrix-scroll">
      <table className="matrix">
        <thead>
          <tr>
            <th className="matrix__corner">URL</th>
            {columns.map((c) => (
              <th
                key={c.egress.id}
                className={`matrix__egr-head ${c.active ? "is-active" : ""}`}
              >
                <span className="matrix__egr-name">
                  <span
                    className={`dot ${c.healthy ? "dot--ok" : "dot--bad"}`}
                    aria-hidden="true"
                  />
                  <span title={c.egress.maskedUrl ?? "direct connection"}>
                    {c.egress.name}
                  </span>
                </span>
                {c.active ? (
                  <span className="badge badge--active">active</span>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {monitoredUrls.map((u) => (
            <tr key={u.url}>
              <td className="matrix__url" title={u.url}>
                {shortUrl(u.url)}
              </td>
              {columns.map((c) => {
                const result = c.byUrl.get(u.url);
                const show = (e: React.MouseEvent): void =>
                  setTip({
                    x: e.clientX,
                    y: e.clientY,
                    url: u.url,
                    egressName: c.egress.name,
                    exp: u,
                    result,
                  });
                return (
                  <td
                    key={c.egress.id}
                    className={`matrix__cell ${c.active ? "is-active" : ""}`}
                    onMouseEnter={show}
                    onMouseMove={show}
                    onMouseLeave={() => setTip(null)}
                  >
                    {result === undefined ? (
                      <span className="muted" aria-label="no result">
                        -
                      </span>
                    ) : result.ok ? (
                      <span className="pill pill--ok">OK</span>
                    ) : (
                      <span className="pill pill--bad">FAIL</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {tip !== null ? <MatrixTip tip={tip} /> : null}
    </div>
  );
}

/** Viewport-fixed detail tooltip for a single matrix cell. */
function MatrixTip({ tip }: { tip: TipState }) {
  const { result, exp } = tip;
  const maxLeft =
    (typeof window !== "undefined" ? window.innerWidth : 1280) - 280;
  const left = Math.min(tip.x + 14, Math.max(8, maxLeft));
  const top = tip.y + 14;

  const codeBad =
    result?.responseCode !== undefined &&
    result.responseCode !== exp.expectedResponseCode;
  const timeBad =
    result?.responseTimeMs !== undefined &&
    result.responseTimeMs > exp.acceptedResponseTimeMs;

  return (
    <div className="matrix-tip" role="tooltip" style={{ left, top }}>
      <div className="matrix-tip__head">
        <span className="matrix-tip__url">{shortUrl(tip.url)}</span>
        <span className="muted"> · {tip.egressName}</span>
      </div>
      {result === undefined ? (
        <div className="muted">No probe result yet.</div>
      ) : (
        <dl className="matrix-tip__grid">
          <dt>Code</dt>
          <dd className={codeBad ? "bad" : "ok"}>
            {result.responseCode ?? "-"}
            <span className="muted"> / {exp.expectedResponseCode}</span>
          </dd>
          <dt>Time</dt>
          <dd className={timeBad ? "bad" : "ok"}>
            {result.responseTimeMs !== undefined
              ? `${result.responseTimeMs} ms`
              : "-"}
            <span className="muted"> / {exp.acceptedResponseTimeMs} ms</span>
          </dd>
          <dt>Bytes</dt>
          <dd>
            {formatBytes(result.bytesDownloaded)}
            <span className="muted"> / {formatBytes(exp.fetchBytesLimit)}</span>
          </dd>
          {result.error !== undefined && result.error !== "" ? (
            <>
              <dt>Error</dt>
              <dd className="bad matrix-tip__err">{result.error}</dd>
            </>
          ) : null}
        </dl>
      )}
    </div>
  );
}
