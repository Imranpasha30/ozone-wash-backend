-- ═══════════════════════════════════════════════════════════════════════
-- 028_fix_refund_actor_fk.sql — fix payment_refunds.created_by referent
--
-- 026 defined created_by as REFERENCES users(id), but admins live in the
-- separate admin_users table (migration 012 / 013 removed 'admin' from users).
-- The refund endpoint is admin-only, so created_by is always an admin_users.id
-- — the users(id) FK would violate and 500 on every real admin refund.
-- Re-point the FK at admin_users(id).
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE payment_refunds DROP CONSTRAINT IF EXISTS payment_refunds_created_by_fkey;

ALTER TABLE payment_refunds
  ADD CONSTRAINT payment_refunds_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES admin_users(id) ON DELETE SET NULL;
