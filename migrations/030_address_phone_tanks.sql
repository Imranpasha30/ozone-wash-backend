-- ═══════════════════════════════════════════════════════════════════════
-- 030_address_phone_tanks.sql — saved locations carry a contact PHONE and a
-- reusable TANK SET, so picking a saved location auto-fills the contact phone
-- and the tanks (Zomato-style "saved location" + one-tap reorder of a place).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE customer_addresses
  ADD COLUMN IF NOT EXISTS phone VARCHAR(15),
  ADD COLUMN IF NOT EXISTS tanks JSONB;
