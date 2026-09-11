-- The 971 Lathe is Haas-controlled, not LinuxCNC. Its controller sat at
-- 'linuxcnc' because saveMachine() in src/routes/autocam/+page.svelte
-- unconditionally forced controller='linuxcnc' for every operation_type
-- except routing/tubestock - a real bug (fixed alongside this migration),
-- not a deliberate choice, so every save of this machine's profile silently
-- reset whatever controller was actually picked. Runner turning jobs then
-- failed outright: localCamAssets.py's resolve_local_post_processor has no
-- bundled post for 'linuxcnc' + turning (Fusion's own bundled linuxcnc.cps
-- is CAPABILITY_MILLING only - using it for a lathe would post lathe
-- toolpaths through a milling post processor, not just fail loudly).
--
-- Widen the two check constraints to allow the real values this machine
-- needs, matching the 'haas turning' post now bundled at
-- autocam/postprocessors/haas_turning.cps (copied from Fusion's own
-- official Autodesk-authored "HAAS Turning" post, capabilities =
-- CAPABILITY_TURNING - a real turning-capable post, not the milling-only
-- generic linuxcnc one).
ALTER TABLE public.cam_machines DROP CONSTRAINT IF EXISTS cam_machines_controller_check;
ALTER TABLE public.cam_machines ADD CONSTRAINT cam_machines_controller_check
  CHECK (controller = ANY (ARRAY['linuxcnc'::text, 'wincnc'::text, 'haas'::text]));

ALTER TABLE public.cam_machines DROP CONSTRAINT IF EXISTS cam_machines_gcode_extension_check;
ALTER TABLE public.cam_machines ADD CONSTRAINT cam_machines_gcode_extension_check
  CHECK (gcode_extension = ANY (ARRAY['ngc'::text, 'tap'::text, 'nc'::text]));

-- Same idempotent update-if-different pattern as
-- 20260908_new_router_shopsabre_post_processor.sql for the ShopSabre fix.
UPDATE public.cam_machines
SET controller = 'haas',
    post_processor = 'haas turning',
    gcode_extension = 'nc'
WHERE name = '971 Lathe'
  AND (
    controller IS DISTINCT FROM 'haas'
    OR post_processor IS DISTINCT FROM 'haas turning'
    OR gcode_extension IS DISTINCT FROM 'nc'
  );
