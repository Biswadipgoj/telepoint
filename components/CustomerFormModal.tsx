'use client';

import { useState, useEffect, useRef} from 'react';
import { Customer, Retailer } from '@/lib/types';
import { createClient } from '@/lib/supabase/client';
import toast from 'react-hot-toast';

interface CustomerFormModalProps {
  customer?: Customer | null;
  retailers: Retailer[];
  onClose: () => void;
  onSaved: () => void;
  isAdmin: boolean;
}

const EMPTY = {
  retailer_id: '',
  customer_name: '',
  father_name: '',
  aadhaar: '',
  voter_id: '',
  address: '',
  landmark: '',
  mobile: '',
  alternate_number_1: '',
  alternate_number_2: '',
  model_no: '',
  imei: '',
  box_no: '',
  purchase_value: '',
  down_payment: '0',
  disburse_amount: '',
  purchase_date: new Date().toISOString().split('T')[0],
  emi_start_date: '',
  emi_due_day: '5',
  emi_amount: '',
  emi_tenure: '6',
  first_emi_charge_amount: '0',
  // Images — ALL optional
  customer_photo_url: '',
  aadhaar_front_url: '',
  aadhaar_back_url: '',
  bill_photo_url: '',
  emi_card_photo_url: '',
  lock_provider: '',
  lock_device_id: '',
  google_drive_docs: '',
};

type FormData = typeof EMPTY;
type TabKey = 'info' | 'finance' | 'images';

function isValidUrl(url: string) {
  if (!url) return true;
  try { new URL(url); return true; } catch { return false; }
}

