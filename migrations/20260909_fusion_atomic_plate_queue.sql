-- Queueing a plate is one stock-state transition. The prior browser flow
-- upserted each assignment before confirmation, so Cancel left reservations
-- behind and a mid-group failure left a partial nest. Lock the category's
-- shared plate, replace its assignment set, and insert the snapshotted job in
-- one transaction instead.
BEGIN;

CREATE OR REPLACE FUNCTION public.fusion_validate_plate_tool_mode() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE machine_name text; material_name text; selected_tool_type text;
BEGIN
  IF NEW.operation_type <> 'milling'
     OR coalesce(NEW.params->>'fusionJobKind', '') NOT IN ('plate:cam', 'box_tube') THEN
    RETURN NEW;
  END IF;
  IF coalesce((NEW.params->>'singleToolMode')::boolean, false)
     AND coalesce((NEW.params->>'multiToolMode')::boolean, false) THEN
    RAISE EXCEPTION 'Single-tool and multi-tool mode cannot both be enabled';
  END IF;

  IF NEW.params->>'fusionJobKind' = 'box_tube' THEN
    IF coalesce((NEW.params->>'multiToolMode')::boolean, false) THEN
      RAISE EXCEPTION 'Tube CAM does not support automatic tool swaps';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.cam_machines machine
      JOIN public.cam_machine_tools loaded ON loaded.machine_id = machine.id
      WHERE machine.id = NEW.machine_id AND machine.enabled AND machine.can_run_box_tubes
        AND loaded.tool_id = NEW.tool_id
    ) THEN
      RAISE EXCEPTION 'Choose an enabled tube machine and a tool installed on it';
    END IF;
    SELECT lower(trim(material.name)), tool.tool_type INTO material_name, selected_tool_type
    FROM public.cam_materials material
    LEFT JOIN public.cam_tools tool ON tool.id = NEW.tool_id
    WHERE material.id = NEW.material_id;
    IF material_name IS NULL OR material_name !~ 'alumin(um|ium)' THEN
      RAISE EXCEPTION 'Tube CAM requires an aluminum material';
    END IF;
    IF selected_tool_type IS NULL OR selected_tool_type !~* 'end\s*mill' THEN
      RAISE EXCEPTION 'Tube CAM requires an endmill';
    END IF;
    RETURN NEW;
  END IF;

  IF coalesce((NEW.params->>'multiToolMode')::boolean, false) THEN
    SELECT lower(trim(m.name)), lower(trim(material.name)) INTO machine_name, material_name
    FROM public.cam_machines m
    JOIN public.fusion_plates plate ON plate.id = (NEW.params->>'plateId')::uuid
    JOIN public.fusion_part_categories category ON category.id = plate.category_id
    JOIN public.cam_materials material ON material.id = category.material_id
    WHERE m.id = NEW.machine_id;
    IF machine_name IS DISTINCT FROM 'new router' THEN
      RAISE EXCEPTION 'Automatic tool swaps are available only on New Router';
    END IF;
    IF material_name NOT IN ('aluminum 6061', 'aluminium 6061', '6061 aluminum', '6061 aluminium') THEN
      RAISE EXCEPTION 'Automatic tool swaps are available only for Aluminum 6061';
    END IF;
  END IF;

  IF coalesce((NEW.params->>'singleToolMode')::boolean, false) THEN
    SELECT tool_type INTO selected_tool_type FROM public.cam_tools WHERE id = NEW.tool_id;
    IF selected_tool_type IS NULL OR selected_tool_type !~* 'end\s*mill' THEN
      RAISE EXCEPTION 'Single-tool Fusion CAM requires an endmill';
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'Fusion plate job contains an invalid tool-mode value';
END $$;

DROP TRIGGER IF EXISTS fusion_validate_plate_tool_mode ON public.cam_jobs;
CREATE TRIGGER fusion_validate_plate_tool_mode
BEFORE INSERT ON public.cam_jobs
FOR EACH ROW EXECUTE FUNCTION public.fusion_validate_plate_tool_mode();

CREATE OR REPLACE FUNCTION public.queue_fusion_plate_job(
  p_plate_id uuid,
  p_assignments jsonb,
  p_machine_id uuid,
  p_tool_id uuid,
  p_name text,
  p_requested_by uuid,
  p_fusion_file_name text,
  p_fusion_folder_path text,
  p_tab_count integer,
  p_grouping_mode text,
  p_single_tool_mode boolean,
  p_multi_tool_mode boolean
) RETURNS public.cam_jobs
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, auth AS $$
DECLARE
  plate public.fusion_plates%ROWTYPE;
  queued public.cam_jobs%ROWTYPE;
  part_ids uuid[];
  assignment_count integer;
  valid_part_count integer;
