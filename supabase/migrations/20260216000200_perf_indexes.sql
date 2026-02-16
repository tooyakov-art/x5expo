-- Performance baseline indexes for hot paths.

CREATE INDEX IF NOT EXISTS idx_messages_chat_created_at
  ON public.messages (chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_generation_history_user_created_at
  ON public.generation_history (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_courses_author_public_created_at
  ON public.courses (author_id, is_public, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chats_participants_gin
  ON public.chats USING GIN (participants);

CREATE INDEX IF NOT EXISTS idx_specialists_user_id
  ON public.specialists (user_id);

CREATE INDEX IF NOT EXISTS idx_course_invites_course_active
  ON public.course_invites (course_id, active, created_at DESC);
