'use client';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { readJsonSafe } from '@/lib/formatters';

interface Props {
  customerId: string;
  customerName: string;
  mobile: string;
}

export default function CustomerAppDownload({ customerId, customerName, mobile }: Props) {
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [qrUrl, setQrUrl] = useState('');
  const [showPanel, setShowPanel] = useState(false);

  const appUrl = token ? `${window.location.origin}/customer?token=${token}` : '';

  async function generateToken() {
    setLoading(true);
    try {
      const res = await fetch('/api/customer-app-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: customerId }),
      });
      const data = await readJsonSafe<{ error?: string; token?: string }>(res) || {};
      if (!res.ok) { toast.error(data.error || 'Failed'); return; }
      setToken(data.token);

      // Generate QR code for the app URL
      const fullUrl = `${window.location.origin}/customer?token=${data.token}`;
      try {
        const QRCode = await import('qrcode');
        const qr = await QRCode.toDataURL(fullUrl, {
          width: 280, margin: 2,
          color: { dark: '#1e293b', light: '#ffffff' },
        });
        setQrUrl(qr);
      } catch { /* QR generation optional */ }

      setShowPanel(true);
      toast.success('App link generated!');
    } catch { toast.error('Network error'); }
    finally { setLoading(false); }
  }

  function copyLink() {
    navigator.clipboard.writeText(appUrl).then(() => toast.success('Link copied!'));
  }

  function shareWhatsApp() {
    const msg = [
      `📱 *TelePoint EMI App*`,
      ``,
      `Dear ${customerName},`,
      `Your EMI portal app is ready!`,
      ``,
      `👉 Open this link to access your EMI details:`,
      appUrl,
      ``,
      `📌 Save this link or add to home screen for quick access.`,
      `You can check EMI schedule, fine status, and payment history anytime.`,
      ``,
      `— TelePoint`,
    ].join('\n');
    window.open(`https://wa.me/${mobile.replace(/\D/g, '')}?text=${encodeURIComponent(msg)}`, '_blank');
  }

  return (
    <>
      <button
        onClick={token ? () => setShowPanel(true) : generateToken}
        disabled={loading}
        className="px-3 py-1.5 text-xs font-medium rounded-lg border border-brand-400 text-brand-600 hover:bg-brand-50 transition-colors"
      >
        {loading ? '...' : '📱 Customer App'}
      </button>

      {showPanel && token && (
        <div className="modal-backdrop" onClick={() => setShowPanel(false)}>
          <div className="modal-panel max-w-sm" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-surface-4 text-center" style={{ background: 'linear-gradient(135deg, #dbeafe, #eff6ff)' }}>
              <div className="text-4xl mb-2">📱</div>
              <h2 className="font-bold text-lg text-blue-900">Customer App Ready</h2>
              <p className="text-sm text-blue-700 mt-1">{customerName}</p>
            </div>

            <div className="p-5 space-y-4">
              {/* QR Code */}
              {qrUrl && (
                <div className="flex flex-col items-center">
                  <div className="bg-white p-3 rounded-2xl shadow-sm border border-surface-4">
                    <img src={qrUrl} alt="App QR Code" className="w-56 h-56" />
                  </div>
                  <p className="text-xs text-ink-muted mt-2">Scan to open customer portal</p>
                </div>
              )}

              {/* App Link */}
              <div className="card bg-surface-2 p-3">
                <p className="text-xs text-ink-muted mb-1">App Link</p>
                <p className="text-xs num text-ink break-all select-all bg-white p-2 rounded-lg border border-surface-4">
                  {appUrl}
                </p>
              </div>

              {/* Instructions */}
              <div className="text-xs text-ink-muted space-y-1">
                <p className="font-semibold text-ink">How customer uses this:</p>
                <p>1. Open the link on their phone</p>
                <p>2. Tap <strong>"Add to Home Screen"</strong> in browser menu</p>
                <p>3. App icon appears — auto-login every time</p>
                <p>4. No aadhaar/mobile needed — the link IS their login</p>
              </div>

              {/* Actions */}
              <div className="flex flex-col gap-2">
                <button onClick={shareWhatsApp} className="btn w-full py-3 bg-green-500 hover:bg-green-600 text-white">
                  📤 Send via WhatsApp
                </button>
                <button onClick={copyLink} className="btn-secondary w-full py-2.5">
                  📋 Copy Link
                </button>
                <button onClick={() => setShowPanel(false)} className="btn-ghost w-full py-2.5">
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
