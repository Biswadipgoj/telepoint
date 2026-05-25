'use client';
import { useState, useEffect, useCallback } from 'react';

type Stage = 'enter' | 'center' | 'shutter' | 'shake' | 'banner' | 'done';

export default function BroadcastAnimator({ broadcasts }: { broadcasts: { id: string; message: string; image_url?: string | null; sender_name?: string; sender_role?: string; expires_at: string }[] }) {
  const [current, setCurrent] = useState<typeof broadcasts[0] | null>(null);
  const [queue, setQueue] = useState<typeof broadcasts>([]);
  const [stage, setStage] = useState<Stage>('enter');
  const [banners, setBanners] = useState<typeof broadcasts>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    const active = broadcasts.filter(b => new Date(b.expires_at) > new Date());
    if (active.length > 0) { setCurrent(active[0]); setQueue(active.slice(1)); setStage('enter'); }
  }, [broadcasts]);

  useEffect(() => {
    if (!current) return;
    let t: NodeJS.Timeout;
    if (stage === 'enter') t = setTimeout(() => setStage('center'), 100);
    else if (stage === 'center') t = setTimeout(() => setStage('shutter'), 2000);
    else if (stage === 'shutter') t = setTimeout(() => setStage('shake'), 400);
    else if (stage === 'shake') t = setTimeout(() => {
      setBanners(p => [...p, current]);
      if (queue.length > 0) { setCurrent(queue[0]); setQueue(p => p.slice(1)); setStage('enter'); }
      else { setCurrent(null); setStage('done'); }
    }, 500);
    return () => clearTimeout(t);
  }, [stage, current, queue]);

  const dismiss = useCallback((id: string) => { setDismissed(p => new Set([...p, id])); setBanners(p => p.filter(b => b.id !== id)); }, []);

  const posStyle = (s: Stage): React.CSSProperties => {
    if (s === 'enter') return { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%) scale(0.9)', opacity: 0, transition: 'all 0.3s cubic-bezier(0.16,1,0.3,1)', zIndex: 70 };
    if (s === 'center') return { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', opacity: 1, zIndex: 70 };
    if (s === 'shutter') return { position: 'fixed', top: '8px', left: '50%', transform: 'translate(-50%,0)', opacity: 1, transition: 'all 0.4s cubic-bezier(0.16,1,0.3,1)', zIndex: 70 };
    if (s === 'shake') return { position: 'fixed', top: '8px', left: '50%', transform: 'translate(-50%,0)', opacity: 1, animation: 'bc-shake 0.5s ease', zIndex: 70 };
    return {};
  };

  return (<>
    <style jsx global>{`@keyframes bc-shake { 0%{transform:translate(-50%,0)} 15%{transform:translate(calc(-50% - 4px),0)} 30%{transform:translate(calc(-50% + 4px),0)} 45%{transform:translate(calc(-50% - 2px),0)} 60%{transform:translate(calc(-50% + 2px),0)} 100%{transform:translate(-50%,0)} }`}</style>
    {current && (stage === 'enter' || stage === 'center') && <div className="fixed inset-0 z-[65] bg-black/40 backdrop-blur-sm" />}
    {current && stage !== 'done' && (<div style={{ ...posStyle(stage), width: '90vw', maxWidth: '380px' }}><Card b={current} /></div>)}
    {banners.filter(b => !dismissed.has(b.id)).map((b, i) => (
      <div key={b.id} className="fixed left-0 right-0 z-[60] px-3 animate-fade-in" style={{ top: `${4 + i * 72}px` }}>
        <Card b={b} onDismiss={() => dismiss(b.id)} />
      </div>
    ))}
  </>);
}

function Card({ b, onDismiss }: { b: { message: string; image_url?: string | null; sender_name?: string; sender_role?: string }; onDismiss?: () => void }) {
  const isR = b.sender_role === 'retailer';
  return (
    <div className="rounded-2xl shadow-2xl overflow-hidden" style={{ background: isR ? 'linear-gradient(135deg,#dcfce7,#f0fdf4)' : 'linear-gradient(135deg,#dbeafe,#eff6ff)', border: isR ? '2px solid #86efac' : '2px solid #93c5fd' }}>
      <div className="px-4 py-3 flex items-start gap-3">
        <span className="text-2xl flex-shrink-0">{isR ? '🏪' : '📢'}</span>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-sm" style={{ color: isR ? '#16a34a' : '#1d4ed8' }}>Message from {b.sender_name || 'TELEPOINT'}</p>
          <p className="text-sm mt-1" style={{ color: isR ? '#15803d' : '#1e40af' }}>{b.message}</p>
          {b.image_url && <img src={b.image_url} alt="" className="mt-2 max-h-32 rounded-xl object-cover" />}
        </div>
        {onDismiss && <button onClick={onDismiss} className="flex-shrink-0 text-lg opacity-60 hover:opacity-100" style={{ color: isR ? '#16a34a' : '#1d4ed8' }}>✕</button>}
      </div>
    </div>
  );
}
