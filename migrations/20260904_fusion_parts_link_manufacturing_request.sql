-- Fusion CAM (autocam/fusion/, the Fusion-360-backed milling pipeline) had
-- no connection at all to this app's own manufacturing-request pipeline
-- (public.parts) - a fusion_parts/fusion_box_tubes row was just a named
-- quantity of stock, with nothing tracing it back to which real request it
-- was for. Optional (nullable) on purpose: not every Fusion CAM part is for
-- an existing request (e.g. ad-hoc prototyping/kitting stock), so this adds
-- a link without requiring one.
--
-- The UI stays separate for now (per direct instruction - /autocam/fusion
-- keeps its own Parts/Plates/Box Tubes tabs rather than folding into the
-- main /autocam "New Job" flow yet); this is the data-level connection that
-- makes a later UI merge possible without a schema change at that point.

-- public.parts.id is bigint, not uuid (unlike most other tables in this
-- app) - this migration originally declared part_id as uuid and failed
-- outright with a "42804 incompatible types" error the first time it was
-- actually run. Fixed to match the real column type.
ALTER TABLE public.fusion_parts
  ADD COLUMN IF NOT EXISTS part_id bigint REFERENCES public.parts(id) ON DELETE SET NULL;

ALTER TABLE public.fusion_box_tubes
  ADD COLUMN IF NOT EXISTS part_id bigint REFERENCES public.parts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_fusion_parts_part_id ON public.fusion_parts(part_id);
CREATE INDEX IF NOT EXISTS idx_fusion_box_tubes_part_id ON public.fusion_box_tubes(part_id);

-- cam_jobs.part_id (already used by the existing turning/routing/tubestock
-- pipeline - see queueCamJobForPart in autocam/camJobs.js) is populated for
-- a Fusion box-tube job at queue time, propagated straight from
-- fusion_box_tubes.part_id (a clean 1:1 - one box tube per job). A plate job
-- is deliberately left with cam_jobs.part_id = null: a plate nests MANY
-- parts, which may be for several different (or no) requests at once, so a
-- single part_id on the job row can't represent that honestly - the real
-- per-part traceability already lives one level down, on each
-- fusion_parts row nested onto the plate via fusion_part_category_assignments.
