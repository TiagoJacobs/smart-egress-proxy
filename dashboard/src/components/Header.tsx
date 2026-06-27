import type { EgressSummary, Mode } from "../api";
import { modeToString } from "../api";

interface HeaderProps {
  activeEgress: EgressSummary | undefined;
  mode: Mode;
  serverTime: string | undefined;
  polling: boolean;
}

function formatTime(iso: string | undefined): string {
  if (iso === undefined) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

/** App title bar showing the currently resolved active egress. */
export function Header({ activeEgress, mode, serverTime, polling }: HeaderProps) {
  return (
    <header className="header">
      <div className="header__title">
        <h1>
          Smart Egress Proxy
          <span
            className={`header__pulse ${polling ? "header__pulse--on" : ""}`}
            title="Live polling"
            aria-hidden="true"
          />
        </h1>
        <p className="header__subtitle">
          Mode <code>{modeToString(mode)}</code> &middot; server time{" "}
          {formatTime(serverTime)}
        </p>
      </div>

      <div className="header__active">
        <span className="header__active-label">Active egress</span>
        {activeEgress !== undefined ? (
          <span
            className={`badge badge--active badge--${activeEgress.kind}`}
            title={activeEgress.maskedUrl ?? "direct connection"}
          >
            {activeEgress.name}
          </span>
        ) : (
          <span className="badge">unknown</span>
        )}
      </div>
    </header>
  );
}
