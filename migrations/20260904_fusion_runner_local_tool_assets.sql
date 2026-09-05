-- Fusion Runner is shipped in this repository alongside the shop's actual
-- Fusion tool-library archives. It used to ask endpoints such as /api/tools
-- and /api/machines for those files, but this application never exposed
-- those endpoints; the failed requests were caught and the Runner quietly
-- cut with Fusion's raw template default instead of the tool selected in the
-- web UI. Store only a checked-in filename here so the Runner can load it
-- locally, without a second network request after it claims a job.
ALTER TABLE public.cam_tools
  ADD COLUMN IF NOT EXISTS fusion_tool_library_file text;

-- 971-outside-plate.tools is the real Fusion 360 export for the 971 Main
-- Bit, not a generic published library. It includes the 0.1575 in carbide
-- tool and its shop-programmed preset. "971 Main Bit" may not exist in a
-- deployed database yet, so this intentionally updates zero rows until a
-- human creates or verifies that tool. The second name covers the existing
-- UNC Router 0.1575 in Flat End Mill seed when it is being used as that bit.
UPDATE public.cam_tools
SET fusion_tool_library_file = '971-outside-plate.tools'
WHERE name IN ('971 Main Bit', 'UNC Router 0.1575 in Flat End Mill')
  AND NULLIF(btrim(fusion_tool_library_file), '') IS NULL;

-- These names are the two committed Fusion post processors, verified against
-- the physical controller mapping documented in autocam/postprocessors:
-- UNC Router uses LinuxCNC/EMC (971_emc.cps), while New Router is the
-- ShopSabre Pro 408 using WinCNC (shopsabre.cps). Only fill absent values so
-- an explicitly configured machine is never overwritten.
UPDATE public.cam_machines
SET post_processor = '971_emc.cps'
WHERE name = 'UNC Router'
  AND NULLIF(btrim(post_processor), '') IS NULL;

UPDATE public.cam_machines
SET post_processor = 'shopsabre.cps'
WHERE name = 'New Router'
  AND NULLIF(btrim(post_processor), '') IS NULL;
