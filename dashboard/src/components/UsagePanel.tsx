import type { EgressSummary, EgressUsage, Usage } from "../api";
import { formatBytes, formatDuration } from "../util/format";

interface UsagePanelProps {
  usage: Usage;
  /** Egress summaries, in priority order and including the direct egress. */
  egresses: EgressSummary[];
  /** ISO server time; uptime is measured relative to this. */
  serverTime: string;
}

interface Tile {
  label: string;
  value: string;
}

interface UsageRow {
  id: string;
  name: string;
  kind: "direct" | "proxy";
  /** Masked upstream URL (proxy egresses) for the cell tooltip. */
  title: string | undefined;
  usage: EgressUsage | undefined;
}

/** Uptime in ms from startedAt up to the server's current time. */
function uptimeMs(startedAt: string, serverTime: string): number {
  const start = new Date(startedAt).getTime();
  const now = new Date(serverTime).getTime();
  if (Number.isNaN(start) || Number.isNaN(now)) return NaN;
  return now - start;
}

/**
 * Usage panel: a row of headline stat tiles (bytes in/out, total requests,
 * active connections, uptime) above a compact per-egress traffic table. Bytes
 * are humanized via formatBytes; counts render as plain integers. Per-egress
 * rows follow the priority order from status.egresses (direct included) and are
 * matched to their counters by egressId; any counter whose egress is no longer
 * configured is appended so no traffic is hidden.
 */
export function UsagePanel({ usage, egresses, serverTime }: UsagePanelProps) {
  const byId = new Map<string, EgressUsage>(
    usage.perEgress.map((u) => [u.egressId, u] as const),
  );

  const tiles: Tile[] = [
    { label: "Bytes in", value: formatBytes(usage.bytesIn) },
    { label: "Bytes out", value: formatBytes(usage.bytesOut) },
    { label: "Total requests", value: String(usage.totalRequests) },
    { label: "Active connections", value: String(usage.activeConnections) },
    {
      label: "Uptime",
      value: formatDuration(uptimeMs(usage.startedAt, serverTime)),
    },
  ];

  const rows: UsageRow[] = egresses.map((e) => ({
    id: e.id,
    name: e.name,
    kind: e.kind,
    title: e.maskedUrl,
    usage: byId.get(e.id),
  }));
  const known = new Set(egresses.map((e) => e.id));
  for (const u of usage.perEgress) {
    if (!known.has(u.egressId)) {
      rows.push({
        id: u.egressId,
        name: u.egressId,
        kind: "proxy",
        title: undefined,
        usage: u,
      });
    }
  }

  return (
    <div className="panel">
      <div className="usage-stats">
        {tiles.map((t) => (
          <div className="stat-tile" key={t.label}>
            <span className="stat-tile__label">{t.label}</span>
            <span className="stat-tile__value">{t.value}</span>
          </div>
        ))}
      </div>

      <div className="usage-scroll">
        <table className="usage-table">
          <thead>
            <tr>
              <th>Egress</th>
              <th>In</th>
              <th>Out</th>
              <th>Requests</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="usage-table__egr-cell">
                  <span
                    className="usage-table__egr"
                    title={r.title ?? "direct connection"}
                  >
                    <span
                      className={`tag ${
                        r.kind === "direct" ? "tag--direct" : "tag--proxy"
                      }`}
                    >
                      {r.kind}
                    </span>
                    {r.name}
                  </span>
                </td>
                <td>{formatBytes(r.usage?.bytesIn ?? 0)}</td>
                <td>{formatBytes(r.usage?.bytesOut ?? 0)}</td>
                <td>{r.usage?.requests ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
