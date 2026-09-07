-- Query shapes used by the Fusion UI and Runner. These indexes only change
-- lookup cost; they do not alter queue semantics or CAM generation.

CREATE INDEX IF NOT EXISTS idx_cam_jobs_operation_created
  ON public.cam_jobs (operation_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cam_jobs_fusion_queued_created
  ON public.cam_jobs (created_at, id)
  WHERE operation_type = 'milling' AND status = 'queued';

CREATE INDEX IF NOT EXISTS idx_cam_jobs_fusion_active_claimed_at
  ON public.cam_jobs (claimed_at)
  WHERE operation_type = 'milling' AND status IN ('claimed', 'processing');

CREATE INDEX IF NOT EXISTS idx_cam_jobs_fusion_plate_created
  ON public.cam_jobs ((params->>'plateId'), created_at DESC)
  WHERE operation_type = 'milling';

CREATE INDEX IF NOT EXISTS idx_cam_jobs_fusion_box_tube_created
  ON public.cam_jobs ((params->>'boxTubeId'), created_at DESC)
  WHERE operation_type = 'milling';
