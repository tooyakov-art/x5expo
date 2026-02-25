-- ==========================================
-- X5 Marketing Expo - Supabase Setup
-- ==========================================

-- 1. Profiles table
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'User',
  nickname TEXT,
  email TEXT,
  avatar TEXT,
  bio TEXT,
  services TEXT[],
  is_guest BOOLEAN DEFAULT FALSE,
  is_company BOOLEAN DEFAULT FALSE,
  company_name TEXT,
  plan TEXT DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'black')),
  credits INTEGER DEFAULT 50,
  purchased_course_ids TEXT[],
  subscription_date TIMESTAMPTZ,
  subscription_end_date TIMESTAMPTZ,
  subscription_type TEXT CHECK (subscription_type IN ('monthly', 'yearly')),
  push_token TEXT,
  last_seen TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
CREATE POLICY "Users can view own profile" ON profiles FOR SELECT USING (auth.uid() = id);
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);
DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;
CREATE POLICY "Users can insert own profile" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- 2. Courses table
CREATE TABLE IF NOT EXISTS courses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID REFERENCES profiles(id),
  author_name TEXT,
  title TEXT NOT NULL,
  marketing_hook TEXT,
  description TEXT,
  cover_url TEXT,
  price INTEGER DEFAULT 0,
  categories JSONB DEFAULT '[]',
  ratings JSONB DEFAULT '[]',
  average_rating REAL DEFAULT 0,
  students_count INTEGER DEFAULT 0,
  participants JSONB DEFAULT '[]',
  is_free BOOLEAN DEFAULT FALSE,
  is_public BOOLEAN DEFAULT TRUE,
  course_language TEXT DEFAULT 'ru',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE courses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public courses visible to all" ON courses;
CREATE POLICY "Public courses visible to all" ON courses FOR SELECT USING (is_public = TRUE);
DROP POLICY IF EXISTS "Authors can manage own courses" ON courses;
CREATE POLICY "Authors can manage own courses" ON courses FOR ALL USING (auth.uid() = author_id);

-- 3. Specialists table
CREATE TABLE IF NOT EXISTS specialists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id),
  name TEXT NOT NULL,
  role TEXT,
  avatar TEXT,
  rating REAL DEFAULT 5.0,
  price TEXT,
  skills TEXT[],
  online BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE specialists ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Specialists visible to all" ON specialists;
CREATE POLICY "Specialists visible to all" ON specialists FOR SELECT USING (TRUE);

-- 4. Chats table
CREATE TABLE IF NOT EXISTS chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participants TEXT[] NOT NULL,
  participant_names JSONB DEFAULT '{}',
  last_message TEXT,
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  unread_count JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE chats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own chats" ON chats;
CREATE POLICY "Users can view own chats" ON chats FOR SELECT USING (auth.uid()::TEXT = ANY(participants));
DROP POLICY IF EXISTS "Users can insert chats" ON chats;
CREATE POLICY "Users can insert chats" ON chats FOR INSERT WITH CHECK (auth.uid()::TEXT = ANY(participants));
DROP POLICY IF EXISTS "Users can update own chats" ON chats;
CREATE POLICY "Users can update own chats" ON chats FOR UPDATE USING (auth.uid()::TEXT = ANY(participants));

-- 5. Messages table
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL,
  content TEXT,
  type TEXT DEFAULT 'text',
  media_urls TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Chat participants can view messages" ON messages;
CREATE POLICY "Chat participants can view messages" ON messages FOR SELECT
  USING (EXISTS (SELECT 1 FROM chats WHERE chats.id = messages.chat_id AND auth.uid()::TEXT = ANY(chats.participants)));
DROP POLICY IF EXISTS "Chat participants can insert messages" ON messages;
CREATE POLICY "Chat participants can insert messages" ON messages FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM chats WHERE chats.id = messages.chat_id AND auth.uid()::TEXT = ANY(chats.participants)));

-- 6. Tracking links table
CREATE TABLE IF NOT EXISTS tracking_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id),
  platform TEXT NOT NULL,
  original_url TEXT NOT NULL,
  short_code TEXT UNIQUE NOT NULL,
  clicks INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE tracking_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own links" ON tracking_links;
CREATE POLICY "Users can manage own links" ON tracking_links FOR ALL USING (auth.uid() = user_id);

-- 7. WhatsApp bots table
CREATE TABLE IF NOT EXISTS whatsapp_bots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id),
  bot_name TEXT NOT NULL,
  greeting TEXT,
  rules JSONB DEFAULT '[]',
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE whatsapp_bots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own bots" ON whatsapp_bots;
CREATE POLICY "Users can manage own bots" ON whatsapp_bots FOR ALL USING (auth.uid() = user_id);

-- 8. Generation history table
CREATE TABLE IF NOT EXISTS generation_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id),
  type TEXT NOT NULL,
  prompt TEXT,
  content TEXT,
  image_url TEXT,
  mode TEXT,
  aspect_ratio TEXT,
  design_type TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE generation_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own history" ON generation_history;
CREATE POLICY "Users can manage own history" ON generation_history FOR ALL USING (auth.uid() = user_id);

-- 9. Course invites table
CREATE TABLE IF NOT EXISTS course_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
  code TEXT UNIQUE NOT NULL,
  type TEXT DEFAULT 'public',
  max_uses INTEGER,
  used_count INTEGER DEFAULT 0,
  used_by TEXT[] DEFAULT '{}',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES profiles(id),
  active BOOLEAN DEFAULT TRUE
);

ALTER TABLE course_invites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Active invites visible to all" ON course_invites;
CREATE POLICY "Active invites visible to all" ON course_invites FOR SELECT USING (active = TRUE);
DROP POLICY IF EXISTS "Authors can manage invites" ON course_invites;
CREATE POLICY "Authors can manage invites" ON course_invites FOR ALL USING (auth.uid() = created_by);

-- ==========================================
-- RPC Functions for atomic credit operations
-- ==========================================

CREATE OR REPLACE FUNCTION deduct_credits(user_id UUID, cost INTEGER)
RETURNS VOID AS $$
DECLARE
  current_credits INTEGER;
BEGIN
  SELECT credits INTO current_credits FROM profiles WHERE id = user_id FOR UPDATE;
  IF current_credits IS NULL THEN
    RAISE EXCEPTION 'User not found';
  END IF;
  IF current_credits < cost THEN
    RAISE EXCEPTION 'Insufficient credits: have %, need %', current_credits, cost;
  END IF;
  UPDATE profiles SET credits = credits - cost WHERE id = user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION add_credits(user_id UUID, amount INTEGER)
RETURNS VOID AS $$
BEGIN
  UPDATE profiles SET credits = credits + amount WHERE id = user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==========================================
-- Enable Realtime for chats and messages
-- ==========================================
ALTER PUBLICATION supabase_realtime ADD TABLE chats;
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
