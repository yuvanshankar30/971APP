-- Keep the operational identifiers visible on the Fusion AutoCAM records,
-- even when they were created from a manufacturing request rather than by
-- hand in the Fusion tabs. `part_id` remains the relational source of truth;
-- these values make the CAM work queue independently scannable.
ALTER TABLE public.fusion_parts
  ADD COLUMN IF NOT EXISTS project_id text,
  ADD COLUMN IF NOT EXISTS stock_assignment text;

ALTER TABLE public.fusion_box_tubes
  ADD COLUMN IF NOT EXISTS project_id text,
  ADD COLUMN IF NOT EXISTS stock_assignment text;
