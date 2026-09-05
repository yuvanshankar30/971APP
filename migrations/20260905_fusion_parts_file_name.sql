-- Fusion documents/G-code were named by concatenating fusion_plates.id and
-- cam_jobs.id (see camPlate.py's `doc_name = f"Plate{plate_id}Job{job_id}"`)
-- - real, but unreadable UUIDs, not something anyone would recognize in
-- Fusion's Data Panel. Lets a Parts-tab user type a short, filesystem-safe
-- name up front instead, threaded through the job payload and used as the
-- saved document's name when present (camPlate.py falls back to the old
-- Plate<id>Job<id> scheme when it's blank).
--
-- Nullable/optional - most existing parts have none, and that's fine.
ALTER TABLE public.fusion_parts
  ADD COLUMN IF NOT EXISTS fusion_file_name text;

-- No spaces (Fusion's Data Panel and the exported G-code path both treat a
-- bare filename token as one word) - enforced here too, not just in the UI,
-- since fusion_parts can be written outside the /autocam/fusion UI (this
-- migration itself, ad-hoc scripts, etc).
ALTER TABLE public.fusion_parts
  ADD CONSTRAINT fusion_parts_fusion_file_name_no_spaces
  CHECK (fusion_file_name IS NULL OR fusion_file_name !~ '\s');
