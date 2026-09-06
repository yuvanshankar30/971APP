-- Scouting Admin is intentionally limited to site administrators plus these
-- three named scouting administrators. Resolve names once to immutable user
-- IDs, then use the dedicated roster key for runtime authorization.
DO $$
DECLARE
  scouting_admin_key_id uuid;
  allowed_user_ids uuid[];
BEGIN
  SELECT rk.id INTO scouting_admin_key_id
  FROM public.roster_keys rk
  WHERE lower(trim(rk.key_name)) = 'scouting admin'
  ORDER BY rk.created_at, rk.id
  LIMIT 1;

  IF scouting_admin_key_id IS NULL THEN
    RAISE EXCEPTION 'No Scouting Admin roster key exists';
  END IF;

  SELECT array_agg(id ORDER BY id) INTO allowed_user_ids
  FROM public.user_profiles
  WHERE lower(trim(full_name)) IN ('arya saikia', 'caden nguyen', 'aarush rajagopalan');

  IF coalesce(array_length(allowed_user_ids, 1), 0) <> 3 THEN
    RAISE EXCEPTION 'Expected exactly one profile each for Arya Saikia, Caden Nguyen, and Aarush Rajagopalan';
  END IF;

  DELETE FROM public.roster_entries re
  USING public.roster_keys rk
  WHERE re.key_id = rk.id
    AND lower(trim(rk.key_name)) = 'scouting admin'
    AND re.user_id <> ALL(allowed_user_ids);

  INSERT INTO public.roster_entries (roster_id, user_id, key_id)
  SELECT rk.roster_id, allowed_user_id, scouting_admin_key_id
  FROM unnest(allowed_user_ids) AS allowed_user_id
  CROSS JOIN public.roster_keys rk
  WHERE rk.id = scouting_admin_key_id
    AND NOT EXISTS (
      SELECT 1 FROM public.roster_entries re
      WHERE re.user_id = allowed_user_id AND re.key_id = scouting_admin_key_id
    );
END
$$;
