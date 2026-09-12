-- Adds per-view calibration for the hybrid classical-CV game-piece pipeline
-- (see docs/guides/scoutingvision.md's "Hybrid game-piece detection" section). Source:
-- community R&D shared on Chief Delphi ("Computer Vision Scouting",
-- chiefdelphi.com/t/computer-vision-scouting/511642) - a field mask/ROI and
-- goal-zone polygons are how that team excludes audience/background noise
-- and detects when a tracked game piece has actually been scored, rather
-- than just passing through the frame.

ALTER TABLE public.vision_views
  ADD COLUMN IF NOT EXISTS field_mask jsonb,
  ADD COLUMN IF NOT EXISTS goal_zones jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.vision_views.field_mask IS
  'Region-of-interest polygon in normalized (0-1) image coordinates: [[x,y], ...]. Detections outside this polygon (audience, pit area, etc.) are discarded before robot/game-piece detection ever runs. Null means no mask (full frame).';
COMMENT ON COLUMN public.vision_views.goal_zones IS
  'Array of {label, alliance, polygon} in normalized (0-1) image coordinates. A tracked game piece whose trajectory ends inside a goal zone is treated as scored and attributed to the nearest robot track at its trajectory''s starting point.';
