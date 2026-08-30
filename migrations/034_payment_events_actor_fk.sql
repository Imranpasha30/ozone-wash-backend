-- ═══════════════════════════════════════════════════════════════════════
-- 034_payment_events_actor_fk.sql — fix payment_events.created_by referent
--
-- 033 defined created_by as REFERENCES users(id), but the actor on refund /
-- settle / cancel events is an ADMIN (admin_users), not a users row — same
-- mistake 028 fixed for payment_refunds. The users(id) FK violates on every
-- admin-initiated event (recordEvent is best-effort so it's caught, but the
-- ledger entry is lost + it error-spams). Re-point the FK at admin_users(id).
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE payment_events DROP CONSTRAINT IF EXISTS payment_events_created_by_fkey;

ALTER TABLE payment_events
  ADD CONSTRAINT payment_events_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES admin_users(id) ON DELETE SET NULL;
