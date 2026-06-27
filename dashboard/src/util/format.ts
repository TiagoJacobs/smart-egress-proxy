/**
 * Shared formatting helpers, single source of truth so App, the egress table
 * and the history chart agree on URL shortening, byte and time formatting.
 */

export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname !== "/" ? u.pathname : "");
  } catch {
    return url;
  }
}

export function formatBytes(n: number | undefined): string {
  if (n === undefined) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTime(iso: string | undefined): string {
  if (iso === undefined) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

/**
 * Humanize a duration in milliseconds, e.g. 3852000 -> "1h 04m 12s". Minutes
 * and seconds are zero-padded once a larger unit is shown; sub-minute and
 * sub-hour spans drop the empty leading units.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number): string => String(n).padStart(2, "0");
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}
