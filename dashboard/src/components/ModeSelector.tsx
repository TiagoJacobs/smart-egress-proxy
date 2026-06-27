import type { Mode, ModeString, UpstreamProxyConfig } from "../api";

interface ModeSelectorProps {
  mode: Mode;
  upstreamProxies: UpstreamProxyConfig[];
  /** The mode button currently being applied (null when idle). */
  pendingMode: ModeString | null;
  /** Probe run in flight. */
  probing: boolean;
  onSelect: (mode: ModeString) => void;
  onRunProbe: () => void;
}

function isActive(mode: Mode, target: ModeString): boolean {
  switch (mode.type) {
    case "AUTO":
      return target === "AUTO";
    case "DIRECT":
      return target === "DIRECT";
    case "PROXY":
      return target === `PROXY:${mode.proxyIndex}`;
  }
}

/**
 * Mode selector: AUTO, DIRECT and one button per upstream proxy, plus a
 * "Run probe now" button. While any action is in flight ALL controls lock
 * (prevents races) but only the clicked control shows a spinner. The spinner
 * never changes a button's size, see the zero-layout-shift CSS.
 */
export function ModeSelector({
  mode,
  upstreamProxies,
  pendingMode,
  probing,
  onSelect,
  onRunProbe,
}: ModeSelectorProps) {
  const inFlight = pendingMode !== null || probing;

  const buttons: { label: string; value: ModeString }[] = [
    { label: "AUTO", value: "AUTO" },
    { label: "DIRECT", value: "DIRECT" },
    ...upstreamProxies.map((p, index) => ({
      label: p.name,
      value: `PROXY:${index}` as ModeString,
    })),
  ];

  return (
    <section className="controls">
      <div className="controls__group">
        <span className="controls__label">Routing mode</span>
        <div className="segmented" role="group" aria-label="Routing mode">
          {buttons.map((b) => {
            const active = isActive(mode, b.value);
            const loading = pendingMode === b.value;
            return (
              <button
                key={b.value}
                type="button"
                className={`segmented__btn ${active ? "segmented__btn--active" : ""} ${
                  loading ? "is-loading" : ""
                }`}
                aria-pressed={active}
                aria-busy={loading}
                disabled={inFlight}
                onClick={() => onSelect(b.value)}
              >
                <span className="btn__label">{b.label}</span>
                {loading ? (
                  <span className="btn__spinner" aria-hidden="true" />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <button
        type="button"
        className={`btn btn--primary ${probing ? "is-loading" : ""}`}
        disabled={inFlight}
        aria-busy={probing}
        onClick={onRunProbe}
      >
        <span className="btn__label">Run probe now</span>
        {probing ? <span className="btn__spinner" aria-hidden="true" /> : null}
      </button>
    </section>
  );
}
