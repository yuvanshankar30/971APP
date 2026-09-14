-- Direct instruction: add 0.09in aluminum sheet to manufacturing stock -
-- and whenever a stock category is added, it needs to reach every one of
-- this shop's three separate places that read stock data, not just one:
--   1. src/lib/stock.json - the canonical list the CAD tab (cad/*.svelte)
--      and the general manufacturing workflow (manufacture/*.svelte)
--      already read directly and automatically pick up (edited alongside
--      this migration, in the same commit - no DB change needed there).
--   2. fusion_part_categories - AutoCAM's own "Material / Thickness"
--      dropdown on the Fusion CAM Parts/Plates tabs. Unlike #1, this is a
--      DB table that does NOT automatically derive from stock.json at
--      runtime - it was one-time seeded from it by
--      20260905_fusion_part_categories_from_stock.sql and needs its own
--      migration for every new category since, this one included.
-- Matched to cam_materials by the exact real name already seeded in
-- 20260821_cam_material_defaults.sql, same convention as #2's own
-- migration.
INSERT INTO public.fusion_part_categories (material_id, thickness)
SELECT id, 0.09 FROM public.cam_materials WHERE name = 'Aluminum 6061'
ON CONFLICT (material_id, thickness) DO NOTHING;
