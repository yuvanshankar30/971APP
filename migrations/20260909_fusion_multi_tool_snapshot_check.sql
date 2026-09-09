-- fusion_snapshot_plate_job's machine/tool check has always required
-- NEW.tool_id to join a real cam_machine_tools row for every plate:cam job -
-- correct for single-tool jobs, but structurally impossible to satisfy for
-- New Router's Auto multi-tool mode, which deliberately sends tool_id=null
-- (the planner resolves from every loaded cutter server-side, not one
-- manual selection - see autocam/fusion/jobPayload.js's resolveLoadedToolItems).
-- Confirmed live: a multi-tool job with everything else correctly filled in
-- still failed at insert with "Choose an enabled plate machine and a tool
-- installed on it," a check this trigger enforces independently of - and
-- unaffected by - any application-layer fix. Only the machine itself needs
-- to be a real, enabled, plate-capable machine in that mode; the specific
-- tool_id match is skipped, matching the same "tool_id is vestigial in
-- multi-tool mode" principle already applied at the application layer.
BEGIN;

CREATE OR REPLACE FUNCTION public.fusion_snapshot_plate_job() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE plate public.fusion_plates%ROWTYPE; category public.fusion_part_categories%ROWTYPE;
  assignments jsonb; material_name text; grouping_mode text; selected_part_id uuid; selected_part_ids uuid[];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.operation_type = 'milling' AND NEW.params->>'fusionJobKind' IN ('plate:cam', 'plate:arrange')
      AND NOT (OLD.operation_type = 'milling' AND coalesce(OLD.params->>'fusionJobKind', '') IN ('plate:cam', 'plate:arrange')) THEN
      RAISE EXCEPTION 'Create a new Fusion plate job instead of converting an existing job';
    END IF;
    IF OLD.operation_type = 'milling' AND OLD.params->>'fusionJobKind' IN ('plate:cam', 'plate:arrange')
      AND (NEW.params, NEW.machine_id, NEW.tool_id, NEW.material_id, NEW.operation_type)
      IS DISTINCT FROM (OLD.params, OLD.machine_id, OLD.tool_id, OLD.material_id, OLD.operation_type) THEN
      RAISE EXCEPTION 'Queued Fusion inputs are immutable; queue a new job';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.operation_type <> 'milling' OR coalesce(NEW.params->>'fusionJobKind', '') NOT IN ('plate:cam', 'plate:arrange') THEN RETURN NEW; END IF;
  IF NEW.status <> 'queued' THEN RAISE EXCEPTION 'Fusion plate jobs must start queued'; END IF;
  SELECT * INTO plate FROM public.fusion_plates WHERE id = (NEW.params->>'plateId')::uuid FOR UPDATE;
  IF plate.id IS NULL THEN RAISE EXCEPTION 'Plate not found'; END IF;
  SELECT * INTO category FROM public.fusion_part_categories WHERE id = plate.category_id;
  SELECT name INTO material_name FROM public.cam_materials WHERE id = category.material_id;
  IF plate.length <= 0 OR plate.width <= 0 OR plate.true_depth <= 0 OR category.thickness <= 0
     OR plate.length::text IN ('NaN','Infinity') OR plate.width::text IN ('NaN','Infinity')
     OR plate.true_depth::text IN ('NaN','Infinity') OR category.thickness::text IN ('NaN','Infinity') THEN
    RAISE EXCEPTION 'Plate dimensions and thickness must be finite and positive';
  END IF;
  IF NEW.params->>'fusionJobKind' = 'plate:cam' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.cam_machines m WHERE m.id = NEW.machine_id AND m.enabled AND m.can_run_plates
    ) THEN RAISE EXCEPTION 'Choose an enabled plate machine'; END IF;
    IF coalesce(NEW.params->>'multiToolMode', 'false') <> 'true' AND NOT EXISTS (
      SELECT 1 FROM public.cam_machine_tools mt WHERE mt.machine_id = NEW.machine_id AND mt.tool_id = NEW.tool_id
    ) THEN RAISE EXCEPTION 'Choose an enabled plate machine and a tool installed on it'; END IF;
  END IF;
  grouping_mode := NEW.params->>'fusionGroupingMode';
  IF NEW.params->>'fusionJobKind' = 'plate:cam'
    AND (grouping_mode IS NULL OR grouping_mode NOT IN ('single', 'grouped')) THEN
    RAISE EXCEPTION 'Choose single-part or grouped Fusion CAM explicitly';
  END IF;
  IF grouping_mode = 'single' THEN
    BEGIN selected_part_id := (NEW.params->>'selectedPartId')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Choose one nested part for single-part CAM'; END;
    IF selected_part_id IS NULL THEN RAISE EXCEPTION 'Choose one nested part for single-part CAM'; END IF;
  ELSIF grouping_mode = 'grouped' THEN
    IF NEW.params->>'selectedPartId' IS NOT NULL THEN
      RAISE EXCEPTION 'Grouped CAM uses the selected part list, not one selected part';
    END IF;
    IF jsonb_typeof(NEW.params->'selectedPartIds') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Select at least two nested part types for grouped CAM';
    END IF;
    BEGIN
      SELECT array_agg(value::uuid ORDER BY value) INTO selected_part_ids
      FROM jsonb_array_elements_text(NEW.params->'selectedPartIds');
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Grouped CAM part selections must be valid IDs';
    END;
    IF cardinality(selected_part_ids) < 2 OR cardinality(selected_part_ids) <> (
      SELECT count(DISTINCT value) FROM unnest(selected_part_ids) value
    ) THEN RAISE EXCEPTION 'Select at least two distinct nested part types for grouped CAM'; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.fusion_part_category_assignments a JOIN public.fusion_parts p ON p.id = a.part_id
    WHERE a.plate_id = plate.id AND (a.quantity <= 0 OR a.category_id <> plate.category_id OR p.category_id <> plate.category_id
      OR nullif(trim(p.step_file_name), '') IS NULL)
      AND (grouping_mode IS DISTINCT FROM 'single' OR p.id = selected_part_id)
      AND (grouping_mode IS DISTINCT FROM 'grouped' OR p.id = ANY(selected_part_ids))) THEN
    RAISE EXCEPTION 'Every nested part needs matching stock, a positive quantity, and a STEP file';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('part_id', p.id, 'name', p.name, 'quantity', a.quantity,
    'step_file_name', p.step_file_name, 'fusion_file_name', p.fusion_file_name) ORDER BY p.id)
    INTO assignments FROM public.fusion_part_category_assignments a JOIN public.fusion_parts p ON p.id = a.part_id
    WHERE a.plate_id = plate.id
      AND (grouping_mode IS DISTINCT FROM 'single' OR p.id = selected_part_id)
      AND (grouping_mode IS DISTINCT FROM 'grouped' OR p.id = ANY(selected_part_ids));
  IF assignments IS NULL THEN RAISE EXCEPTION 'Nest at least one part before queueing a plate'; END IF;
  IF grouping_mode = 'grouped' AND jsonb_array_length(assignments) <> cardinality(selected_part_ids) THEN
    RAISE EXCEPTION 'Every grouped CAM selection must be nested on this plate';
  END IF;
  IF grouping_mode = 'grouped' AND jsonb_array_length(assignments) < 2 THEN
    RAISE EXCEPTION 'Grouped Fusion CAM requires at least two nested part types';
  END IF;
  NEW.material_id := category.material_id;
  NEW.part_id := NULL;
  NEW.params := NEW.params || jsonb_build_object('fusionPlateSnapshot', jsonb_build_object(
    'version', 1, 'grouping_mode', grouping_mode, 'plate_id', plate.id, 'name', plate.name,
    'length', plate.length, 'width', plate.width,
    'true_depth', plate.true_depth, 'thickness', category.thickness, 'material', material_name, 'assignments', assignments));
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.fusion_snapshot_plate_job() FROM PUBLIC;
COMMIT;
