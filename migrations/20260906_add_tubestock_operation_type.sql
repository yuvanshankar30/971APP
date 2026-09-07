-- Keep the checked operation types aligned with AutoCAM's indexed tube
-- drilling generator. This migration is intentionally idempotent so a
-- partially repaired environment can safely apply it again.
BEGIN;

ALTER TABLE public.cam_machines
  DROP CONSTRAINT IF EXISTS cam_machines_operation_type_check;
ALTER TABLE public.cam_machines
  ADD CONSTRAINT cam_machines_operation_type_check
  CHECK (operation_type IN ('turning', 'routing', 'milling', 'tubestock'));

ALTER TABLE public.cam_jobs
  DROP CONSTRAINT IF EXISTS cam_jobs_operation_type_check;
ALTER TABLE public.cam_jobs
  ADD CONSTRAINT cam_jobs_operation_type_check
  CHECK (operation_type IN ('turning', 'routing', 'milling', 'tubestock'));

NOTIFY pgrst, 'reload schema';
COMMIT;
