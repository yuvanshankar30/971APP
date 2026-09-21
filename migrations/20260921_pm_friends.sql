CREATE TABLE IF NOT EXISTS public.pm_friends (
  user_id uuid NOT NULL REFERENCES auth.users(id),
  friend_id uuid NOT NULL REFERENCES auth.users(id),
  status text NOT NULL CHECK (status IN ('pending', 'accepted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, friend_id),
  CHECK (user_id <> friend_id)
);

ALTER TABLE public.pm_friends ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pm_friends TO authenticated;
GRANT ALL ON TABLE public.pm_friends TO service_role;

DROP POLICY IF EXISTS pm_friends_select_authenticated ON public.pm_friends;
CREATE POLICY pm_friends_select_authenticated ON public.pm_friends
  FOR SELECT TO authenticated USING (public.approved_user() AND (auth.uid() = user_id OR auth.uid() = friend_id));

DROP POLICY IF EXISTS pm_friends_insert_authenticated ON public.pm_friends;
CREATE POLICY pm_friends_insert_authenticated ON public.pm_friends
  FOR INSERT TO authenticated WITH CHECK (public.approved_user() AND auth.uid() = user_id);

DROP POLICY IF EXISTS pm_friends_update_authenticated ON public.pm_friends;
CREATE POLICY pm_friends_update_authenticated ON public.pm_friends
  FOR UPDATE TO authenticated USING (public.approved_user() AND (auth.uid() = user_id OR auth.uid() = friend_id))
  WITH CHECK (public.approved_user() AND (auth.uid() = user_id OR auth.uid() = friend_id));

DROP POLICY IF EXISTS pm_friends_delete_authenticated ON public.pm_friends;
CREATE POLICY pm_friends_delete_authenticated ON public.pm_friends
  FOR DELETE TO authenticated USING (public.approved_user() AND (auth.uid() = user_id OR auth.uid() = friend_id));

DROP POLICY IF EXISTS pm_friends_service_all ON public.pm_friends;
CREATE POLICY pm_friends_service_all ON public.pm_friends
  TO service_role USING (true) WITH CHECK (true);
