'use client';

import { Customer, Retailer } from '@/lib/types';
import { format } from 'date-fns';
import { useState, useMemo, memo, useRef, useCallback, useEffect } from 'react';
import toast from 'react-hot-toast';
import Link from 'next/link';
import Image from 'next/image';
import PhoneLockBadge from './PhoneLockBadge';
import CustomerAppDownload from './CustomerAppDownload';

interface Props {
  customer: Customer;
  paidCount: number;
  totalEmis: number;
  isAdmin?: boolean;
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0 }).format(n);
}

const CustomerDetailPanel = memo(function CustomerDetailPanel({ customer, paidCount, totalEmis, isAdmin }: Props) {
  const [copiedNum, setCopiedNum] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const progress = totalEmis > 0 ? (paidCount / totalEmis) * 100 : 0;
  const retailer = customer.retailer as Retailer | null;

  const phones = useMemo(() => [
    { label: 'Primary', num: customer.mobile },
    ...(customer.alternate_number_1 ? [{ label: 'Alt 1', num: customer.alternate_number_1 }] : []),
    ...(customer.alternate_number_2 ? [{ label: 'Alt 2', num: customer.alternate_number_2 }] : []),
  ], [customer.mobile, customer.alternate_number_1, customer.alternate_number_2]);

  function buildWAMsg() {
    return [
      `📱 *TelePoint — Customer Info*`,
      ``,
      `👤 Name: ${customer.customer_name}`,
      ...(customer.father_name ? [`👨 Father: ${customer.father_name}`] : []),
      `📞 Mobile: ${customer.mobile}`,
      ...(customer.alternate_number_1 ? [`📞 Alt: ${customer.alternate_number_1}`] : []),
      `📦 Model: ${customer.model_no || 'N/A'}`,
      `🔢 IMEI: ${customer.imei}`,
      `💰 Purchase Value: ${fmt(customer.purchase_value)}`,
      `⬇️ Down Payment: ${fmt(customer.down_payment)}`,
      `📅 Purchase Date: ${format(new Date(customer.purchase_date), 'd MMM yyyy')}`,
      `📆 EMI Day: ${customer.emi_due_day}th of each month`,
      `💳 EMI Amount: ${fmt(customer.emi_amount)}`,
      `🗓 Tenure: ${customer.emi_tenure} months`,
    ].join('\n');
  }

  function copyNum(num: string) {
    navigator.clipboard.writeText(num);
    setCopiedNum(num);
    toast.success(`Copied: ${num}`);
    setTimeout(() => setCopiedNum(null), 2000);
  }

  function shareWA(num: string) {
    window.open(`https://wa.me/91${num.replace(/\D/g, '')}?text=${encodeURIComponent(buildWAMsg())}`, '_blank');
    setShareOpen(false);
  }

  // IBB image handling
  function ibbDirect(url?: string): string {
    if (!url) return '';
    // Already direct image
    if (/i\.ibb\.co|\.jpg|\.jpeg|\.png|\.webp/i.test(url)) return url;
    // View link → try to convert
    if (url.includes('ibb.co/')) {
      const id = url.split('ibb.co/')[1]?.split('/')[0];
      if (id) return `https://i.ibb.co/${id}/img.jpg`; // best-effort
    }
    return url;
  }

  // Retailers may only see the customer's photo. Aadhaar / bill / EMI-card
  // images are sensitive KYC documents and stay admin-only.
  const docs = useMemo(() => (isAdmin
    ? [
        { label: 'Customer Photo', url: customer.customer_photo_url },
        { label: 'Aadhaar Front', url: customer.aadhaar_front_url },
        { label: 'Aadhaar Back', url: customer.aadhaar_back_url },
        { label: 'Bill', url: customer.bill_photo_url },
        { label: 'EMI Card', url: customer.emi_card_photo_url },
      ]
    : [
        { label: 'Customer Photo', url: customer.customer_photo_url },
      ]
  ).filter(d => d.url), [
    isAdmin,
    customer.customer_photo_url,
    customer.aadhaar_front_url,
    customer.aadhaar_back_url,
    customer.bill_photo_url,
    customer.emi_card_photo_url
  ]);

  // Anti-gravity swipe physics
  const cardRef = useRef<HTMLDivElement>(null);
  const photoRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const phoneRef = useRef<HTMLButtonElement>(null);

  const startY = useRef(0);
  const currentY = useRef(0);
  const isSwiping = useRef(false);
  const rafId = useRef<number | null>(null);

  const updateTransforms = useCallback(() => {
    if (!photoRef.current || !detailsRef.current || !phoneRef.current) return;
    
    // Clamp the swipe to -100px max upward
    const pull = Math.max(-100, Math.min(0, currentY.current));
    const dampened = pull * 0.55;

    photoRef.current.style.transform = `translate3d(0, ${dampened * 1.3}px, 0) scale3d(${1 + Math.abs(dampened) * 0.0015}, ${1 + Math.abs(dampened) * 0.0015}, 1)`;
    detailsRef.current.style.transform = `translate3d(0, ${dampened}px, 0)`;
    
    if (pull < -15) {
      phoneRef.current.style.transform = `scale3d(1.05, 1.05, 1) translate3d(0, ${dampened * 0.4}px, 0)`;
      phoneRef.current.style.boxShadow = `0 4px 16px rgba(22, 163, 74, 0.25)`;
      phoneRef.current.style.borderColor = `#86efac`;
      phoneRef.current.style.backgroundColor = `#dcfce7`;
    } else {
      phoneRef.current.style.transform = `translate3d(0, 0, 0) scale3d(1, 1, 1)`;
      phoneRef.current.style.boxShadow = ``;
      phoneRef.current.style.borderColor = ``;
      phoneRef.current.style.backgroundColor = ``;
    }
  }, []);

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;

    const onTouchStart = (e: TouchEvent) => {
      isSwiping.current = true;
      startY.current = e.touches[0].clientY;
      currentY.current = 0;
      if (photoRef.current) photoRef.current.style.transition = 'none';
      if (detailsRef.current) detailsRef.current.style.transition = 'none';
      if (phoneRef.current) phoneRef.current.style.transition = 'none';
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!isSwiping.current) return;
      const y = e.touches[0].clientY;
      const deltaY = y - startY.current;
      
      if (deltaY > 0) return; // Only allow swipe UP
      
      currentY.current = deltaY;
      if (rafId.current) cancelAnimationFrame(rafId.current);
      rafId.current = requestAnimationFrame(updateTransforms);
    };

    const onTouchEnd = () => {
      isSwiping.current = false;
      currentY.current = 0;
      
      const springTransition = 'transform 0.6s cubic-bezier(0.25, 1, 0.5, 1), box-shadow 0.6s cubic-bezier(0.25, 1, 0.5, 1), border-color 0.6s cubic-bezier(0.25, 1, 0.5, 1), background-color 0.6s cubic-bezier(0.25, 1, 0.5, 1)';
      
      if (photoRef.current) {
        photoRef.current.style.transition = springTransition;
        photoRef.current.style.transform = 'translate3d(0, 0, 0) scale3d(1, 1, 1)';
      }
      if (detailsRef.current) {
        detailsRef.current.style.transition = springTransition;
        detailsRef.current.style.transform = 'translate3d(0, 0, 0)';
      }
      if (phoneRef.current) {
        phoneRef.current.style.transition = springTransition;
        phoneRef.current.style.transform = 'translate3d(0, 0, 0) scale3d(1, 1, 1)';
        phoneRef.current.style.boxShadow = '';
        phoneRef.current.style.borderColor = '';
        phoneRef.current.style.backgroundColor = '';
      }
    };

    card.addEventListener('touchstart', onTouchStart, { passive: true });
    card.addEventListener('touchmove', onTouchMove, { passive: true });
    card.addEventListener('touchend', onTouchEnd, { passive: true });
    card.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      card.removeEventListener('touchstart', onTouchStart);
      card.removeEventListener('touchmove', onTouchMove);
      card.removeEventListener('touchend', onTouchEnd);
      card.removeEventListener('touchcancel', onTouchEnd);
      if (rafId.current) cancelAnimationFrame(rafId.current);
    };
  }, [updateTransforms]);

  return (
    <div ref={cardRef} className="card overflow-hidden animate-fade-in will-change-transform">
      {/* Header row */}
      <div className="flex items-start gap-4 p-5 border-b border-surface-4">
        {/* Photo */}
        <div ref={photoRef} className="w-20 h-20 rounded-2xl border border-surface-4 flex-shrink-0 relative overflow-hidden animate-photo-in gpu-layer will-change-transform">
          <div className="absolute inset-0 bg-amber-50 flex items-center justify-center">
            <span className="text-3xl font-bold text-amber-400 font-display select-none leading-none">
              {customer.customer_name?.[0]?.toUpperCase() ?? '?'}
            </span>
          </div>
          {customer.customer_photo_url && (
            <Image
              src={ibbDirect(customer.customer_photo_url)}
              alt="Photo"
              fill
              className="absolute inset-0 w-full h-full object-cover"
              loading="eager"
              quality={100}
              priority
              sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          )}
        </div>

        <div ref={detailsRef} className="flex-1 min-w-0 will-change-transform">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div>
              <h2 className="text-xl font-bold text-ink font-display leading-tight">{customer.customer_name}</h2>
              {customer.father_name && <p className="text-ink-muted text-sm">C/O {customer.father_name}</p>}
            </div>
            <span className={`badge ${
              customer.status === 'RUNNING' ? 'badge-green' :
              customer.status === 'SETTLED' ? 'bg-warning-light text-warning border border-warning-border' :
              customer.status === 'NPA' ? 'bg-danger-light text-danger border border-danger-border' :
              'badge-blue'
            }`}>
              {customer.status === 'RUNNING' ? '● Running' :
               customer.status === 'SETTLED' ? '⚖ Settled' :
               customer.status === 'NPA' ? '⚠ NPA' :
               '✓ Complete'}
            </span>
          </div>

          {/* Phone Lock */}
          <div className="flex flex-wrap items-center gap-3 mt-2.5">
            <PhoneLockBadge customerId={customer.id} isLocked={customer.is_locked || false} lockProvider={customer.lock_provider} isAdmin={isAdmin || false} />
          </div>

          {/* Phones + share */}
          <div className="flex flex-wrap gap-2 mt-2.5">
            {phones.map(({ label, num }, idx) => (
              <button
                key={num}
                ref={idx === 0 ? phoneRef : null}
                onClick={() => copyNum(num)}
                title={`Copy ${label} (${num})`}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium transition-all will-change-transform ${
                  copiedNum === num ? 'border-success bg-success-light text-success' : 'border-surface-4 text-ink-muted hover:border-brand-300 hover:text-ink'
                }`}
              >
                📞 <span className="num">{num}</span>
                {copiedNum === num && ' ✓'}
              </button>
            ))}

            {/* WhatsApp share */}
            <div className="relative">
              <button
                onClick={() => setShareOpen(v => !v)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-green-300 bg-green-50 text-green-700 text-xs font-medium hover:bg-green-100 transition-all"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                </svg>
                Share
              </button>
              {shareOpen && (
                <div className="absolute top-9 left-0 z-50 card p-2 min-w-52 shadow-modal animate-fade-in">
                  <p className="text-[10px] text-ink-muted uppercase tracking-widest px-2 pb-1.5 pt-0.5">WhatsApp</p>
                  {phones.map(({ label, num }) => (
                    <button
                      key={num}
                      onClick={() => shareWA(num)}
                      className="w-full text-left px-3 py-2 text-sm text-ink hover:bg-green-50 hover:text-green-700 rounded-lg transition-colors"
                    >
                      {label}: <span className="num">{num}</span>
                    </button>
                  ))}
                  <div className="h-px bg-surface-4 my-1" />
                  <button
                    onClick={() => { navigator.clipboard.writeText(buildWAMsg()); toast.success('Message copied'); setShareOpen(false); }}
                    className="w-full text-left px-3 py-2 text-sm text-ink-muted hover:bg-surface-3 rounded-lg transition-colors"
                  >
                    📋 Copy message
                  </button>
                </div>
              )}
            </div>

            {/* Admin NOC/Bill — ONLY for COMPLETE customers */}
            {isAdmin && customer.status === 'COMPLETE' && (
              <>
                <Link href={`/noc/${customer.id}?type=noc`} target="_blank"
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-info-border bg-info-light text-info text-xs font-medium hover:opacity-80 transition-opacity">
                  📄 NOC
                </Link>
                <Link href={`/noc/${customer.id}?type=bill`} target="_blank"
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-info-border bg-info-light text-info text-xs font-medium hover:opacity-80 transition-opacity">
                  🧾 Bill
                </Link>
              </>
            )}
            {isAdmin && customer.status === 'SETTLED' && (
              <a href={`/api/settlement-letter/${customer.id}`} target="_blank"
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-warning-border bg-warning-light text-warning text-xs font-medium hover:opacity-80 transition-opacity">
                📄 Settlement Letter
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="px-5 py-3 border-b border-surface-4 bg-surface-2">
        <div className="flex justify-between text-xs text-ink-muted mb-2">
          <span>EMI Progress</span>
          <span className="num font-medium">{paidCount}/{totalEmis} paid</span>
        </div>
        <div className="h-2 bg-surface-4 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-brand-400 to-brand-500 rounded-full transition-all duration-700"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Detail grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-surface-4">
        {[
          { l: 'IMEI', v: customer.imei, mono: true, small: true, tint: 'slate' },
          { l: 'Model', v: customer.model_no, tint: 'slate' },
          { l: 'Box No.', v: customer.box_no, tint: 'slate' },
          { l: 'Retailer', v: retailer?.name, tint: 'slate' },
          ...(retailer?.mobile ? [{ l: 'Retailer Mobile', v: retailer.mobile, mono: true, tint: 'slate' }] : []),
          { l: 'Purchase Date', v: format(new Date(customer.purchase_date), 'd MMM yyyy'), tint: 'slate' },
          { l: '📱 Purchase Value', v: fmt(customer.purchase_value), mono: true, tint: 'indigo', sub: 'Mobile price' },
          { l: '⬇ Down Payment', v: fmt(customer.down_payment), mono: true, tint: 'amber', sub: 'Paid upfront' },
          { l: '💰 Loan Amount', v: fmt(Math.max(0, Number(customer.purchase_value || 0) - Number(customer.down_payment || 0))), mono: true, tint: 'violet', sub: 'Purchase − Down' },
          { l: '💳 EMI Amount', v: fmt(customer.emi_amount), mono: true, tint: 'emerald', accent: true },
          { l: 'Tenure', v: `${customer.emi_tenure} months`, mono: true, tint: 'sky' },
          { l: 'EMI Due Day', v: `${customer.emi_due_day}th`, tint: 'sky' },
          ...(customer.aadhaar ? [{ l: 'Aadhaar', v: customer.aadhaar, mono: true, tint: 'slate' }] : []),
          ...(customer.voter_id ? [{ l: 'Voter ID', v: customer.voter_id, tint: 'slate' }] : []),
          ...(customer.address ? [{ l: 'Address', v: `${customer.address}${customer.landmark ? `, ${customer.landmark}` : ''}`, tint: 'slate' }] : []),
        ].filter(x => x.v).map(({ l, v, mono, small, accent, tint, sub }: any) => {
          const tintBg: Record<string, string> = {
            indigo: 'bg-indigo-50', amber: 'bg-amber-50', violet: 'bg-violet-50',
            emerald: 'bg-emerald-50', sky: 'bg-sky-50', slate: 'bg-white',
          };
          const tintLabel: Record<string, string> = {
            indigo: 'text-indigo-700', amber: 'text-amber-700', violet: 'text-violet-700',
            emerald: 'text-emerald-700', sky: 'text-sky-700', slate: 'text-ink-muted',
          };
          const tintValue: Record<string, string> = {
            indigo: 'text-indigo-900', amber: 'text-amber-900', violet: 'text-violet-900',
            emerald: 'text-emerald-900', sky: 'text-sky-900', slate: 'text-ink',
          };
          return (
            <div key={l} className={`${tintBg[tint] || 'bg-white'} px-4 py-3`}>
              <p className={`text-[10px] ${tintLabel[tint] || 'text-ink-muted'} uppercase tracking-wide mb-0.5 font-semibold`}>{l}</p>
              <p className={`text-sm font-semibold ${small ? 'text-xs' : ''} ${mono ? 'num' : ''} ${accent ? 'text-emerald-700 font-bold text-base' : (tintValue[tint] || 'text-ink')} break-all leading-snug`}>
                {v || '—'}
              </p>
              {sub && <p className={`text-[9px] mt-0.5 ${tintLabel[tint] || 'text-ink-muted'} opacity-80`}>{sub}</p>}
            </div>
          );
        })}
      </div>

      {/* Document images */}
      {docs.length > 0 && (
        <div className="px-5 py-4 border-t border-surface-4">
          <p className="text-xs font-semibold text-ink-muted uppercase tracking-widest mb-3">Documents</p>
          <div className="flex flex-wrap gap-3">
            {docs.map(d => (
              <a key={d.label} href={d.url!} target="_blank" rel="noopener noreferrer" className="group relative block h-20 w-28 overflow-hidden rounded-xl border border-surface-4 group-hover:border-brand-300 transition-colors">
                <Image
                  src={ibbDirect(d.url)}
                  alt={d.label}
                  fill
                  sizes="120px"
                  quality={80}
                  className="object-cover"
                  loading="lazy"
                  onError={e => {
                    const img = e.target as HTMLImageElement;
                    img.style.display = 'none';
                    const fb = img.nextElementSibling as HTMLElement;
                    if (fb) fb.style.display = 'flex';
                  }}
                />
                <div className="hidden absolute inset-0 bg-surface-3 items-center justify-center">
                  <p className="text-[10px] text-ink-muted text-center px-2">Preview unavailable</p>
                </div>
                <p className="absolute bottom-0 inset-x-0 bg-black/50 text-[10px] text-white mt-1 text-center py-0.5">{d.label}</p>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* 1st EMI charge status */}
      {(customer.first_emi_charge_amount || 0) > 0 && (
        <div className={`px-5 py-3 border-t border-surface-4 flex items-center justify-between ${customer.first_emi_charge_paid_at ? 'bg-success-light' : 'bg-warning-light'}`}>
          <div>
            <p className="text-xs text-ink-muted mb-0.5">1st EMI Charge</p>
            <p className="num font-bold text-ink">{fmt(customer.first_emi_charge_amount)}</p>
          </div>
          {customer.first_emi_charge_paid_at
            ? <span className="badge-green">✓ Paid</span>
            : <span className="badge-yellow">⭐ Pending</span>}
        </div>
      )}

      {/* Completion info */}
      {(customer.status === 'COMPLETE' || customer.status === 'SETTLED' || customer.status === 'NPA') && customer.completion_remark && (
        <div className="px-5 py-3 border-t border-surface-4 bg-info-light">
          <p className="text-xs text-info font-semibold mb-1">✓ Completion Remark</p>
          <p className="text-sm text-ink">{customer.completion_remark}</p>
          {customer.completion_date && <p className="text-xs text-ink-muted mt-0.5">{format(new Date(customer.completion_date), 'd MMM yyyy')}</p>}
        </div>
      )}
    </div>
  );
});

export default CustomerDetailPanel;
