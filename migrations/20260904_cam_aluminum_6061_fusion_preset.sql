-- Aluminum 6061 routing defaults from this shop's actual Fusion 360 tool
-- preset, replacing the generic published starting points seeded in
-- 20260821_cam_material_defaults.sql.
--
-- Source: autocam/fusion/runner/tools/971-outside-plate.tools, the exported
-- Fusion tool library used by this shop's runner. Its "971 Main Bit" carbide
-- flat end mill is 0.1575" diameter, which is the same diameter AutoCAM
-- defaults to in routing.js. The preset programs n = 22000 RPM, v_f = 80
-- in/min cutting feed, and v_f_plunge = 13.333 in/min. Those are real CAM
-- values for the actual bit, not a catalog/chart estimate.
--
-- The export also contains a 0.1875" HSS "971 Main Bit" at 13000 RPM. It is
-- deliberately not used here: its diameter does not match AutoCAM's 0.1575"
-- routing default, so borrowing its spindle value would silently pair the
-- wrong tool preset with the generated program.
--
-- Fusion marks the carbide preset use-stepdown = false, meaning the export
-- carries no actual axial step-down to calibrate from. Preserve the existing
-- 0.03" stepDown rather than guessing a new one from feed/speed data.
--
-- Merge only the three measured values into routing so the Aluminum 6061
-- turning defaults, stepDown, and any future routing-specific keys survive.
UPDATE public.cam_materials
SET default_params = jsonb_set(
  COALESCE(default_params, '{}'::jsonb),
  '{routing}',
  COALESCE(default_params -> 'routing', '{}'::jsonb) ||
    '{"feedRate": 80, "plungeRate": 13.333, "spindleSpeed": 22000}'::jsonb
)
WHERE name = 'Aluminum 6061';
