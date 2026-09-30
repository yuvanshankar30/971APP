-- Optional stock dimensions an operator can save on a turning part (and
-- override per job when queueing). All inches; NULL means "derive it from the
-- STEP file", which the Runner does (StockMath.py). Which columns apply
-- depends on cam_type: spacer uses OD/ID/length, hexShaft uses
-- across-flats/length; tailstock_length_in already existed and now also
-- changes the CAM (it sets how much material is carried behind the part).
ALTER TABLE public.fusion_turning_parts ADD COLUMN IF NOT EXISTS stock_length_in numeric;
ALTER TABLE public.fusion_turning_parts ADD COLUMN IF NOT EXISTS stock_od_in numeric;
ALTER TABLE public.fusion_turning_parts ADD COLUMN IF NOT EXISTS stock_id_in numeric;
ALTER TABLE public.fusion_turning_parts ADD COLUMN IF NOT EXISTS stock_across_flats_in numeric;

DO $$ BEGIN
  ALTER TABLE public.fusion_turning_parts ADD CONSTRAINT fusion_turning_parts_stock_positive_check CHECK (
    (stock_length_in IS NULL OR stock_length_in > 0)
    AND (stock_od_in IS NULL OR stock_od_in > 0)
    AND (stock_id_in IS NULL OR stock_id_in > 0)
    AND (stock_across_flats_in IS NULL OR stock_across_flats_in > 0)
    AND (stock_id_in IS NULL OR stock_od_in IS NULL OR stock_id_in < stock_od_in)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
