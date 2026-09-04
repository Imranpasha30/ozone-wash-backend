-- 037: Online (PayU) payment support for auto-wash / car-wash.
--
-- Auto-wash was COD-only (jobs created directly, no gateway). Tank cleaning's
-- payment lives on the `bookings` table; auto-wash uses `jobs` (job_type='auto_wash'),
-- which had no payment-state columns. Add them so an auto-wash job can carry an
-- online payment through the same PayU gateway + payment ledger.
--
-- Additive only — tank jobs leave these NULL (their payment stays on bookings).

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS payment_status     varchar(20);  -- pending | paid | cod | failed
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS payment_gateway    varchar(20);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS gateway_order_id   varchar(120); -- PayU txnid / gateway order id
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS gateway_payment_id varchar(120);

-- Settlement (settleByOrderId) looks a job up by its gateway order id.
CREATE INDEX IF NOT EXISTS idx_jobs_gateway_order_id ON jobs (gateway_order_id) WHERE gateway_order_id IS NOT NULL;

-- Let the shared payment ledger reference an auto-wash job (not just a booking/AMC),
-- so car-wash payments show in the admin money-in ledger (which reads `payments`).
ALTER TABLE payments       ADD COLUMN IF NOT EXISTS job_id uuid;
ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS job_id uuid;
