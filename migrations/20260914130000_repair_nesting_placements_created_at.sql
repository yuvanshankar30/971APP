-- Older live nesting schemas may have lost this default even though the
-- original nesting migration declares it. Keep the write timestamp server-side.
ALTER TABLE public.nesting_placements
  ALTER COLUMN created_at SET DEFAULT now();
