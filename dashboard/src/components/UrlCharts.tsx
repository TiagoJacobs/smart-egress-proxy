import { useMemo } from "react";

import type { EgressHistory, EgressSummary, MonitoredUrl } from "../api";
import { shortUrl } from "../util/format";
import { colorFor, LineChart, type LineSeries } from "./LineChart";

interface UrlChartsProps {
  egresses: EgressSummary[];
  history: EgressHistory[];
  activeEgressId: string;
  monitoredUrls: MonitoredUrl[];
}

/**
 * 2-column responsive grid of per-URL cards. Each card is a compact multi-line
 * chart of one monitored URL's response time through every egress over the
 * recent cycles. The per-egress color mapping (by egress index) is identical to
 * the overall HistoryChart, so a given egress is the same hue everywhere.
 */
export function UrlCharts({
  egresses,
  history,
  activeEgressId,
  monitoredUrls,
}: UrlChartsProps) {
  // egressId -> its history points, built once for all cards.
  const pointsByEgress = useMemo(
    () => new Map(history.map((h) => [h.egressId, h.points])),
    [history],
  );

  if (monitoredUrls.length === 0) {
    return <p className="muted">No monitored URLs configured.</p>;
  }

  return (
    <div className="chart-grid">
      {monitoredUrls.map((u) => {
        const series: LineSeries[] = egresses.map((e, i) => ({
          id: e.id,
          name: e.name,
          color: colorFor(i),
          active: e.id === activeEgressId,
          points: (pointsByEgress.get(e.id) ?? []).map((p) => {
            const found = p.urls.find((x) => x.url === u.url);
            return {
              t: p.t,
              value: found?.ms ?? null,
              ok: found?.ok ?? false,
            };
          }),
        }));

        return (
          <div className="chart-card" key={u.url}>
            <div className="chart-card__title" title={u.url}>
              {shortUrl(u.url)}
            </div>
            <LineChart
              series={series}
              height={170}
              compact
              ariaLabel={`Response time per egress for ${shortUrl(u.url)}`}
              emptyText="No data yet."
              onePointText="Need two cycles to chart a trend."
            />
          </div>
        );
      })}
    </div>
  );
}
