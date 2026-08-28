-- ═══════════════════════════════════════════════════════════════════════
-- 027_amc_auto_renew.sql — AMC auto-renewal support
--
-- The daily cron already SENDS renewal reminders (cron.service.checkAmcRenewals).
-- This adds the state needed to (a) auto-create a payable renewal contract as a
-- term ends, (b) expire contracts past end_date, and (c) chain a contract to
-- its renewal for a clean audit trail.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE amc_contracts
  ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE amc_contracts
  ADD COLUMN IF NOT EXISTS renewed_from_contract_id UUID REFERENCES amc_contracts(id) ON DELETE SET NULL;

ALTER TABLE amc_contracts
  ADD COLUMN IF NOT EXISTS renewed_to_contract_id UUID REFERENCES amc_contracts(id) ON DELETE SET NULL;

-- Fast lookup for the renewal cron (active contracts nearing/ past end_date).
CREATE INDEX IF NOT EXISTS idx_amc_end_status ON amc_contracts(status, end_date);
