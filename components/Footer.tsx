'use client';

import { usePathname } from 'next/navigation';

/**
 * Global footer — mounted in app/layout.tsx so it sits below every page.
 *
 * Attribution is intentionally hidden on retailer-facing routes.
 */
export default function Footer() {
  const pathname = usePathname();
  const isRetailerRoute = pathname?.startsWith('/retailer');

  if (isRetailerRoute) return null;

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
