# May Stability & Partial Payment Fixes

## Included fixes

- Added partial EMI payment tracking with `PARTIALLY_PAID` EMI status.
- EMI rows now retain paid amount and remaining amount correctly.
- Fine collection now supports paid / partially paid / remaining display.
- Approved payment edit route rewritten to always return JSON and avoid browser `Unexpected end of JSON input` errors.
- Approved payment delete now reverses EMI, fine, and first EMI charge effects.
- If an approved EMI payment is deleted, the EMI no longer stays marked paid.
- Removed legacy database auto-apply triggers that could double-apply payment effects.
- Customer portal, approval edit, and admin actions now use safer JSON parsing on the frontend.
- Improved currency formatting so values display as `₹0`, `₹450`, `₹3,500`.
- Retailer management mobile layout improved with card view instead of cramped table.
- Approval edit modal now shows save/delete success feedback.
- Payment summary and EMI schedule now surface partial EMI and fine states more clearly.

## Required SQL step

Run this migration in Supabase:

- `migrations/014_partial_payment_and_hardening.sql`

## Notes

- If you already applied earlier migrations, this migration is still safe to run.
- This package does not include `node_modules` or build artifacts.
