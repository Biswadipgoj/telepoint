'use client';
import { useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import toast from 'react-hot-toast';
import Link from 'next/link';

interface NavBarProps { role: 'admin' | 'retailer'; userName?: string; pendingCount?: number; }

export default function NavBar({ role, pendingCount = 0 }: NavBarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const _sbRef = useRef<ReturnType<typeof createClient> | null>(null);
  if (typeof window !== 'undefined' && !_sbRef.current) _sbRef.current = createClient();
  const supabase = _sbRef.current!;

  async function logout() {
    await supabase.auth.signOut();
    toast.success('Logged out');
    router.replace('/login');
  }

  const isActive = (href: string, exact = false) => exact ? pathname === href : pathname.startsWith(href);

  return (
    <header className="sticky top-0 z-40 bg-white border-b border-surface-4 shadow-sm no-print">
      <div className="max-w-6xl mx-auto px-3 sm:px-4 h-14 flex items-center justify-between gap-2">
        {/* Logo */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="w-8 h-8 rounded-lg bg-brand-500 flex items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 32 32" fill="none">
              <path d="M16 2L2 9V23L16 30L30 23V9L16 2Z" stroke="white" strokeWidth="2.5" fill="rgba(255,255,255,0.2)" />
              <circle cx="16" cy="14" r="4" fill="white" />
            </svg>
          </div>
          <span className="font-display font-bold text-ink text-base hidden sm:inline">EMI Portal</span>
        </div>

        {/* Desktop nav links — hidden on mobile (BottomNav handles mobile) */}
        <nav className="hidden sm:flex items-center gap-1">
          {role === 'admin' && (
            <>
              <Link href="/admin" className={isActive('/admin', true) ? 'nav-link-active' : 'nav-link'}>Dashboard</Link>
              <Link href="/admin/approvals" className={`${isActive('/admin/approvals') ? 'nav-link-active' : 'nav-link'} relative`}>
                Approvals
                {pendingCount > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-brand-500 text-white text-[10px] font-bold px-1">
                    {pendingCount > 99 ? '99+' : pendingCount}
                  </span>
                )}
              </Link>
            </>
          )}
          {role === 'retailer' && (
            <Link href="/retailer" className={isActive('/retailer') ? 'nav-link-active' : 'nav-link'}>Dashboard</Link>
          )}
        </nav>

        {/* Logout — always visible */}
        <button onClick={logout} className="btn-ghost text-xs px-3 py-2 text-danger hover:bg-danger-light hover:text-danger flex-shrink-0">
          Logout
        </button>
      </div>
    </header>
  );
}
