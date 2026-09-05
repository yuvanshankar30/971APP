-- fusion_part_categories (the "Material / Thickness" dropdown on the
-- Fusion CAM Parts/Plates tabs) has existed since 20260820_fusion_cam.sql
-- but no migration has ever seeded a row into it - the dropdown has been
-- empty since the feature shipped.
--
-- Seeded from src/lib/stock.json's own router sheet stock (dimensions ==
-- "Sheet") - the real materials/thicknesses this shop actually cuts on a
-- router, not a guess. Tube stock is excluded on purpose: fusion_box_tubes
-- has no category_id at all (box tubes don't go through this dropdown),
-- and mill block stock isn't router sheet stock either.
--
-- Matched to cam_materials by the exact real names already seeded in
-- 20260821_cam_material_defaults.sql - not every generic stock.json
-- material has a cam_materials row (e.g. plain "Wood"/plywood has no real
-- stock.json sheet thickness on record, so it's deliberately left out
-- rather than guessing one).
--
-- ON CONFLICT DO NOTHING (material_id, thickness) is already unique) so
-- this is safe to run against a database that already has some of these
-- rows from manual testing.

INSERT INTO public.fusion_part_categories (material_id, thickness)
SELECT id, thickness FROM public.cam_materials, unnest(ARRAY[0.0625, 0.125, 0.1875, 0.25, 0.375]) AS thickness
WHERE name = 'Aluminum 6061'
ON CONFLICT (material_id, thickness) DO NOTHING;

INSERT INTO public.fusion_part_categories (material_id, thickness)
SELECT id, thickness FROM public.cam_materials, unnest(ARRAY[0.0625, 0.125, 0.25, 0.375]) AS thickness
WHERE name = 'Polycarbonate (Lexan)'
ON CONFLICT (material_id, thickness) DO NOTHING;

INSERT INTO public.fusion_part_categories (material_id, thickness)
SELECT id, thickness FROM public.cam_materials, unnest(ARRAY[0.125, 0.25]) AS thickness
WHERE name = 'SRPP'
ON CONFLICT (material_id, thickness) DO NOTHING;
