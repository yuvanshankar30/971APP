-- Bring databases that stopped before 20260405_planner_item_merge.sql forward
-- without requiring the original destructive migration to be re-run.
ALTER TABLE public.planner_items
  ADD COLUMN IF NOT EXISTS item_type text,
  ADD COLUMN IF NOT EXISTS details text,
  ADD COLUMN IF NOT EXISTS work_category text,
  ADD COLUMN IF NOT EXISTS scope text,
  ADD COLUMN IF NOT EXISTS general_type text,
  ADD COLUMN IF NOT EXISTS subsystem_id uuid,
  ADD COLUMN IF NOT EXISTS needs_manufacturing boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS attachment_path text,
  ADD COLUMN IF NOT EXISTS attachment_name text,
  ADD COLUMN IF NOT EXISTS attachment_uploaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_completed_from_parts boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS state_before_auto_complete text;

UPDATE public.planner_items
SET details = notes
WHERE details IS NULL AND notes IS NOT NULL;

UPDATE public.planner_items
SET work_category = CASE WHEN category IN ('assembly', 'electrical', 'software', 'manufacturing', 'cad') THEN category ELSE NULL END
WHERE work_category IS NULL;

UPDATE public.planner_items
SET item_type = CASE WHEN kind = 'milestone' THEN 'milestone' ELSE 'task' END
WHERE item_type IS NULL;

ALTER TABLE public.planner_items ALTER COLUMN item_type SET DEFAULT 'task';
ALTER TABLE public.planner_items ALTER COLUMN item_type SET NOT NULL;

CREATE TABLE IF NOT EXISTS public.planner_item_people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  frc_team text NOT NULL,
  planner_item_id uuid NOT NULL REFERENCES public.planner_items(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (planner_item_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_planner_item_people_item ON public.planner_item_people (planner_item_id);
CREATE INDEX IF NOT EXISTS idx_planner_item_people_user ON public.planner_item_people (user_id);

INSERT INTO public.planner_item_people (frc_team, planner_item_id, user_id, created_at)
SELECT frc_team, planner_item_id, user_id, created_at
FROM public.planner_item_owners
ON CONFLICT (planner_item_id, user_id) DO NOTHING;

ALTER TABLE public.planner_item_people ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS planner_item_people_service_all ON public.planner_item_people;
CREATE POLICY planner_item_people_service_all ON public.planner_item_people
  TO service_role USING (true) WITH CHECK (true);
