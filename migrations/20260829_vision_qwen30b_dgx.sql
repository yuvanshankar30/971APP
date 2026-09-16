-- Vision-language inference metadata and mandatory observation review. The
-- migration filename is historical; the active DGX model is Qwen3-VL-30B-A3B-Instruct.
-- Qwen runs on the DGX Spark as an authenticated internal service; the web
-- app stores only model identity, runtime metrics, and reviewable evidence.

ALTER TABLE public.vision_runs
  ADD COLUMN IF NOT EXISTS qwen_model text,
  ADD COLUMN IF NOT EXISTS qwen_revision text,
  ADD COLUMN IF NOT EXISTS qwen_dtype text,
  ADD COLUMN IF NOT EXISTS runtime_metrics jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.vision_observations
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'unreviewed',
  ADD COLUMN IF NOT EXISTS reviewer_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vision_observations_review_status_check'
  ) THEN
    ALTER TABLE public.vision_observations
      ADD CONSTRAINT vision_observations_review_status_check
      CHECK (review_status IN ('unreviewed','accepted','corrected','rejected','unobservable'));
  END IF;
END $$;

ALTER TABLE public.vision_runners
  ADD COLUMN IF NOT EXISTS qwen_model text,
  ADD COLUMN IF NOT EXISTS qwen_endpoint text,
  ADD COLUMN IF NOT EXISTS runtime_metrics jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.vision_qwen_clips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vision_run_id uuid NOT NULL REFERENCES public.vision_runs(id) ON DELETE CASCADE,
  view_id uuid REFERENCES public.vision_views(id) ON DELETE SET NULL,
  started_ms integer NOT NULL,
  ended_ms integer NOT NULL,
  model text NOT NULL,
  revision text NOT NULL,
  dtype text NOT NULL DEFAULT 'bfloat16',
  latency_ms integer,
  clip_quality text CHECK (clip_quality IS NULL OR clip_quality IN ('good','limited','unusable')),
  event_count integer NOT NULL DEFAULT 0,
  normalized_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_response text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vision_run_id, view_id, started_ms, ended_ms, model, revision)
);

ALTER TABLE public.vision_qwen_clips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vision_qwen_clips_authenticated ON public.vision_qwen_clips;
CREATE POLICY vision_qwen_clips_authenticated ON public.vision_qwen_clips
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS vision_qwen_clips_service ON public.vision_qwen_clips;
CREATE POLICY vision_qwen_clips_service ON public.vision_qwen_clips
  TO service_role USING (true) WITH CHECK (true);
REVOKE INSERT, UPDATE, DELETE ON public.vision_qwen_clips FROM authenticated;
GRANT SELECT ON public.vision_qwen_clips TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vision_qwen_clips TO service_role;

CREATE INDEX IF NOT EXISTS vision_observations_review_idx
  ON public.vision_observations(vision_run_id, review_status, source);
CREATE INDEX IF NOT EXISTS vision_qwen_clips_run_idx
  ON public.vision_qwen_clips(vision_run_id, view_id, started_ms);

COMMENT ON COLUMN public.vision_observations.review_status IS
  'Model observations are advisory. Only accepted/corrected rows may enter released scouting summaries.';
