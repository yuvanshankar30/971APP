-- Keep the observation vocabulary explicit while allowing review-only
-- collision and shot candidates produced by the current runner.
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT con.conname
    INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace ns ON ns.oid = rel.relnamespace
  WHERE ns.nspname = 'public'
    AND rel.relname = 'vision_observations'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%observation_type%'
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.vision_observations DROP CONSTRAINT %I', constraint_name);
  END IF;

  ALTER TABLE public.vision_observations
    ADD CONSTRAINT vision_observations_observation_type_check
    CHECK (observation_type IN (
      'fuel_attempt', 'fuel_scored', 'fuel_shot',
      'climb_attempt', 'climb_success', 'mobility',
      'disabled', 'identity', 'collision'
    ));
END $$;
