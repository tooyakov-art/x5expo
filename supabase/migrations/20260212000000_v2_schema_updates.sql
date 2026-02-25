-- ==========================================
-- X5 Marketing Expo - V2 Schema Updates
-- Migration: 20260212000000_v2_schema_updates.sql
-- ==========================================
--
-- DASHBOARD SETTINGS REQUIRED (not automatable via migration):
-- 1. Enable Apple OAuth provider:
--    Dashboard -> Authentication -> Providers -> Apple -> Enable
--    Set Service ID, Team ID, Key ID, and private key (.p8)
-- 2. Enable Google OAuth provider:
--    Dashboard -> Authentication -> Providers -> Google -> Enable
--    Set Client ID and Client Secret from Google Cloud Console
-- 3. Enable Anonymous sign-ins:
--    Dashboard -> Authentication -> Settings -> Enable anonymous sign-ins
-- 4. Email auth is already enabled (no change needed)
--

-- ==========================================
-- SECTION 1: New Tables
-- ==========================================

-- 1a. user_drafts — per-user key-value draft storage
CREATE TABLE IF NOT EXISTS user_drafts (
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, key)
);

ALTER TABLE user_drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own drafts"
  ON user_drafts FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 1b. system_config — global configuration key-value store
CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'
);

ALTER TABLE system_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read system config"
  ON system_config FOR SELECT
  USING (auth.role() = 'authenticated');

-- 1c. notification_queue — push notification dispatch queue
CREATE TABLE IF NOT EXISTS notification_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  from_user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  to_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  message_text TEXT NOT NULL,
  sent BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE notification_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own notifications"
  ON notification_queue FOR SELECT
  USING (auth.uid() = to_user_id);

CREATE POLICY "Authenticated users can insert notifications"
  ON notification_queue FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

CREATE INDEX idx_notification_queue_recipient
  ON notification_queue (to_user_id, sent)
  WHERE sent = FALSE;

CREATE INDEX idx_notification_queue_unsent
  ON notification_queue (sent, created_at)
  WHERE sent = FALSE;

-- ==========================================
-- SECTION 2: Alter Existing Tables (New Columns)
-- ==========================================

-- 2a. messages: add media_url, media_mime, role
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS media_url TEXT,
  ADD COLUMN IF NOT EXISTS media_mime TEXT,
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';

-- 2b. tracking_links: add tracking_url, last_click_at
ALTER TABLE tracking_links
  ADD COLUMN IF NOT EXISTS tracking_url TEXT,
  ADD COLUMN IF NOT EXISTS last_click_at TIMESTAMPTZ;

-- ==========================================
-- SECTION 3: RLS Policy Updates
-- ==========================================

-- 3a. profiles: Change SELECT from own-only to all authenticated users
--     (Required for user search, chat participant names, presence)
DROP POLICY IF EXISTS "Users can view own profile" ON profiles;

CREATE POLICY "Authenticated users can view all profiles"
  ON profiles FOR SELECT
  USING (auth.role() = 'authenticated');

-- 3b. specialists: Add ALL policy for owner
--     (Currently only has SELECT for all, missing owner management)
CREATE POLICY "Specialists can manage own record"
  ON specialists FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 3c. tracking_links: Add SELECT for all (including anon)
--     (Required for public redirect/click tracking without auth)
CREATE POLICY "Anyone can view tracking links"
  ON tracking_links FOR SELECT
  USING (TRUE);

-- ==========================================
-- SECTION 4: New RPC Function
-- ==========================================

-- track_click: Increment click count, update last_click_at, return original_url
-- Public access (anon + authenticated) via SECURITY DEFINER
CREATE OR REPLACE FUNCTION track_click(link_short_code TEXT)
RETURNS TEXT AS $$
DECLARE
  result_url TEXT;
BEGIN
  UPDATE tracking_links
  SET
    clicks = clicks + 1,
    last_click_at = NOW()
  WHERE short_code = link_short_code
  RETURNING original_url INTO result_url;

  IF result_url IS NULL THEN
    RAISE EXCEPTION 'Link not found: %', link_short_code;
  END IF;

  RETURN result_url;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION track_click(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION track_click(TEXT) TO authenticated;

-- ==========================================
-- SECTION 5: Extend Realtime Publication
-- ==========================================
-- chats and messages are already in the publication (from init migration)

ALTER PUBLICATION supabase_realtime ADD TABLE profiles;
ALTER PUBLICATION supabase_realtime ADD TABLE courses;
ALTER PUBLICATION supabase_realtime ADD TABLE specialists;
ALTER PUBLICATION supabase_realtime ADD TABLE generation_history;
ALTER PUBLICATION supabase_realtime ADD TABLE tracking_links;
