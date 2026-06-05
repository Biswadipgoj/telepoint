import { toNumber } from './formatters';

type Svc = any;

type RequestRow = {
  id: string;
  customer_id: string;
  submitted_by?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  mode?: string | null;
  utr?: string | null;
  fine_amount?: number | null;
  first_emi_charge_amount?: number | null;
  total_emi_amount?: number | null;
  selected_emi_nos?: number[] | null;
  fine_for_emi_no?: number | null;
  /**
   * Per-EMI fine allocation. When present, the reconciler applies each
   * `amount` to the fine_paid_amount of the EMI matching `emi_no`. The
   * legacy single-bucket `fine_amount` is treated as a fallback only.
   * The fine_status of each EMI is independent of its principal_status —
   * paying EMI 2 principal does NOT clear EMI 1 fine.
   */
  fine_breakdown?: Array<{ emi_no: number; amount: number }> | null;
  collected_by_role?: string | null;
  collected_by_user_id?: string | null;
};

type ItemRow = {
  id?: string;
  emi_schedule_id: string;
  emi_no: number;
  amount: number;
};

type EmiRow = {
  id: string;
  customer_id: string;
  emi_no: number;
  amount: number;
  status: string;
  due_date: string;
  paid_at?: string | null;
  mode?: string | null;
  utr?: string | null;
  approved_by?: string | null;
  collected_by_role?: string | null;
  collected_by_user_id?: string | null;
  partial_paid_amount?: number | null;
  partial_paid_at?: string | null;
  fine_amount?: number | null;
  fine_paid_amount?: number | null;
  fine_paid_at?: string | null;
};

export async function resolvePaymentRequestItems(svc: Svc, request: RequestRow): Promise<ItemRow[]> {
  const { data: items } = await svc
    .from('payment_request_items')
    .select('id, emi_schedule_id, emi_no, amount')
    .eq('payment_request_id', request.id)
    .order('emi_no');

  if (items?.length) return items as ItemRow[];
  if (!request.selected_emi_nos?.length) return [];

  const { data: fallbackEmis } = await svc
    .from('emi_schedule')
    .select('id, emi_no')
    .eq('customer_id', request.customer_id)
    .in('emi_no', request.selected_emi_nos)
    .order('emi_no');

  if (!fallbackEmis?.length) return [];
  const eachAmount = toNumber(request.total_emi_amount) / Math.max(fallbackEmis.length, 1);
  const backfill = fallbackEmis.map((e: any) => ({
    payment_request_id: request.id,
    emi_schedule_id: e.id,
    emi_no: e.emi_no,
    amount: eachAmount,
  }));
  await svc.from('payment_request_items').insert(backfill).then(() => null).catch(() => null);
  return backfill.map(({ emi_schedule_id, emi_no, amount }: any) => ({ emi_schedule_id, emi_no, amount }));
}

function computeEmiUpdate(emi: EmiRow, deltaAmount: number, paidAt: string | null, request: RequestRow, actorUserId?: string | null) {
  const currentPartial = toNumber(emi.partial_paid_amount);
  const nextPartial = Math.max(0, Math.min(toNumber(emi.amount), currentPartial + deltaAmount));
  const isFullyPaid = nextPartial >= toNumber(emi.amount) && toNumber(emi.amount) > 0;
  const hasPartial = nextPartial > 0 && !isFullyPaid;

  const update: Record<string, unknown> = {
    partial_paid_amount: nextPartial,
    partial_paid_at: nextPartial > 0 ? (paidAt ?? emi.partial_paid_at ?? new Date().toISOString()) : null,
    updated_at: new Date().toISOString(),
  };

  if (isFullyPaid) {
    update.status = 'APPROVED';
    update.paid_at = paidAt ?? emi.paid_at ?? new Date().toISOString();
    update.mode = request.mode || emi.mode || null;
    update.utr = request.utr ?? emi.utr ?? null;
    update.approved_by = actorUserId || request.approved_by || emi.approved_by || null;
    update.collected_by_role = request.collected_by_role || emi.collected_by_role || 'retailer';
    update.collected_by_user_id = request.collected_by_user_id || request.submitted_by || emi.collected_by_user_id || null;
  } else if (hasPartial) {
    update.status = 'PARTIALLY_PAID';
    update.paid_at = null;
    update.mode = request.mode || emi.mode || null;
    update.utr = request.utr ?? emi.utr ?? null;
    update.approved_by = actorUserId || request.approved_by || emi.approved_by || null;
    update.collected_by_role = request.collected_by_role || emi.collected_by_role || 'retailer';
    update.collected_by_user_id = request.collected_by_user_id || request.submitted_by || emi.collected_by_user_id || null;
  } else {
    update.status = 'UNPAID';
    update.paid_at = null;
    update.mode = null;
    update.utr = null;
    update.approved_by = null;
    update.collected_by_role = null;
    update.collected_by_user_id = null;
  }

  return update;
}

