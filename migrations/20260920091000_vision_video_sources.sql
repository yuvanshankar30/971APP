CREATE TABLE IF NOT EXISTS public.vision_video_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vision_match_id uuid NOT NULL REFERENCES public.vision_matches(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_id text NOT NULL,
  url text NOT NULL,
  label text,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_only boolean NOT NULL DEFAULT true CHECK (review_only),
  calibrated boolean NOT NULL DEFAULT false CHECK (NOT calibrated),
  saved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vision_match_id, url)
);

ALTER TABLE public.vision_video_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vision_video_sources_authenticated_access ON public.vision_video_sources;
CREATE POLICY vision_video_sources_authenticated_access ON public.vision_video_sources
  TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS vision_video_sources_service_access ON public.vision_video_sources;
CREATE POLICY vision_video_sources_service_access ON public.vision_video_sources
  TO service_role USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vision_video_sources TO authenticated, service_role;
