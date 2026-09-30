-- Internal shaft: a third lathe CAM type (hex bar stock, round journal turned
-- on each end, no grooves - HandleInternalShaft.py). Widens the allowed
-- cam_type values on fusion_turning_parts; existing rows are unaffected.
ALTER TABLE public.fusion_turning_parts DROP CONSTRAINT IF EXISTS fusion_turning_parts_cam_type_check;
ALTER TABLE public.fusion_turning_parts ADD CONSTRAINT fusion_turning_parts_cam_type_check
  CHECK (cam_type IN ('spacer', 'hexShaft', 'internalShaft'));
