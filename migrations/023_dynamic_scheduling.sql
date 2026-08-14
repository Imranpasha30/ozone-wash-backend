-- ──────────────────────────────────────────────────────────────────────────
-- 023_dynamic_scheduling.sql
-- Dynamic, capacity-aware slot engine:
--   • jobs/bookings carry their computed service duration (clean time per
--     tank by size + travel buffer between distinct locations)
--   • admin-configurable scheduling settings (fleet size, per-size cleaning
--     minutes, travel buffer, workday window, slot step)
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE jobs     ADD COLUMN IF NOT EXISTS duration_min INT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS duration_min INT;

INSERT INTO app_settings (key, value) VALUES
  ('scheduling', '{
     "vans": 2,
     "travel_buffer_min": 45,
     "workday_start": "08:00",
     "workday_end": "18:00",
     "slot_step_min": 30,
     "clean_minutes_by_tier": {
       "1": 60,  "2": 90,  "3": 120, "4": 150,
       "5": 180, "6": 210, "7": 240, "8": 300
     }
   }'::jsonb)
ON CONFLICT (key) DO NOTHING;
