import { useMemo } from "react";

import type { EgressHistory, EgressSummary } from "../api";
import { colorFor, LineChart, type LineSeries } from "./LineChart";

interface HistoryChartProps {
  egresses: EgressSummary[];
  history: EgressHistory[];
  activeEgressId: string;
}

/**
 * Overall comparative chart: one line per egress = avgMs over recent cycles.
 * Just shapes the per-egress history into `LineSeries` and hands the drawing
 * off to the shared `LineChart`. Color is keyed by the egress index so it stays
 * consistent with the per-URL cards.
 */
export function HistoryChart({
  egresses,
  history,
  activeEgressId,
}: HistoryChartProps) {
  const series: LineSeries[] = useMemo(() => {
    const histById = new Map(history.map((h) => [h.egressId, h.points]));
    return egresses.map((e, i) => ({
      id: e.id,
      name: e.name,
      color: colorFor(i),
      active: e.id === activeEgressId,
      points: (histById.get(e.id) ?? []).map((p) => ({
        t: p.t,
        value: p.avgMs,
        ok: p.healthy,
      })),
    }));
  }, [egresses, history, activeEgressId]);

  return (
    <LineChart series={series} ariaLabel="Response time over recent probe cycles" />
  );
}
