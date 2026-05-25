/**
 * Global footer — mounted in app/layout.tsx so it sits below every page.
 *
 * The attribution string is a hard requirement and must render verbatim
 * across the entire portal. Do not edit, abbreviate, or localise it.
 */
export default function Footer() {
  return (
    <footer
      className="no-print mt-10 border-t border-surface-4 bg-surface-1 py-4 px-4 text-center"
      style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}
    >
      <p className="text-xs sm:text-sm font-semibold text-ink-muted tracking-wide">
        Mastermind Behind The Code: Biswodip Goj
      </p>
    </footer>
  );
}