export default function CustomerFormModal({
  customer, retailers, onClose, onSaved, isAdmin,
}: CustomerFormModalProps) {
  const _sbRef = useRef<ReturnType<typeof createClient> | null>(null);
  if (typeof window !== 'undefined' && !_sbRef.current) _sbRef.current = createClient();
  const supabase = _sbRef.current!;
  const [form, setForm] = useState<FormData>({ ...EMPTY });
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<TabKey>('info');

  // Track which fields have errors for inline highlighting
  const [errors, setErrors] = useState<Partial<Record<keyof FormData, string>>>({});

  useEffect(() => {
    if (customer) {
      setForm({
        retailer_id: customer.retailer_id || '',
        customer_name: customer.customer_name || '',
        father_name: customer.father_name || '',
        aadhaar: customer.aadhaar || '',
        voter_id: customer.voter_id || '',
        address: customer.address || '',
        landmark: customer.landmark || '',
        mobile: customer.mobile || '',
        alternate_number_1: customer.alternate_number_1 || '',
        alternate_number_2: customer.alternate_number_2 || '',
        model_no: customer.model_no || '',
        imei: customer.imei || '',
        box_no: customer.box_no || '',
        purchase_value: String(customer.purchase_value || ''),
        down_payment: String(customer.down_payment || '0'),
        disburse_amount: customer.disburse_amount ? String(customer.disburse_amount) : '',
        purchase_date: customer.purchase_date || new Date().toISOString().split('T')[0],
        emi_start_date: (customer as unknown as Record<string, unknown>).emi_start_date as string || '',
        emi_due_day: String(customer.emi_due_day || '5'),
        emi_amount: String(customer.emi_amount || ''),
        emi_tenure: String(customer.emi_tenure || '6'),
        first_emi_charge_amount: String(customer.first_emi_charge_amount || '0'),
        customer_photo_url: customer.customer_photo_url || '',
        aadhaar_front_url: customer.aadhaar_front_url || '',
        aadhaar_back_url: customer.aadhaar_back_url || '',
        bill_photo_url: customer.bill_photo_url || '',
        emi_card_photo_url: (customer as unknown as Record<string, unknown>).emi_card_photo_url as string || '',
        lock_provider: (customer as unknown as Record<string, unknown>).lock_provider as string || '',
        lock_device_id: (customer as unknown as Record<string, unknown>).lock_device_id as string || '',
        google_drive_docs: (customer as unknown as Record<string, unknown>).google_drive_docs as string || '',
      });
    }
  }, [customer]);

  function set(k: keyof FormData, v: string) {
    setForm(f => ({ ...f, [k]: v }));
    // Clear error when user types
    if (errors[k]) setErrors(e => ({ ...e, [k]: undefined }));
  }

  const pv = parseFloat(form.purchase_value) || 0;
  const dp = parseFloat(form.down_payment) || 0;
  const autoDisburse = pv > dp ? pv - dp : 0;

  // ── Full manual validation (no HTML required — works across tabs) ──────────
  function validate(): { ok: boolean; switchTo?: TabKey; firstError?: string } {
    const errs: Partial<Record<keyof FormData, string>> = {};

    // ── INFO tab required fields ──────────────────────────────────
    if (!form.retailer_id)
      errs.retailer_id = 'Select a retailer';

    if (!form.customer_name.trim())
      errs.customer_name = 'Customer name is required';

    if (!form.father_name?.trim())
      errs.father_name = 'Father name is required';

    if (!form.mobile || form.mobile.replace(/\D/g, '').length !== 10)
      errs.mobile = 'Mobile must be exactly 10 digits';

    if (form.alternate_number_1 && form.alternate_number_1.replace(/\D/g, '').length !== 10)
      errs.alternate_number_1 = 'Alternate number must be 10 digits';

    if (form.alternate_number_2 && form.alternate_number_2.replace(/\D/g, '').length !== 10)
      errs.alternate_number_2 = 'Alternate number must be 10 digits';

    if (!form.aadhaar || form.aadhaar.replace(/\D/g, '').length !== 12)
      errs.aadhaar = 'Aadhaar must be exactly 12 digits';

    if (!form.address.trim())
      errs.address = 'Address is required';

    if (!form.landmark.trim())
      errs.landmark = 'Landmark is required';

    if (!form.model_no.trim())
      errs.model_no = 'Model number is required';

    if (!form.imei || form.imei.replace(/\D/g, '').length !== 15)
      errs.imei = 'IMEI must be exactly 15 digits';

    if (!form.box_no.trim())
      errs.box_no = 'Box number is required';

    // ── FINANCE tab required fields ────────────────────────────────
    if (!form.purchase_value || parseFloat(form.purchase_value) <= 0)
      errs.purchase_value = 'Purchase value is required';

    if (!form.purchase_date)
      errs.purchase_date = 'Purchase date is required';

    if (!form.emi_amount || parseFloat(form.emi_amount) <= 0)
      errs.emi_amount = 'EMI amount is required';

    if (!form.emi_due_day || parseInt(form.emi_due_day) < 1 || parseInt(form.emi_due_day) > 28)
      errs.emi_due_day = 'EMI due day must be between 1 and 28';

    // ── IMAGE tab — only validate format if something was entered ──
    if (form.customer_photo_url && !isValidUrl(form.customer_photo_url))
      errs.customer_photo_url = 'Invalid URL';
    if (form.aadhaar_front_url && !isValidUrl(form.aadhaar_front_url))
      errs.aadhaar_front_url = 'Invalid URL';
    if (form.aadhaar_back_url && !isValidUrl(form.aadhaar_back_url))
      errs.aadhaar_back_url = 'Invalid URL';
    if (form.bill_photo_url && !isValidUrl(form.bill_photo_url))
      errs.bill_photo_url = 'Invalid URL';
    if (form.emi_card_photo_url && !isValidUrl(form.emi_card_photo_url))
      errs.emi_card_photo_url = 'Invalid URL';

    setErrors(errs);

    const firstError = Object.values(errs)[0];
    if (Object.keys(errs).length === 0) return { ok: true };

    // Figure out which tab to switch to for the first error
    const infoFields: (keyof FormData)[] = [
      'retailer_id', 'customer_name', 'father_name', 'mobile', 'alternate_number_1',
      'alternate_number_2', 'aadhaar', 'address', 'landmark', 'model_no', 'imei', 'box_no',
    ];
    const financeFields: (keyof FormData)[] = [
      'purchase_value', 'purchase_date', 'emi_amount', 'emi_due_day',
    ];
    const imageFields: (keyof FormData)[] = [
      'customer_photo_url', 'aadhaar_front_url', 'aadhaar_back_url', 'bill_photo_url',
    ];

    const firstErr = Object.keys(errs)[0] as keyof FormData;
    let switchTo: TabKey = 'info';
    if (financeFields.includes(firstErr)) switchTo = 'finance';
    else if (imageFields.includes(firstErr)) switchTo = 'images';

    return { ok: false, switchTo, firstError };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const { ok, switchTo, firstError } = validate();
    if (!ok) {
      if (switchTo && switchTo !== tab) {
        setTab(switchTo);
        // Small delay so the tab renders before the toast
        setTimeout(() => toast.error(firstError || 'Please fix the highlighted fields'), 50);
      } else {
        toast.error(firstError || 'Please fill all required fields');
      }
      return;
    }

    setLoading(true);
    const payload = {
      retailer_id: form.retailer_id,
      customer_name: form.customer_name.trim(),
      father_name: form.father_name.trim() || null,
      aadhaar: form.aadhaar.replace(/\D/g, '') || null,
      voter_id: form.voter_id.trim() || null,
      address: form.address.trim() || null,
      landmark: form.landmark.trim() || null,
      mobile: form.mobile.replace(/\D/g, ''),
      alternate_number_1: form.alternate_number_1.replace(/\D/g, '') || null,
      alternate_number_2: form.alternate_number_2.replace(/\D/g, '') || null,
      model_no: form.model_no.trim() || null,
      imei: form.imei.replace(/\D/g, ''),
      box_no: form.box_no.trim() || null,
      purchase_value: pv,
      down_payment: dp,
      disburse_amount: form.disburse_amount ? parseFloat(form.disburse_amount) : (autoDisburse || null),
      purchase_date: form.purchase_date,
      emi_start_date: form.emi_start_date || null,
      emi_due_day: parseInt(form.emi_due_day),
      emi_amount: parseFloat(form.emi_amount),
      emi_tenure: parseInt(form.emi_tenure),
      first_emi_charge_amount: parseFloat(form.first_emi_charge_amount) || 0,
      // Images are always optional
      customer_photo_url: form.customer_photo_url.trim() || null,
      aadhaar_front_url: form.aadhaar_front_url.trim() || null,
      aadhaar_back_url: form.aadhaar_back_url.trim() || null,
      bill_photo_url: form.bill_photo_url.trim() || null,
      emi_card_photo_url: form.emi_card_photo_url.trim() || null,
      lock_provider: form.lock_provider || null,
      lock_device_id: form.lock_device_id.trim() || null,
      google_drive_docs: form.google_drive_docs.trim() || null,
    };

    try {
      let error;
      if (customer) {
        ({ error } = await supabase.from('customers').update(payload).eq('id', customer.id));
      } else {
        ({ error } = await supabase.from('customers').insert(payload));
      }
      if (error) {
        if (error.code === '23505') toast.error('This IMEI already exists in the system');
        else toast.error(error.message);
      } else {
        toast.success(customer ? 'Customer updated!' : 'Customer created!');
        onSaved();
        onClose();
      }
    } finally {
      setLoading(false);
    }
  }

  const tabs = [
    { key: 'info'    as TabKey, label: '👤 Personal & Device' },
    { key: 'finance' as TabKey, label: '💰 Finance & EMI' },
    { key: 'images'  as TabKey, label: '🖼️ Images (optional)' },
  ];

  // Count errors per tab for red dot indicator
  const infoErrCount = ['retailer_id','customer_name','father_name','mobile','alternate_number_1',
    'alternate_number_2','aadhaar','address','landmark','model_no','imei','box_no']
    .filter(f => errors[f as keyof FormData]).length;
  const financeErrCount = ['purchase_value','purchase_date','emi_amount','emi_due_day']
    .filter(f => errors[f as keyof FormData]).length;

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="card w-full max-w-3xl max-h-[92vh] flex flex-col animate-slide-up shadow-modal">

        {/* Header */}
        <div className="sticky top-0 z-10 bg-white px-6 py-4 border-b border-surface-4 flex items-center justify-between">
          <div>
            <h2 className="font-display text-xl font-bold text-ink">
              {customer ? 'Edit Customer' : 'New Customer'}
            </h2>
            <p className="text-xs text-ink-muted mt-0.5">
              Fields marked <span className="text-danger font-semibold">*</span> are required
            </p>
          </div>
          <button onClick={onClose} className="btn-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-surface-4 bg-surface-2">
          {tabs.map(t => {
            const errCount = t.key === 'info' ? infoErrCount : t.key === 'finance' ? financeErrCount : 0;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`flex-1 py-3 text-sm font-medium transition-colors relative ${
                  tab === t.key
                    ? 'text-brand-700 border-b-2 border-brand-500 bg-white'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                {t.label}
                {errCount > 0 && (
                  <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-danger" />
                )}
              </button>
            );
          })}
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto" noValidate>
          <div className="p-6 space-y-6">

            {/* ══════════════ INFO TAB ══════════════ */}
            {tab === 'info' && (
              <>
                {/* Retailer */}
                <section>
                  <p className="form-section">Retailer</p>
                  <FSelect
                    label="Select Retailer" field="retailer_id"
                    form={form} set={set} errors={errors} required
                    disabled={!isAdmin && !!customer}
                  >
                    <option value="">— Select retailer —</option>
                    {retailers.map(r => (
                      <option key={r.id} value={r.id}>{r.name} (@{r.username})</option>
                    ))}
                  </FSelect>
                </section>

                {/* Personal */}
                <section>
                  <p className="form-section">Personal Information</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <F label="Customer Name" field="customer_name"
                       form={form} set={set} errors={errors} required placeholder="Full name" />
                    <F label="Father Name / C/O" field="father_name"
                       form={form} set={set} errors={errors} placeholder="Father or guardian" />
                    <F label="Mobile" field="mobile"
                       form={form} set={set} errors={errors} required placeholder="10 digits" maxLen={10} inputMode="numeric" />
                    <F label="Alternate Number 1" field="alternate_number_1"
                       form={form} set={set} errors={errors} placeholder="Optional — 10 digits" maxLen={10} inputMode="numeric" />
                    <F label="Alternate Number 2" field="alternate_number_2"
                       form={form} set={set} errors={errors} placeholder="Optional — 10 digits" maxLen={10} inputMode="numeric" />
                    <F label="Aadhaar Number" field="aadhaar"
                       form={form} set={set} errors={errors} required placeholder="12 digits" maxLen={12} inputMode="numeric" />
                    <F label="Voter ID" field="voter_id"
                       form={form} set={set} errors={errors} placeholder="Optional" />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                    <F label="Address" field="address"
                       form={form} set={set} errors={errors} required placeholder="Full address" />
                    <F label="Landmark" field="landmark"
                       form={form} set={set} errors={errors} required placeholder="Nearby landmark" />
                  </div>
                </section>

                {/* Device */}
                <section>
                  <p className="form-section">Device Information</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <F label="Model Number" field="model_no"
                       form={form} set={set} errors={errors} required placeholder="e.g. Redmi Note 13" />
                    <F label="IMEI" field="imei"
                       form={form} set={set} errors={errors} required placeholder="15 digits" maxLen={15} inputMode="numeric" />
                    <F label="Box Number" field="box_no"
                       form={form} set={set} errors={errors} required placeholder="Box / serial no." />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                    <div><label className="label">Lock Provider</label><select value={form.lock_provider} onChange={e => set('lock_provider', e.target.value)} className="input"><option value="">— Select —</option><option value="Binowin">Binowin</option><option value="101">101</option><option value="Emi Sathi">Emi Sathi</option><option value="Yogic Astra">Yogic Astra</option><option value="Tiger">Tiger</option></select></div>
                    <F label="Lock Device ID" field="lock_device_id" form={form} set={set} errors={errors} placeholder="IMEI or Lock ID" />
                  </div>
                  <div className="mt-4">
                    <F label="Google Drive Docs Link" field="google_drive_docs" form={form} set={set} errors={errors} placeholder="https://drive.google.com/..." />
                  </div>
                </section>
              </>
            )}

            {/* ══════════════ FINANCE TAB ══════════════ */}
            {tab === 'finance' && (
              <>
                <section>
                  <p className="form-section">Financial Details</p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <F label="Purchase Value (₹)" field="purchase_value"
                       form={form} set={set} errors={errors} type="number" required placeholder="0" />
                    <F label="Down Payment (₹)" field="down_payment"
                       form={form} set={set} errors={errors} type="number" placeholder="0" />
                    <div>
                      <label className="label">Disburse Amount (₹)</label>
                      <input
                        type="number"
                        value={form.disburse_amount}
                        onChange={e => set('disburse_amount', e.target.value)}
                        placeholder={autoDisburse > 0 ? `Auto: ${autoDisburse.toLocaleString('en-IN')}` : '0'}
                        className="input"
                      />
                      {autoDisburse > 0 && !form.disburse_amount && (
                        <p className="text-xs text-ink-muted mt-1">
                          Auto-calculated: ₹{autoDisburse.toLocaleString('en-IN')}
                        </p>
                      )}
                    </div>
                  </div>
                </section>

                <section>
                  <p className="form-section">EMI Configuration</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <F label="Purchase Date" field="purchase_date"
                       form={form} set={set} errors={errors} type="date" required />

                    <div>
                      <label className="label">First EMI Month</label>
                      <select
                        value={form.emi_start_date}
                        onChange={e => set('emi_start_date', e.target.value)}
                        className="input"
                      >
                        <option value="">Default (next month from purchase)</option>
                        {(() => {
                          const pd = form.purchase_date ? new Date(form.purchase_date) : new Date();
                          const day = parseInt(form.emi_due_day) || 5;
                          const opts = [];
                          for (let m = 0; m < 6; m++) {
                            const d = new Date(pd.getFullYear(), pd.getMonth() + 1 + m, 1);
                            const val = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
                            const label = d.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
                            const emiDate = day + ' ' + label;
                            opts.push(<option key={val} value={val}>{emiDate}</option>);
                          }
                          return opts;
                        })()}
                      </select>
                      <p className="text-xs text-ink-muted mt-1">
                        {form.emi_start_date
                          ? `First EMI: ${parseInt(form.emi_due_day) || 5} ${new Date(form.emi_start_date).toLocaleString('en-IN', { month: 'long', year: 'numeric' })}`
                          : `First EMI: ${parseInt(form.emi_due_day) || 5} ${form.purchase_date ? new Date(new Date(form.purchase_date).getFullYear(), new Date(form.purchase_date).getMonth() + 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' }) : 'next month'}`
                        }
                      </p>
                    </div>

                    {/* EMI due day */}
                    <div>
                      <label className="label">
                        EMI Due Day (1–28) <span className="text-danger">*</span>
                      </label>
                      <input
                        type="number" min={1} max={28}
                        value={form.emi_due_day}
                        onChange={e => set('emi_due_day', e.target.value)}
                        className={`input ${errors.emi_due_day ? 'border-danger' : ''}`}
                      />
                      {errors.emi_due_day && (
                        <p className="text-xs text-danger mt-1">{errors.emi_due_day}</p>
                      )}
                    </div>

                    <F label="Monthly EMI (₹)" field="emi_amount"
                       form={form} set={set} errors={errors} type="number" required placeholder="0" />

                    {/* Tenure */}
                    <div>
                      <label className="label">
                        EMI Tenure <span className="text-danger">*</span>
                      </label>
                      <select
                        value={form.emi_tenure}
                        onChange={e => set('emi_tenure', e.target.value)}
                        className="input"
                      >
                        {[1,2,3,4,5,6,7,8,9,10,11,12].map(n => (
                          <option key={n} value={n}>{n} {n === 1 ? 'month' : 'months'}</option>
                        ))}
                      </select>
                    </div>

                    <F label="1st EMI Charge (₹)" field="first_emi_charge_amount"
                       form={form} set={set} errors={errors} type="number" placeholder="0 if none" />
                  </div>

                  {/* EMI summary preview */}
                  {form.emi_amount && form.emi_tenure && (
                    <div className="mt-4 p-4 rounded-xl bg-brand-50 border border-brand-200 grid grid-cols-3 gap-4">
                      <div>
                        <p className="text-xs text-ink-muted mb-1">Monthly EMI</p>
                        <p className="num text-brand-700 font-bold">
                          ₹{parseFloat(form.emi_amount || '0').toLocaleString('en-IN')}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-ink-muted mb-1">Tenure</p>
                        <p className="num text-brand-700 font-bold">{form.emi_tenure} months</p>
                      </div>
                      <div>
                        <p className="text-xs text-ink-muted mb-1">Total EMI Value</p>
                        <p className="num text-brand-700 font-bold">
                          ₹{(parseFloat(form.emi_amount || '0') * parseInt(form.emi_tenure || '1')).toLocaleString('en-IN')}
                        </p>
                      </div>
                    </div>
                  )}
                </section>
              </>
            )}

            {/* ══════════════ IMAGES TAB ══════════════ */}
            {tab === 'images' && (
              <section>
                <p className="form-section">Document Image URLs</p>
                <div className="alert-info mb-5">
                  <p className="text-info text-sm">
                    ℹ️ All image fields are <strong>optional</strong>. Upload images to{' '}
                    <a href="https://imgbb.com" target="_blank" rel="noopener noreferrer"
                       className="underline font-medium">imgbb.com</a>{' '}
                    and paste the link here. Supports both{' '}
                    <code className="bg-white px-1 rounded text-xs">ibb.co/xxx</code> and{' '}
                    <code className="bg-white px-1 rounded text-xs">i.ibb.co/...</code> formats.
                  </p>
                </div>
                <div className="space-y-6">
                  <ImageURLField label="Customer Photo" field="customer_photo_url"
                    form={form} set={set} errors={errors} />
                  <ImageURLField label="Aadhaar Card — Front" field="aadhaar_front_url"
                    form={form} set={set} errors={errors} />
                  <ImageURLField label="Aadhaar Card — Back" field="aadhaar_back_url"
                    form={form} set={set} errors={errors} />
                  <ImageURLField label="Bill / Invoice Photo" field="bill_photo_url"
                    form={form} set={set} errors={errors} />
                  <ImageURLField label="EMI Card Photo" field="emi_card_photo_url"
                    form={form} set={set} errors={errors} />
                </div>
              </section>
            )}
          </div>

          {/* ── Footer ── */}
          <div className="sticky bottom-0 bg-white border-t border-surface-4 px-6 py-4">
            {/* Tab dot navigation */}
            <div className="flex items-center justify-between">
              <div className="flex gap-2 items-center">
                {tabs.map(t => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setTab(t.key)}
                    className={`transition-all rounded-full ${
                      tab === t.key
                        ? 'w-6 h-2 bg-brand-500'
                        : 'w-2 h-2 bg-surface-4 hover:bg-surface-3'
                    }`}
                    aria-label={t.label}
                  />
                ))}
                <span className="text-xs text-ink-muted ml-2">
                  {tab === 'info' ? 'Step 1 of 3' : tab === 'finance' ? 'Step 2 of 3' : 'Step 3 of 3'}
                </span>
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={onClose} className="btn-secondary">
                  Cancel
                </button>
                {tab !== 'info' && (
                  <button
                    type="button"
                    onClick={() => setTab(tab === 'finance' ? 'info' : 'finance')}
                    className="btn-secondary"
                  >
                    ← Back
                  </button>
                )}
                {tab !== 'images' && (
                  <button
                    type="button"
                    onClick={() => setTab(tab === 'info' ? 'finance' : 'images')}
                    className="btn-ghost border border-surface-4"
                  >
                    Next →
                  </button>
                )}
                {/* Save button ALWAYS visible — validate() auto-switches to failing tab */}
                <button type="submit" disabled={loading} className="btn-primary">
                  {loading ? (
                    <span className="flex items-center gap-2">
                      <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24"
                           fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                        <path d="M12 2a10 10 0 010 20" />
                      </svg>
                      Saving…
                    </span>
                  ) : customer ? '✓ Update Customer' : '✓ Create Customer'}
                </button>
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Reusable text/number/date input ────────────────────────────────────────
function F({
  label, field, form, set, errors,
  type = 'text', required = false, placeholder = '', maxLen, inputMode,
}: {
  label: string;
  field: keyof FormData;
  form: FormData;
  set: (k: keyof FormData, v: string) => void;
  errors: Partial<Record<keyof FormData, string>>;
  type?: string;
  required?: boolean;
  placeholder?: string;
  maxLen?: number;
  inputMode?: React.InputHTMLAttributes<HTMLInputElement>['inputMode'];
}) {
  const hasError = !!errors[field];
  return (
    <div>
      <label className="label">
        {label}
        {required && <span className="text-danger ml-1">*</span>}
      </label>
      <input
        type={type}
        value={form[field] as string}
        onChange={e => set(field, e.target.value)}
        placeholder={placeholder}
        maxLength={maxLen}
        inputMode={inputMode}
        className={`input ${hasError ? 'border-danger focus:border-danger focus:ring-danger/15' : ''}`}
      />
      {hasError && (
        <p className="text-xs text-danger mt-1 flex items-center gap-1">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
          </svg>
          {errors[field]}
        </p>
      )}
    </div>
  );
}

// ── Select field ────────────────────────────────────────────────────────────
function FSelect({
  label, field, form, set, errors, required, disabled, children,
}: {
  label: string;
  field: keyof FormData;
  form: FormData;
  set: (k: keyof FormData, v: string) => void;
  errors: Partial<Record<keyof FormData, string>>;
  required?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const hasError = !!errors[field];
  return (
    <div>
      <label className="label">
        {label}
        {required && <span className="text-danger ml-1">*</span>}
      </label>
      <select
        value={form[field] as string}
        onChange={e => set(field, e.target.value)}
        disabled={disabled}
        className={`input ${hasError ? 'border-danger' : ''}`}
      >
        {children}
      </select>
      {hasError && (
        <p className="text-xs text-danger mt-1">{errors[field]}</p>
      )}
    </div>
  );
}

// ── Image URL input with live preview ──────────────────────────────────────
function ImageURLField({
  label, field, form, set, errors,
}: {
  label: string;
  field: keyof FormData;
  form: FormData;
  set: (k: keyof FormData, v: string) => void;
  errors: Partial<Record<keyof FormData, string>>;
}) {
  const url = form[field] as string;
  const hasError = !!errors[field];

  // Best-effort convert ibb.co view link → direct image URL
  function toDirectUrl(raw: string): string {
    if (!raw) return '';
    if (/i\.ibb\.co|\.jpg|\.jpeg|\.png|\.webp|\.gif/i.test(raw)) return raw;
    const match = raw.match(/ibb\.co\/([A-Za-z0-9]+)/);
    if (match) return `https://i.ibb.co/${match[1]}/img.jpg`;
    return raw;
  }

  const previewUrl = toDirectUrl(url);
  const validFormat = isValidUrl(url);

  return (
    <div>
      <label className="label">
        {label}{' '}
        <span className="text-ink-muted font-normal normal-case tracking-normal">(optional)</span>
      </label>
      <input
        type="url"
        value={url}
        onChange={e => set(field, e.target.value)}
        placeholder="https://i.ibb.co/... or https://ibb.co/..."
        className={`input ${hasError || (url && !validFormat) ? 'border-danger' : ''}`}
      />

      {url && !validFormat && (
        <p className="text-xs text-danger mt-1">⚠ Invalid URL — check the link</p>
      )}
      {hasError && <p className="text-xs text-danger mt-1">{errors[field]}</p>}

      {url && validFormat && (
        <div className="mt-2">
          <img
            src={previewUrl}
            alt={label}
            className="h-28 w-auto rounded-xl object-cover border border-surface-4 shadow-sm"
            onError={e => {
              const img = e.target as HTMLImageElement;
              img.style.display = 'none';
              const fb = img.nextElementSibling as HTMLElement;
              if (fb) fb.style.display = 'flex';
            }}
            onLoad={e => {
              const img = e.target as HTMLImageElement;
              img.style.display = 'block';
              const fb = img.nextElementSibling as HTMLElement;
              if (fb) fb.style.display = 'none';
            }}
          />
          <div className="hidden h-16 rounded-xl border border-surface-4 bg-surface-3 items-center justify-center mt-2">
            <p className="text-xs text-ink-muted">
              Preview unavailable — link saved, image will show on customer page
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
