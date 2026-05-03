# TelePoint — EMI Management Portal

A full-stack Next.js 14 + Supabase EMI collection and approval portal for retailers and admin.

---

## Setup

### 1. Clone & Install

```bash
git clone <your-repo>
cd <project>
npm install
```

### 2. Environment Variables

Copy `.env.example` to `.env.local` and fill in your Supabase credentials:

```bash
cp .env.example .env.local
```

| Variable | Where to find |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Dashboard → Project Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase Dashboard → Project Settings → API → anon (public) key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → Project Settings → API → service_role key |

> ⚠️ **Never commit `.env.local`** — it is in `.gitignore` by default.

---

### 3. Supabase SQL Setup

Open **Supabase → SQL Editor** and run the appropriate file from `/supabase/`:

| Scenario | File to run |
|---|---|
| Brand new Supabase project | `supabase/fresh_supabase_schema.sql` |
| Existing project with data | `supabase/existing_supabase_upgrade.sql` |

Both files are **idempotent** — safe to run multiple times.

After running, update the seed admin email at the bottom of the SQL:

```sql
INSERT INTO profiles (user_id, role)
SELECT id, 'super_admin' FROM auth.users
WHERE email = 'your-admin@email.com'   -- ← change this
ON CONFLICT (user_id) DO UPDATE SET role = 'super_admin';
```

---

### 4. Local Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## Vercel Deployment

1. Push repo to GitHub
2. Import project in [vercel.com](https://vercel.com)
3. Set environment variables in **Vercel → Project → Settings → Environment Variables**
4. Deploy — Vercel auto-detects Next.js, no extra config needed
5. Leave **Output Directory** blank (default)

---

## Roles

| Role | Access |
|---|---|
| `super_admin` | All customers, all retailers, approve/reject payments, reports, edit any EMI |
| `retailer` | Own customers only, submit payment requests, view own reports |

---

## Payment Flow

```
Retailer collects → submits request (status: PENDING)
    ↓
Super Admin reviews → Approve or Reject
    ↓
On Approve: EMI marked APPROVED, fine/charge updated, customer auto-COMPLETE if all paid
On Reject:  EMI reverted to UNPAID/PARTIALLY_PAID, request archived
```

Retailers must follow sequential order: EMI 1 → EMI 2 → EMI 3. Super Admin can bypass.

---

## Test Checklist

- [ ] Login as admin → redirects to `/admin`
- [ ] Login as retailer → redirects to `/retailer`
- [ ] Retailer search returns only own customers
- [ ] Payment modal shows loan summary on mobile
- [ ] UPI mode: UTR field appears immediately, is required
- [ ] Cash mode: UTR field hidden, not required
- [ ] Submit payment → status PENDING in admin approvals queue
- [ ] Admin approves → EMI status flips to APPROVED
- [ ] Admin rejects → EMI reverts to UNPAID
- [ ] Monthly collection CSV downloads with correct fine (outstanding only)
- [ ] Monthly collection CSV scoped: retailer sees only own data
- [ ] EMI edit (admin): "Save" actually persists to DB
- [ ] No infinite loop / client-side application error on page load
- [ ] Mobile: Record Payment button always visible above safe area

---

## Key Files

| Path | Purpose |
|---|---|
| `app/retailer/page.tsx` | Retailer dashboard |
| `app/admin/page.tsx` | Admin dashboard |
| `app/admin/approvals/page.tsx` | Payment approval queue |
| `components/PaymentModal.tsx` | Payment collection modal |
| `components/EMIScheduleTable.tsx` | EMI schedule display + admin edit |
| `app/api/payments/submit/route.ts` | Retailer submits payment |
| `app/api/admin/approve-request/route.ts` | Admin approves (uses atomic RPC) |
| `app/api/report/monthly/route.ts` | Monthly collection CSV |
| `lib/fineCalc.ts` | Fine calculation logic |
| `lib/paymentReconcile.ts` | Payment approval side-effects |
| `supabase/fresh_supabase_schema.sql` | Full schema for new DB |
| `supabase/existing_supabase_upgrade.sql` | Safe upgrade for existing DB |