async function applyFineToEmi(svc: Svc, customerId: string, emiNo: number, delta: number, paidAt: string | null, utr?: string | null, mode?: string | null) {
  if (!delta) return;
  const { data: target } = await svc.from('emi_schedule')
    .select('id, fine_paid_amount, fine_paid_at')
    .eq('customer_id', customerId)
    .eq('emi_no', emiNo)
    .maybeSingle();
  if (!target) return;
  const nextPaid = Math.max(0, toNumber(target.fine_paid_amount) + delta);
  await svc.from('emi_schedule').update({
    fine_paid_amount: nextPaid,
    fine_paid_at: nextPaid > 0 ? (paidAt ?? target.fine_paid_at ?? new Date().toISOString()) : null,
  }).eq('id', target.id);

  // Best-effort: stamp / clear the fine's UTR + method (emi_schedule.fine_utr /
  // fine_mode, migrations 019 & 021). Kept as separate, error-tolerant writes so
  // a not-yet-applied migration can never break the core fine_paid_amount /
  // fine_paid_at update above. Only set when currently NULL to mirror the DB
  // function's COALESCE(fine_utr, …) / COALESCE(fine_mode, …).
  try {
    if (nextPaid > 0) {
      if (utr) await svc.from('emi_schedule').update({ fine_utr: utr }).eq('id', target.id).is('fine_utr', null);
    } else {
      await svc.from('emi_schedule').update({ fine_utr: null }).eq('id', target.id);
    }
  } catch { /* fine_utr column may not exist yet — ignore */ }
  try {
    if (nextPaid > 0) {
      if (mode) await svc.from('emi_schedule').update({ fine_mode: mode }).eq('id', target.id).is('fine_mode', null);
    } else {
      await svc.from('emi_schedule').update({ fine_mode: null }).eq('id', target.id);
    }
  } catch { /* fine_mode column may not exist yet — ignore */ }
}

async function adjustFineForRequest(svc: Svc, request: RequestRow, signedTotal: number, paidAt: string | null) {
  // Per-EMI breakdown wins when present. This keeps each EMI's fine_status
  // strictly independent of its principal_status — paying EMI 2 principal
  // does not (and must not) clear EMI 1's fine.
  if (Array.isArray(request.fine_breakdown) && request.fine_breakdown.length > 0) {
    const sign = signedTotal < 0 ? -1 : 1;
    for (const entry of request.fine_breakdown) {
      const amount = toNumber(entry.amount);
      if (amount <= 0) continue;
      await applyFineToEmi(svc, request.customer_id, Number(entry.emi_no), sign * amount, paidAt, request.utr ?? null, request.mode ?? null);
    }
    return;
  }

  if (!signedTotal) return;

  let targetEmiNo = request.fine_for_emi_no ?? null;
  if (!targetEmiNo) {
    const items = await resolvePaymentRequestItems(svc, request);
    if (items.length) targetEmiNo = Math.min(...items.map(i => i.emi_no));
  }
  if (!targetEmiNo) {
    const { data: fallback } = await svc.from('emi_schedule')
      .select('emi_no')
      .eq('customer_id', request.customer_id)
      .order('emi_no')
      .limit(1)
      .maybeSingle();
    targetEmiNo = fallback?.emi_no ?? null;
  }
  if (!targetEmiNo) return;
  await applyFineToEmi(svc, request.customer_id, targetEmiNo, signedTotal, paidAt, request.utr ?? null, request.mode ?? null);
}

async function adjustFirstChargeForRequest(svc: Svc, request: RequestRow, apply: boolean, paidAt: string | null) {
  const charge = toNumber(request.first_emi_charge_amount);
  if (charge <= 0) return;
  if (apply) {
    await svc.from('customers').update({
      first_emi_charge_paid_at: paidAt ?? new Date().toISOString(),
    }).eq('id', request.customer_id);
    return;
  }

  const { count } = await svc.from('payment_requests')
    .select('id', { count: 'exact', head: true })
    .eq('customer_id', request.customer_id)
    .eq('status', 'APPROVED')
    .gt('first_emi_charge_amount', 0)
    .neq('id', request.id);

  if ((count || 0) === 0) {
    await svc.from('customers').update({ first_emi_charge_paid_at: null }).eq('id', request.customer_id);
  }
}

