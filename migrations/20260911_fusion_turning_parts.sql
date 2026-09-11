-- Turning stock catalog for Fusion AutoCAM's lathe pipeline (HandleSpacer.py /
-- HandleHexShaft.py) - mirrors fusion_box_tubes' own shape (20260820_fusion_cam.sql)
-- plus the two fields turning needs that no other stock kind does: which CAM
-- type this bar is (drives which handler the Runner calls) and an optional
-- tailstock/live-center length override (both handlers default this to the
-- part's own measured length when not set).
CREATE TABLE IF NOT EXISTS public.fusion_turning_parts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  ticket text,
  epic text,
  quantity integer NOT NULL DEFAULT 1,
  cam_type text NOT NULL,
  tailstock_length_in numeric,
  step_file_name text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  part_id bigint,
  project_id text,
  stock_assignment text,
  CONSTRAINT fusion_turning_parts_pkey PRIMARY KEY (id),
  CONSTRAINT fusion_turning_parts_cam_type_check CHECK (cam_type IN ('spacer', 'hexShaft'))
);

DO $$ BEGIN
  ALTER TABLE public.fusion_turning_parts ADD CONSTRAINT fusion_turning_parts_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.fusion_turning_parts ENABLE ROW LEVEL SECURITY;

-- Same four-policy shape 20260906_fusion_grouping_integrity.sql gave every
-- other fusion stock table - can_manage_fusion_stock() already exists from
-- that migration, so this table is created directly with its final policies
-- rather than the write-then-narrow two-step the earlier tables went through.
DROP POLICY IF EXISTS "fusion_turning_parts_select" ON public.fusion_turning_parts;
CREATE POLICY "fusion_turning_parts_select" ON public.fusion_turning_parts FOR SELECT TO authenticated USING (public.approved_user());
DROP POLICY IF EXISTS "fusion_turning_parts_insert" ON public.fusion_turning_parts;
CREATE POLICY "fusion_turning_parts_insert" ON public.fusion_turning_parts FOR INSERT TO authenticated WITH CHECK (public.can_manage_fusion_stock());
DROP POLICY IF EXISTS "fusion_turning_parts_update" ON public.fusion_turning_parts;
CREATE POLICY "fusion_turning_parts_update" ON public.fusion_turning_parts FOR UPDATE TO authenticated USING (public.can_manage_fusion_stock()) WITH CHECK (public.can_manage_fusion_stock());
DROP POLICY IF EXISTS "fusion_turning_parts_delete" ON public.fusion_turning_parts;
CREATE POLICY "fusion_turning_parts_delete" ON public.fusion_turning_parts FOR DELETE TO authenticated USING (public.can_manage_fusion_stock());
DROP POLICY IF EXISTS "fusion_turning_parts_service_all" ON public.fusion_turning_parts;
CREATE POLICY "fusion_turning_parts_service_all" ON public.fusion_turning_parts TO service_role USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS fusion_turning_parts_updated_at ON public.fusion_turning_parts;
CREATE TRIGGER fusion_turning_parts_updated_at BEFORE UPDATE ON public.fusion_turning_parts FOR EACH ROW EXECUTE FUNCTION public.update_cam_studio_updated_at();

-- A lathe-capable machine profile, the same shape as can_run_box_tubes /
-- can_run_plates (20260820_fusion_cam.sql) - queueing a turning job filters
-- cam_machines on this instead of inventing a separate machine-kind table.
ALTER TABLE public.cam_machines ADD COLUMN IF NOT EXISTS can_run_turning boolean NOT NULL DEFAULT false;
