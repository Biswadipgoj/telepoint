'use client';
export const dynamic = 'force-dynamic';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import toast from 'react-hot-toast';
import Link from 'next/link';

type Tab = 'admin' | 'retailer';

export default function LoginPage() {
  const router = useRouter();
  const supabaseRef = useRef<ReturnType<typeof createClient> | null>(null);
  if (typeof window !== 'undefined' && !supabaseRef.current) supabaseRef.current = createClient();
  const supabase = supabaseRef.current!;
  const [tab, setTab] = useState<Tab>('admin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const toEmail = (u: string, t: Tab) =>
    t === 'admin'
      ? ({ TELEPOINT: 'telepoint@admin.local', telepoint: 'telepoint@admin.local' }[u] ?? `${u}@admin.local`)
      : `${u.toLowerCase()}@tele.local`;

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: toEmail(username, tab), password });
      if (error) { toast.error('Incorrect username or password'); return; }
      toast.success('Welcome!');
      router.replace(tab === 'admin' ? '/admin' : '/retailer');
      router.refresh();
    } finally { setLoading(false); }
  }

  return (
    <div className="min-h-screen page-bg flex items-center justify-center p-4">
      <div className="w-full max-w-sm animate-fade-in">

        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-brand-500 shadow-lg shadow-brand-500/30 mb-4">
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
              <path d="M16 2L2 9V23L16 30L30 23V9L16 2Z" stroke="white" strokeWidth="2" fill="rgba(255,255,255,0.15)" />
              <circle cx="16" cy="14" r="4" fill="white" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold text-ink">EMI Management Portal</h1>
          <p className="text-ink-muted text-sm mt-1">Secure access for authorized users</p>
        </div>

        <div className="card p-8">
          {/* Tab */}
          <div className="flex rounded-xl bg-surface-3 p-1 mb-6">
            {(['admin', 'retailer'] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => { setTab(t); setUsername(''); setPassword(''); }}
                className={`flex-1 py-2 rounded-lg text-sm font-semibold capitalize transition-all whitespace-nowrap ${
                  tab === t ? 'bg-white text-brand-700 shadow-sm' : 'text-ink-muted hover:text-ink'
                }`}
              >
                {t === 'admin' ? '🔐 Admin' : '🏪 Retailer'}
              </button>
            ))}
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="label">Username</label>
              <input value={username} onChange={e => setUsername(e.target.value)}
                className="input" placeholder={tab === 'admin' ? 'admin username' : 'retailer username'}
                autoFocus autoComplete="username" />
            </div>
            <div>
              <label className="label">Password</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                className="input" placeholder="••••••••" autoComplete="current-password" />
            </div>
            <button type="submit" disabled={loading || !username || !password} className="btn-primary w-full py-3 mt-2">
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
        </div>

        <div className="text-center mt-5">
          <Link href="/customer" className="text-sm text-ink-muted hover:text-brand-600 transition-colors underline underline-offset-4">
            Customer? View your EMI account →
          </Link>
        </div>
      </div>
    </div>
  );
}
