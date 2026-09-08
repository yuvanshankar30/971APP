-- Imported Fusion tool-library metadata is catalog data, not confirmation
-- that a tool is physically loaded in the ShopSabre ATC.
ALTER TABLE public.cam_tools
  ADD COLUMN IF NOT EXISTS manual_tool_change boolean,
  ADD COLUMN IF NOT EXISTS tip_angle numeric,
  ADD COLUMN IF NOT EXISTS tool_library_guid text,
  ADD COLUMN IF NOT EXISTS source_tool_library_file text;

CREATE UNIQUE INDEX IF NOT EXISTS cam_tools_library_guid_key
  ON public.cam_tools (tool_library_guid)
  WHERE tool_library_guid IS NOT NULL;

CREATE OR REPLACE FUNCTION public.assert_unique_loaded_cam_tool_slot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE slot_number integer;
BEGIN
  SELECT tool_number INTO slot_number FROM public.cam_tools WHERE id = NEW.tool_id;
  IF slot_number IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.cam_machine_tools loaded
    JOIN public.cam_tools other_tool ON other_tool.id = loaded.tool_id
    WHERE loaded.machine_id = NEW.machine_id
      AND loaded.tool_id <> NEW.tool_id
      AND other_tool.tool_number = slot_number
  ) THEN
    RAISE EXCEPTION 'Machine % already has a loaded tool in slot %', NEW.machine_id, slot_number;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cam_machine_tools_unique_loaded_slot ON public.cam_machine_tools;
CREATE TRIGGER cam_machine_tools_unique_loaded_slot
  BEFORE INSERT OR UPDATE OF machine_id, tool_id ON public.cam_machine_tools
  FOR EACH ROW EXECUTE FUNCTION public.assert_unique_loaded_cam_tool_slot();

CREATE OR REPLACE FUNCTION public.assert_loaded_cam_tool_slot_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tool_number IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.cam_machine_tools mine
    JOIN public.cam_machine_tools other ON other.machine_id = mine.machine_id
    JOIN public.cam_tools other_tool ON other_tool.id = other.tool_id
    WHERE mine.tool_id = NEW.id
      AND other.tool_id <> NEW.id
      AND other_tool.tool_number = NEW.tool_number
  ) THEN
    RAISE EXCEPTION 'Cannot assign slot %: a loaded machine already uses it', NEW.tool_number;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cam_tools_unique_loaded_slot_update ON public.cam_tools;
CREATE TRIGGER cam_tools_unique_loaded_slot_update
  BEFORE UPDATE OF tool_number ON public.cam_tools
  FOR EACH ROW EXECUTE FUNCTION public.assert_loaded_cam_tool_slot_update();
