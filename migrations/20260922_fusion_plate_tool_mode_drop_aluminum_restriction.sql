-- Direct instruction: automatic (multi-tool) ATC swaps are no longer
-- restricted to Aluminum 6061 - the shop manually adjusts feed rate at the
-- router for whatever material is actually loaded, so every New Router job
-- can use Auto multi-tool regardless of material. This was already fixed
-- at the application layer (PartsTab.svelte's canUseAutoMultiTool,
-- templateTools.py's _choose_preset accepting a generic "Default preset"
-- for any material) but this DB trigger, the actual gate the insert hits
-- when a job is queued, was never updated to match - it still rejected any
-- non-Aluminum-6061 multi-tool job with 'Automatic tool swaps are
-- available only for Aluminum 6061'. The New Router hardware requirement
-- (confirmed: UNC Router cannot swap tools, New Router can) is unrelated
-- and stays enforced.
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
    SELECT lower(trim(m.name)) INTO machine_name
    FROM public.cam_machines m
    WHERE m.id = NEW.machine_id;
    IF machine_name IS DISTINCT FROM 'new router' THEN
      RAISE EXCEPTION 'Automatic tool swaps are available only on New Router';
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
