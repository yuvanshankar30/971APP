-- ATC slot presets: named snapshots of "which tool occupies which physical
-- slot" for a machine. is_hub_default = true marks the one shop-wide
-- default per machine (created_by NULL); everything else is a named preset
-- a signed-in user saved for themselves.
CREATE TABLE IF NOT EXISTS public.cam_machine_tool_slot_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id uuid NOT NULL REFERENCES public.cam_machines(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  is_hub_default boolean NOT NULL DEFAULT false,
  -- {"<tool_number>": "<cam_tools.id>", ...} - only numbered (ATC slot) tools.
  slot_assignments jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Exactly one hub default per machine.
CREATE UNIQUE INDEX IF NOT EXISTS cam_machine_tool_slot_presets_hub_default_key
  ON public.cam_machine_tool_slot_presets (machine_id)
  WHERE is_hub_default;

-- A user's own presets are uniquely named per machine (the hub default row,
-- created_by IS NULL, is excluded from this constraint).
CREATE UNIQUE INDEX IF NOT EXISTS cam_machine_tool_slot_presets_user_name_key
  ON public.cam_machine_tool_slot_presets (machine_id, created_by, name)
  WHERE created_by IS NOT NULL;

ALTER TABLE public.cam_machine_tool_slot_presets ENABLE ROW LEVEL SECURITY;

-- Matches this app's existing cam_machines/cam_machine_tools/cam_tools
-- policy shape exactly (see those tables) rather than inventing a new one.
-- CREATE POLICY has no IF NOT EXISTS, so drop-then-create to stay rerunnable.
DROP POLICY IF EXISTS cam_machine_tool_slot_presets_select ON public.cam_machine_tool_slot_presets;
CREATE POLICY cam_machine_tool_slot_presets_select ON public.cam_machine_tool_slot_presets
  FOR SELECT USING (public.approved_user());
DROP POLICY IF EXISTS cam_machine_tool_slot_presets_write ON public.cam_machine_tool_slot_presets;
CREATE POLICY cam_machine_tool_slot_presets_write ON public.cam_machine_tool_slot_presets
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
DROP POLICY IF EXISTS cam_machine_tool_slot_presets_service_all ON public.cam_machine_tool_slot_presets;
CREATE POLICY cam_machine_tool_slot_presets_service_all ON public.cam_machine_tool_slot_presets
  FOR ALL USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.touch_cam_machine_tool_slot_presets_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cam_machine_tool_slot_presets_touch_updated_at ON public.cam_machine_tool_slot_presets;
CREATE TRIGGER cam_machine_tool_slot_presets_touch_updated_at
  BEFORE UPDATE ON public.cam_machine_tool_slot_presets
  FOR EACH ROW EXECUTE FUNCTION public.touch_cam_machine_tool_slot_presets_updated_at();