BEGIN
  IF jsonb_typeof(p_assignments) IS DISTINCT FROM 'array' OR jsonb_array_length(p_assignments) = 0 THEN
    RAISE EXCEPTION 'Choose at least one part to queue';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_assignments) item
    WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR coalesce(item->>'partId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR coalesce(item->>'quantity', '') !~ '^[1-9][0-9]*$'
  ) THEN
    RAISE EXCEPTION 'Every queued assignment needs a valid part and positive whole-number quantity';
  END IF;

  SELECT array_agg((item->>'partId')::uuid ORDER BY item->>'partId'), count(*)
    INTO part_ids, assignment_count
  FROM jsonb_array_elements(p_assignments) item;
  IF cardinality(part_ids) <> (SELECT count(DISTINCT part_id) FROM unnest(part_ids) part_id) THEN
    RAISE EXCEPTION 'A part can appear only once in a queued plate';
  END IF;
  IF p_grouping_mode = 'single' AND assignment_count <> 1 THEN
    RAISE EXCEPTION 'Single-part CAM must contain exactly one part type';
  ELSIF p_grouping_mode = 'grouped' AND assignment_count < 2 THEN
    RAISE EXCEPTION 'Grouped CAM must contain at least two part types';
  ELSIF p_grouping_mode NOT IN ('single', 'grouped') THEN
    RAISE EXCEPTION 'Choose single-part or grouped Fusion CAM explicitly';
  END IF;
  IF p_single_tool_mode AND p_multi_tool_mode THEN
    RAISE EXCEPTION 'Single-tool and multi-tool mode cannot both be enabled';
  END IF;
  IF p_tab_count IS NOT NULL AND (p_tab_count < 4 OR p_tab_count > 20) THEN
    RAISE EXCEPTION 'Tab count must be between 4 and 20';
  END IF;

  SELECT * INTO plate FROM public.fusion_plates WHERE id = p_plate_id FOR UPDATE;
  IF plate.id IS NULL THEN RAISE EXCEPTION 'Plate not found'; END IF;

  SELECT count(*) INTO valid_part_count
  FROM jsonb_array_elements(p_assignments) item
  JOIN public.fusion_parts part ON part.id = (item->>'partId')::uuid
  WHERE part.id = ANY(part_ids)
    AND part.category_id = plate.category_id
    AND nullif(trim(part.step_file_name), '') IS NOT NULL
    AND (item->>'quantity')::integer <= part.original_quantity;
  IF valid_part_count <> assignment_count THEN
    RAISE EXCEPTION 'Every queued part must exist, match the plate stock, have a STEP file, and not exceed its requested quantity';
  END IF;

  DELETE FROM public.fusion_part_category_assignments WHERE plate_id = plate.id;
  INSERT INTO public.fusion_part_category_assignments(category_id, plate_id, part_id, quantity)
  SELECT plate.category_id, plate.id, (item->>'partId')::uuid, (item->>'quantity')::integer
  FROM jsonb_array_elements(p_assignments) item;

  INSERT INTO public.cam_jobs(
    name, source_type, operation_type, params, tool_id, machine_id, status, requested_by, part_id
  ) VALUES (
    nullif(trim(p_name), ''), 'upload', 'milling',
    jsonb_build_object(
      'fusionJobKind', 'plate:cam',
      'plateId', plate.id,
      'fusionGroupingMode', p_grouping_mode,
      'selectedPartId', CASE WHEN p_grouping_mode = 'single' THEN part_ids[1] ELSE NULL END,
      'selectedPartIds', CASE WHEN p_grouping_mode = 'grouped' THEN to_jsonb(part_ids) ELSE NULL END,
      'fusionFileName', nullif(trim(p_fusion_file_name), ''),
      'fusionFolderPath', nullif(trim(p_fusion_folder_path), ''),
      'tabCount', p_tab_count,
      'singleToolMode', coalesce(p_single_tool_mode, false),
      'multiToolMode', coalesce(p_multi_tool_mode, false)
    ),
    p_tool_id, p_machine_id, 'queued', coalesce(auth.uid(), p_requested_by), NULL
  ) RETURNING * INTO queued;

  RETURN queued;
END $$;

CREATE OR REPLACE FUNCTION public.fusion_plate_job_links(p_part_ids uuid[])
RETURNS TABLE(fusion_part_id uuid, job_id uuid)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT DISTINCT (assignment->>'part_id')::uuid, job.id
  FROM public.cam_jobs job
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(job.params #> '{fusionPlateSnapshot,assignments}') = 'array'
        THEN job.params #> '{fusionPlateSnapshot,assignments}'
      ELSE '[]'::jsonb
    END
  ) assignment
  WHERE job.operation_type = 'milling'
    AND job.params->>'fusionJobKind' = 'plate:cam'
    AND (assignment->>'part_id')::uuid = ANY(p_part_ids)
$$;

REVOKE ALL ON FUNCTION public.fusion_validate_plate_tool_mode() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.queue_fusion_plate_job(uuid,jsonb,uuid,uuid,text,uuid,text,text,integer,text,boolean,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fusion_plate_job_links(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.queue_fusion_plate_job(uuid,jsonb,uuid,uuid,text,uuid,text,text,integer,text,boolean,boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fusion_plate_job_links(uuid[]) TO authenticated, service_role;

COMMIT;
