/**
 * EMI PENALTY SYSTEM — Complete Business Logic
 *
 * RULES:
 * 1. Base Fine: ₹450 applied ONCE the day after EMI due date
 * 2. No Duplicate: Same EMI never gets another ₹450 (except last EMI)
 * 3. 30-Day Grace: No weekly penalty for 30 days after fine applied
 * 4. Weekly ₹25: Starts after grace, continues until fine fully paid
 * 5. EMI Paid, Fine Unpaid: Fine stays active, weekly keeps accumulating
 * 6. LAST EMI: ₹450 repeats every 30 days. ZERO weekly charge ever.
 *    Even after last EMI is paid, if fine unpaid → still no weekly.
 * 7. Multiple EMIs: Each calculated independently
 *
 * EXAMPLES (Normal EMI #3, due 4 March):
 *   5 Mar (1d)   → ₹450   base fine
 *   4 Apr (31d)  → ₹450   still in grace (30 days)
 *   5 Apr (32d)  → ₹450   grace just ended, 0 full weeks
 *   12 Apr (39d) → ₹475   1 week past grace
 *   19 Apr (46d) → ₹500   2 weeks
 *   26 Apr (53d) → ₹525   3 weeks
 *   3 May (60d)  → ₹550   4 weeks
 *   Customer pays EMI on 10 Apr but NOT fine:
 *     Fine stays at ₹475 on 12 Apr, ₹500 on 19 Apr... keeps growing
 *
 * EXAMPLES (LAST EMI #6, due 4 March):
 *   5 Mar (1d)   → ₹450   first base
 *   4 Apr (31d)  → ₹900   second ₹450 (30-day repeat)
 *   4 May (61d)  → ₹1350  third ₹450
 *   NO WEEKLY EVER on last EMI — even if EMI paid but fine unpaid
 */

import { EMISchedule } from './types';

const BASE = 450;
const WEEKLY = 25;
const GRACE = 30;

export function calculateSingleEmiFine(
  dueDate: string,
  isLastEmi: boolean = false,
  baseFine: number = BASE,
  weeklyIncrement: number = WEEKLY,
): number {
  const due = new Date(dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  if (today <= due) return 0;

  const days = Math.floor((today.getTime() - due.getTime()) / 86400000);
  if (days <= 0) return 0;

  if (isLastEmi) {
    // LAST EMI: ₹450 repeats every 30 days. ZERO weekly. Ever.
    const blocks = Math.ceil(days / GRACE);
    return blocks * baseFine;
  }

  // Normal EMI: ₹450 base → 30-day grace → then ₹25/week
  if (days <= GRACE) return baseFine;
  const weeks = Math.floor((days - GRACE) / 7);
  return baseFine + (weeks * weeklyIncrement);
}

export function calculateTotalFineFromEmis(
  emis: EMISchedule[],
  baseFine: number = BASE,
  weeklyIncrement: number = WEEKLY,
): number {
  let total = 0;
  // Last EMI number — does NOT depend on payment status
  const maxEmiNo = emis.length > 0 ? Math.max(...emis.map(e => e.emi_no)) : 0;

  for (const emi of emis) {
    if (emi.fine_waived) continue;

    const isOverdueUnpaid = ['UNPAID', 'PARTIALLY_PAID'].includes(emi.status) && new Date(emi.due_date) < new Date();
    const hasFineUnpaid = (emi.fine_amount || 0) > 0 &&
                          (emi.fine_paid_amount || 0) < (emi.fine_amount || 0);

    // Skip if neither overdue nor has unpaid fine
    if (!isOverdueUnpaid && !hasFineUnpaid) continue;

    // CRITICAL: isLastEmi is based on emi_no position, NOT payment status
    // Even if last EMI was paid, if fine is unpaid → still "last EMI" rules (no weekly)
    const isLast = emi.emi_no === maxEmiNo;

    const calc = calculateSingleEmiFine(emi.due_date, isLast, baseFine, weeklyIncrement);
    const effective = Math.max(calc, emi.fine_amount || 0);
    const paid = emi.fine_paid_amount || 0;
    total += Math.max(0, effective - paid);
  }
  return total;
}

export function getPerEmiFineBreakdown(
  emis: EMISchedule[],
  baseFine: number = BASE,
  weeklyIncrement: number = WEEKLY,
) {
  const maxEmiNo = emis.length > 0 ? Math.max(...emis.map(e => e.emi_no)) : 0;

  const result: Array<{
    emi_no: number; due_date: string; days: number; isLastEmi: boolean;
    baseFineTotal: number; weeklyFine: number; graceEnds: string;
    totalFine: number; paid: number; remaining: number;
  }> = [];

  for (const emi of emis) {
    if (emi.fine_waived) continue;

    const isOverdueUnpaid = ['UNPAID', 'PARTIALLY_PAID'].includes(emi.status) && new Date(emi.due_date) < new Date();
    const hasFineUnpaid = (emi.fine_amount || 0) > 0 &&
                          (emi.fine_paid_amount || 0) < (emi.fine_amount || 0);
    if (!isOverdueUnpaid && !hasFineUnpaid) continue;

    const due = new Date(emi.due_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    due.setHours(0, 0, 0, 0);
    const days = Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86400000));

    const graceEnd = new Date(due);
    graceEnd.setDate(graceEnd.getDate() + GRACE);

    // isLastEmi based on position, not payment status
    const isLast = emi.emi_no === maxEmiNo;

    const calc = calculateSingleEmiFine(emi.due_date, isLast, baseFine, weeklyIncrement);
    const effective = Math.max(calc, emi.fine_amount || 0);
    const paid = emi.fine_paid_amount || 0;

    const baseFineTotal = isLast ? Math.ceil(Math.max(1, days) / GRACE) * baseFine : baseFine;
    const weeklyFine = (!isLast && days > GRACE)
      ? Math.floor((days - GRACE) / 7) * weeklyIncrement
      : 0; // Last EMI: ALWAYS 0 weekly

    result.push({
      emi_no: emi.emi_no,
      due_date: emi.due_date,
      days,
      isLastEmi: isLast,
      baseFineTotal,
      weeklyFine,
      graceEnds: graceEnd.toISOString().split('T')[0],
      totalFine: effective,
      paid,
      remaining: Math.max(0, effective - paid),
    });
  }
  return result;
}
