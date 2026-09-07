-- Direct request: "Remove all existing plates and replace with placeholder
-- plates sized to your real stock (referencing the mfg tab's stock
-- categories), so nesting is easier."
--
-- Every fusion_plates row that existed before this migration was confirmed
-- test/debug debris from CAM pipeline debugging this session - every one
-- named "... Test Plate", "autocamTraining...", "srppTemplateFix",
-- "antontest", etc. (40 rows, checked directly against the live table
-- before writing this). Deleting them cascaded (ON DELETE CASCADE, see
-- 20260820_fusion_cam.sql) to their fusion_part_category_assignments rows,
-- which were the same test parts nested for the same debugging.
--
-- That one-time cleanup was already run directly against the live
-- database as part of this change - it is recorded here for the audit
-- trail, not repeated as literal SQL below. A blind, unconditional
-- "DELETE FROM fusion_plates" belongs in neither a migration nor a script
-- that might run again later: by the time this migration is next applied
-- to some other environment (staging, a fresh seed, a teammate's local
-- database), fusion_plates may hold real production plates that must
-- never be silently wiped by re-running a migration file. So only the
-- SAFE, IDEMPOTENT half of this change - seeding a starter plate per real
-- stock category - is actual SQL here.
--
-- One placeholder plate per REAL fusion_part_categories row (material +
-- thickness - the "stock categories" the Fusion CAM Parts/Plates tabs
-- already key nesting off, referenced directly here rather than
-- src/lib/stock.json, which has no real width/length data - every router
-- entry there is dimensions: "Sheet" with no numbers). 24x24in is a
-- placeholder size, not a measured one: no real sheet-size reference
-- exists anywhere in this app to source it from (checked stock.json, the
-- mfg tab's own router page, and cam_materials.default_params - none
-- carry real width/length), and it is deliberately the same nesting-sheet
-- size most of this session's own real test plates already used. The name
-- says "Placeholder" for exactly this reason: resize these to real
-- measured stock as it's confirmed, rather than treating 24x24 as
-- authoritative.
--
-- Only creates a plate for a category that doesn't already have one -
-- safe to re-run, and never overwrites or duplicates a real plate someone
-- has since added for that category (by hand, or by a future run of this
-- same migration).
INSERT INTO public.fusion_plates (name, width, length, true_depth, category_id)
SELECT
  'Placeholder - ' || fpc.thickness || 'in ' || COALESCE(cm.name, 'Material'),
  24,
  24,
  fpc.thickness,
  fpc.id
FROM public.fusion_part_categories fpc
LEFT JOIN public.cam_materials cm ON cm.id = fpc.material_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.fusion_plates fp WHERE fp.category_id = fpc.id
);
