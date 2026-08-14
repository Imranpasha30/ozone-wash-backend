-- ── In-app notification feed ────────────────────────────────────────────────
-- Server-side inbox backing the app/web Notifications screen. Every customer-
-- facing push also lands here so web users (no FCM) still get the feed.
-- "Read" rows are hidden from the list (the screen shows unread only) and
-- swept after 30 days by the daily cron.

CREATE TABLE IF NOT EXISTS in_app_notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      VARCHAR(200) NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  read       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_iann_user_unread
  ON in_app_notifications (user_id, created_at DESC)
  WHERE NOT read;
