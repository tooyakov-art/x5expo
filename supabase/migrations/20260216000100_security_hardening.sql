-- Security hardening for RPC/RLS policies.

-- 1) Profiles least-privilege read policies.
DROP POLICY IF EXISTS "Authenticated users can view all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can view specialist profiles" ON public.profiles;
DROP POLICY IF EXISTS "Users can view chat participant profiles" ON public.profiles;

CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can view specialist profiles"
  ON public.profiles FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1
      FROM public.specialists s
      WHERE s.user_id = profiles.id
    )
  );

CREATE POLICY "Users can view chat participant profiles"
  ON public.profiles FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1
      FROM public.chats c
      WHERE auth.uid()::text = ANY(c.participants)
        AND profiles.id::text = ANY(c.participants)
    )
  );

-- 2) Harden credits RPCs (owner-or-service-role only, fixed search_path).
CREATE OR REPLACE FUNCTION public.deduct_credits(user_id UUID, cost INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  actor UUID := auth.uid();
  current_credits INTEGER;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'auth_required';
  END IF;

  IF cost IS NULL OR cost <= 0 THEN
    RAISE EXCEPTION 'invalid_cost';
  END IF;

  IF actor <> user_id AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT credits INTO current_credits
  FROM public.profiles
  WHERE id = user_id
  FOR UPDATE;

  IF current_credits IS NULL THEN
    RAISE EXCEPTION 'user_not_found';
  END IF;

  IF current_credits < cost THEN
    RAISE EXCEPTION 'insufficient_credits';
  END IF;

  UPDATE public.profiles
  SET credits = credits - cost
  WHERE id = user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.add_credits(user_id UUID, amount INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  actor UUID := auth.uid();
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'auth_required';
  END IF;

  IF amount IS NULL OR amount <= 0 THEN
    RAISE EXCEPTION 'invalid_amount';
  END IF;

  IF actor <> user_id AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  UPDATE public.profiles
  SET credits = credits + amount
  WHERE id = user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.deduct_credits(UUID, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.deduct_credits(UUID, INTEGER) FROM anon;
REVOKE EXECUTE ON FUNCTION public.add_credits(UUID, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.add_credits(UUID, INTEGER) FROM anon;

GRANT EXECUTE ON FUNCTION public.deduct_credits(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_credits(UUID, INTEGER) TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.deduct_credits(UUID, INTEGER) TO service_role;
    GRANT EXECUTE ON FUNCTION public.add_credits(UUID, INTEGER) TO service_role;
  END IF;
END;
$$;

-- 3) Harden public link tracking RPC search_path and grants.
CREATE OR REPLACE FUNCTION public.track_click(link_short_code TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  result_url TEXT;
BEGIN
  UPDATE public.tracking_links
  SET
    clicks = clicks + 1,
    last_click_at = NOW()
  WHERE short_code = link_short_code
  RETURNING original_url INTO result_url;

  IF result_url IS NULL THEN
    RAISE EXCEPTION 'link_not_found';
  END IF;

  RETURN result_url;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.track_click(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.track_click(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.track_click(TEXT) TO authenticated;
