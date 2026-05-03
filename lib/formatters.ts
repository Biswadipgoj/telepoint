// ── IST timezone offset (UTC+5:30)
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function toNumber(value: unknown, fallback = 0): number {
  const num = Number(value ?? fallback);
  return Number.isFinite(num) ? num : fallback;
}

export function formatCurrency(value: unknown): string {
  const num = toNumber(value, 0);
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(num).replace(/\s+/g, '');
}

/** Format a date string (YYYY-MM-DD or ISO) as DD Mon YYYY in IST */
export function formatDateOnly(value?: string | null): string {
  if (!value) return '-';
  try {
    // For date-only strings (no time), parse as local date to avoid UTC-shift
    const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const d = isDateOnly ? new Date(value + 'T00:00:00') : new Date(value);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
    });
  } catch { return '-'; }
}

/** Format an ISO timestamp as "DD Mon YYYY, h:mm AM/PM IST" */
export function formatDateTime(value?: string | null): string {
  if (!value) return '-';
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
      timeZone: 'Asia/Kolkata',
    }) + ' IST';
  } catch { return '-'; }
}

/** Format timestamp for compact EMI schedule display: "12MAR26 05:40PM" */
export function formatDateTimeCompact(value?: string | null): string {
  if (!value) return '-';
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '-';
    const ist = new Date(d.getTime() + IST_OFFSET_MS);
    const day   = String(ist.getUTCDate()).padStart(2, '0');
    const month = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][ist.getUTCMonth()];
    const yr    = String(ist.getUTCFullYear()).slice(-2);
    let hours   = ist.getUTCHours();
    const ampm  = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    const mins  = String(ist.getUTCMinutes()).padStart(2, '0');
    return `${day}${month}${yr} ${String(hours).padStart(2,'0')}:${mins}${ampm}`;
  } catch { return '-'; }
}

export async function readJsonSafe<T = Record<string, unknown>>(res: Response): Promise<T | null> {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text) as T; }
  catch { return { error: text.slice(0, 300) || 'Unexpected server response' } as T; }
}

export function toDateTimeLocalInput(value?: string | null): string {
  if (!value) return '';
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    // Convert UTC → IST for display in datetime-local input
    const ist = new Date(d.getTime() + IST_OFFSET_MS);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth()+1)}-${pad(ist.getUTCDate())}T${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}`;
  } catch { return ''; }
}

export function fromDateTimeLocalInput(value?: string | null): string | null {
  if (!value) return null;
  try {
    // Treat input as IST, convert to UTC for storage
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    // Adjust: value is local browser time which should match IST if set up correctly
    return new Date(d.getTime() - IST_OFFSET_MS).toISOString();
  } catch { return null; }
}

/** Get today's date string in YYYY-MM-DD format (IST) */
export function todayIST(): string {
  const now = new Date(Date.now() + IST_OFFSET_MS);
  const yr  = now.getUTCFullYear();
  const mo  = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dy  = String(now.getUTCDate()).padStart(2, '0');
  return `${yr}-${mo}-${dy}`;
}
