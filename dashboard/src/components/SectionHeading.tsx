interface SectionHeadingProps {
  /** Small uppercase label above the title. */
  eyebrow: string;
  /** Human-readable section title. */
  title: string;
  /** Optional right-aligned supplementary text. */
  hint?: string;
}

/**
 * Consistent heading used to label each top-level dashboard section: a small
 * accent-colored eyebrow over a title, with an optional muted hint on the
 * right. Shared by the Usage, Routing mode and Probing sections so they read
 * as one family.
 */
export function SectionHeading({ eyebrow, title, hint }: SectionHeadingProps) {
  return (
    <div className="section-head">
      <div className="section-head__text">
        <span className="section-head__eyebrow">{eyebrow}</span>
        <h2 className="section-head__title">{title}</h2>
      </div>
      {hint !== undefined ? (
        <span className="muted section-head__hint">{hint}</span>
      ) : null}
    </div>
  );
}
