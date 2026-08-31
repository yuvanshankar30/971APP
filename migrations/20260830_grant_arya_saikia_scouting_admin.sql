-- Grant Arya Saikia access to the scouting administration tools without
-- changing their global role or granting permissions outside scouting.
DO $$
DECLARE
  target_user_id uuid;
  scouting_lead_key_id uuid;
BEGIN
  SELECT id
    INTO STRICT target_user_id
    FROM public.user_profiles
   WHERE lower(trim(full_name)) = 'arya saikia';

  SELECT rk.id
    INTO scouting_lead_key_id
    FROM public.roster_keys rk
    JOIN public.rosters r ON r.id = rk.roster_id
   WHERE lower(trim(rk.key_name)) = 'scouting lead'
   ORDER BY
     CASE WHEN lower(r.name) LIKE '%scout%' THEN 0 ELSE 1 END,
     rk.created_at,
     rk.id
   LIMIT 1;

  IF scouting_lead_key_id IS NULL THEN
    RAISE EXCEPTION 'No Scouting Lead roster key exists';
  END IF;

  INSERT INTO public.roster_entries (roster_id, user_id, key_id)
  SELECT rk.roster_id, target_user_id, rk.id
    FROM public.roster_keys rk
   WHERE rk.id = scouting_lead_key_id
     AND NOT EXISTS (
       SELECT 1
         FROM public.roster_entries re
        WHERE re.user_id = target_user_id
          AND re.key_id = scouting_lead_key_id
     );
END
$$;
