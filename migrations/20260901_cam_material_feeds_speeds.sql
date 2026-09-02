-- Real feeds/speeds for the materials backfilled by
-- 20260901_cam_materials_from_stock_catalog.sql.
--
-- Those rows landed with default_params = {}, which is not a neutral state:
-- applyMaterialDefaults() is a no-op when a material has nothing for the
-- current operation, so the job silently keeps the generator's own generic
-- fallback (routing.js TOOL_STEP_DEFAULTS: feed 25 in/min, stepDown 0.03,
-- spindle 14000). Those are aluminum's numbers. Running plywood or soft
-- plastic on them is slow and burns; running steel on them is how a bit
-- breaks. Picking a material has to change the G-code.
--
-- Calibration anchors are this shop's own existing rows - Aluminum 6061
-- (routing feed 25, stepDown 0.03) and Baltic Birch Plywood (feed 90,
-- stepDown 0.125) - so these sit on the same scale as numbers already
-- proven on this machine, rather than a generic internet chart.
--
-- Sources for the new numbers:
--   Soft plastics melt and re-weld when chipload is too LOW, so they want a
--   high feed at a LOWER rpm - the opposite of the metal intuition. Target
--   chipload 0.005-0.010" for a 1/4" cutter.
--     https://shapeokoenthusiasts.gitbook.io/shapeoko-cnc-a-to-z/cutting-plastics
--     https://workshopcalc.com/reference/cnc-feeds-speeds-chart
--   Mild steel turning with uncoated carbide: 250-300 SFM (coated 500-600);
--   roughing 0.010-0.015 IPR, finishing 0.002-0.005 IPR. Taking the bottom
--   of the uncoated range, since insert grade here is not guaranteed.
--     https://www.hymsonlaser.com/resources/tables/steel-speeds-feeds/
--     https://testtalkhq.com/lathe-turning-speeds-feeds-guide/

-- SRPP: a soft polypropylene-type sheet, routed. Low rpm + high feed keeps
-- chipload at ~0.005" (100 / (10000 * 2 flutes)) so it cuts chips instead of
-- melting a welded groove.
update cam_materials
set default_params = '{"routing":{"feedRate":100,"stepDown":0.125,"plungeRate":25,"spindleSpeed":10000}}'::jsonb
where name = 'SRPP' and (default_params is null or default_params = '{}'::jsonb);

-- Wood: generic sheet stock, same family as the Baltic Birch row this shop
-- already runs, so it inherits those proven numbers.
update cam_materials
set default_params = '{"routing":{"feedRate":90,"stepDown":0.125,"plungeRate":25,"spindleSpeed":16000}}'::jsonb
where name = 'Wood' and (default_params is null or default_params = '{}'::jsonb);

-- Steel: turning only. Deliberately NO routing entry - steel is not a
-- material for this shop's router, and stock.json only lists it as mill
-- stock. Leaving routing unset means a steel routing job keeps the generic
-- fallback, which is why the accompanying code change warns loudly instead
-- of letting that pass silently.
update cam_materials
set default_params = '{"turning":{"maxRpm":2500,"stepDown":0.035,"feedRough":0.008,"feedFinish":0.004,"surfaceSpeed":250}}'::jsonb
where name = 'Steel' and (default_params is null or default_params = '{}'::jsonb);
