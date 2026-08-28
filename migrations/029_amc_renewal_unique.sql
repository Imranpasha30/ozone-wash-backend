-- ═══════════════════════════════════════════════════════════════════════
-- 029_amc_renewal_unique.sql — prevent double AMC renewal at the DB level
--
-- createRenewalFor does a non-atomic check (renewed_to_contract_id IS NULL)
-- then create+link. Under concurrent cron runs (multi-instance / overlapping
-- job) two renewals could be created for the same source term. A partial unique
-- index on renewed_from_contract_id makes the second INSERT fail, so a duplicate
-- renewal can never be persisted regardless of concurrency.
-- ═══════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS uq_amc_renewed_from
  ON amc_contracts(renewed_from_contract_id)
  WHERE renewed_from_contract_id IS NOT NULL;
