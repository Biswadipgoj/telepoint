'use client';
import { useState, useEffect } from 'react';

function fmt(n: number) { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0 }).format(n); }

export default function SmartAlertPopup({ fineDue, daysUntilDue, nextEmiNo, nextEmiAmount, firstChargeDue }: {
  fineDue: number; daysUntilDue: number | null; nextEmiNo?: number; nextEmiAmount?: number; firstChargeDue: number;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [show, setShow] = useState(false);

  const alerts: { icon: string; title: string; msg: string; color: string }[] = [];
  if (daysUntilDue !== null && daysUntilDue >= 0 && daysUntilDue <= 5)
    alerts.push({ icon: '🔔', title: daysUntilDue === 0 ? 'EMI Due Today!' : `EMI Due in ${daysUntilDue} Days`, msg: `EMI #${nextEmiNo || '—'} — ${fmt(nextEmiAmount || 0)}`, color: '#92400e' });
  if (fineDue > 0)
    alerts.push({ icon: '⚠️', title: 'Late Fine Due', msg: `Fine of ${fmt(fineDue)} pending. Grows ₹25/week.`, color: '#dc2626' });
  if (firstChargeDue > 0)
    alerts.push({ icon: '⭐', title: '1st EMI Charge Pending', msg: `One-time charge of ${fmt(firstChargeDue)} due.`, color: '#d97706' });

  useEffect(() => { if (alerts.length > 0 && !dismissed) setTimeout(() => setShow(true), 300); }, [alerts.length, dismissed]);
  if (!alerts.length || dismissed || !show) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" onClick={() => setDismissed(true)}>
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative z-10 bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden animate-scale-in" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-5 text-center" style={{ background: 'linear-gradient(135deg, #fef3c7, #fde68a)' }}>
          <div className="text-4xl mb-2">{alerts[0].icon}</div>
          <h2 className="font-bold text-lg text-amber-900">{alerts[0].title}</h2>
          <p className="text-sm text-amber-800 mt-1">{alerts[0].msg}</p>
        </div>
        {alerts.length > 1 && <div className="px-6 py-4 space-y-3">
          {alerts.slice(1).map((a, i) => (<div key={i} className="flex items-start gap-3 p-3 rounded-xl bg-surface-2"><span className="text-xl">{a.icon}</span><div><p className="text-sm font-semibold" style={{ color: a.color }}>{a.title}</p><p className="text-xs text-ink-muted mt-0.5">{a.msg}</p></div></div>))}
        </div>}
        <div className="px-6 pb-5 pt-2">
          <button onClick={() => setDismissed(true)} className="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-semibold text-sm">Got it</button>
        </div>
      </div>
    </div>
  );
}