export async function applyApprovedRequestEffects(svc: Svc, request: RequestRow, actorUserId?: string | null, paidAt?: string | null) {
  const when = paidAt ?? request.approved_at ?? new Date().toISOString();
  const items = await resolvePaymentRequestItems(svc, request);
  if (items.length) {
    const emiIds = items.map(i => i.emi_schedule_id);
    const { data: rawEmis } = await svc.from('emi_schedule')
      .select('id, customer_id, emi_no, amount, status, due_date, paid_at, mode, utr, approved_by, collected_by_role, collected_by_user_id, partial_paid_amount, partial_paid_at')
      .in('id', emiIds);
    const emis = (rawEmis || []) as EmiRow[];
    const emiMap = new Map(emis.map((e: EmiRow) => [e.id, e]));
    for (const item of items) {
      const emi = emiMap.get(item.emi_schedule_id);
      if (!emi) continue;
      const update = computeEmiUpdate(emi, toNumber(item.amount), when, request, actorUserId);
      await svc.from('emi_schedule').update(update).eq('id', emi.id);
    }
  }

  await adjustFineForRequest(svc, request, toNumber(request.fine_amount), when);
  await adjustFirstChargeForRequest(svc, request, true, when);
}

export async function reverseApprovedRequestEffects(svc: Svc, request: RequestRow) {
  const items = await resolvePaymentRequestItems(svc, request);
  if (items.length) {
    const emiIds = items.map(i => i.emi_schedule_id);
    const { data: rawEmis } = await svc.from('emi_schedule')
      .select('id, customer_id, emi_no, amount, status, due_date, paid_at, mode, utr, approved_by, collected_by_role, collected_by_user_id, partial_paid_amount, partial_paid_at')
      .in('id', emiIds);
    const emis = (rawEmis || []) as EmiRow[];
    const emiMap = new Map(emis.map((e: EmiRow) => [e.id, e]));
    for (const item of items) {
      const emi = emiMap.get(item.emi_schedule_id);
      if (!emi) continue;
      const update = computeEmiUpdate(emi, -toNumber(item.amount), null, request, null);
      await svc.from('emi_schedule').update(update).eq('id', emi.id);
    }
  }

  await adjustFineForRequest(svc, request, -toNumber(request.fine_amount), null);
  await adjustFirstChargeForRequest(svc, request, false, null);
}

export async function recomputeCustomerCompletion(svc: Svc, customerId: string) {
  // Persist any accrued late fine first so the completion decision below reads
  // a fresh stored fine_amount rather than a stale one (which could otherwise
  // mark a customer COMPLETE while a fine is still outstanding).
  await svc.rpc('recalc_customer_fines', { p_customer_id: customerId }).then(() => null).catch(() => null);

  const { data: customer } = await svc.from('customers')
    .select('id, status, first_emi_charge_amount, first_emi_charge_paid_at')
    .eq('id', customerId)
    .maybeSingle();
  if (!customer) return;

  const { count: openEmiCount } = await svc.from('emi_schedule')
    .select('id', { count: 'exact', head: true })
    .eq('customer_id', customerId)
    .in('status', ['UNPAID', 'PENDING_APPROVAL', 'PARTIALLY_PAID']);

  const { data: fineRows } = await svc.from('emi_schedule')
    .select('fine_amount, fine_paid_amount, fine_waived')
    .eq('customer_id', customerId);
  const finePending = (fineRows || []).some((row: any) => !row.fine_waived && toNumber(row.fine_amount) > toNumber(row.fine_paid_amount));
  const firstChargePending = toNumber(customer.first_emi_charge_amount) > 0 && !customer.first_emi_charge_paid_at;

  if ((openEmiCount || 0) === 0 && !finePending && !firstChargePending) {
    await svc.from('customers').update({ status: 'COMPLETE', completion_date: new Date().toISOString().split('T')[0] }).eq('id', customerId);
  } else if (customer.status === 'COMPLETE') {
    await svc.from('customers').update({ status: 'RUNNING', completion_date: null }).eq('id', customerId);
  }
}
