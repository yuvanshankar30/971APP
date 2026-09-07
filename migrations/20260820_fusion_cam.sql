-- Fusion CAM system
-- The Fusion-360-backed milling pipeline is a second, separate CAM path
-- alongside the existing pure-JS
-- turning/routing generator (autocam/turning.js, autocam/routing.js), which
-- deliberately has no external dependency and is untouched by this file.
-- This one exists because real 3-axis milling (contoured 3D surfaces) needs
-- a real CAM engine - see autocam/docs/millimplementations.md's "Option C" -
-- and autocam/fusion/README.md for the full architecture writeup.
--
-- SCOPED FOR SPARTAN ROBOTICS SPECIFICALLY, not a multi-tenant SaaS: the
-- original AutoCAM serves many FRC teams (team_id scoping everywhere,
-- Teams/TeamInvites/TeamMembers/TeamKeys/TeamRunners, Better Auth sessions +
-- per-team API keys). None of that multi-tenancy layer is ported - this app
-- is already single-org, so every table below has no team_id and reuses
-- Supabase Auth + this app's own permissions.js (canManageCamProfiles)
-- instead of a separate auth/authorization system.
--
-- REUSED, not reinvented, from the existing cam_studio_system.sql:
-- - cam_jobs is the queue/claim table for Fusion milling jobs too
--   (operation_type='milling' already exists for exactly this; claimed_by/
--   claimed_at already exist and were "reserved for a future external
--   Runner" per that file's own comments, finally used for real here).
--   A Fusion job's plate/box-tube/arrangement-specific payload lives in
--   cam_jobs.params jsonb, e.g. {"fusion_job_kind": "plate:cam", "plate_id": "..."}
--   or {"fusion_job_kind": "box_tube", "box_tube_id": "..."} - no new column
--   needed, params was already built to hold exactly this kind of payload.
-- - cam_materials/cam_tools/cam_machines are reused as-is for reference data
--   (their Materials/Tools/Machines map onto these near 1:1); cam_machines
--   gains two new columns below for a real distinction their schema has
--   that ours didn't yet (can this machine run box-tube stock vs. flat
--   plate stock).
--
-- NEW tables below (fusion_part_categories, fusion_parts, fusion_plates,
-- fusion_part_category_assignments, fusion_box_tubes) cover genuinely new
-- domain concepts nothing in the existing schema has: nestable flat plate
-- stock, box-tube stock, material+thickness categories, and part-to-plate
-- quantity assignments. Prefixed fusion_ specifically to avoid any
-- ambiguity with the existing, unrelated public.parts table (the general
-- /manufacture part-tracking table - workflow/status/kitting/layout_x,y -
-- a completely different concept from a Fusion-CAM "part," which is just a
-- named quantity of stock waiting to be nested onto a plate).
--
-- SAFE TO RE-RUN: same idempotent pattern as cam_studio_system.sql -
-- CREATE ... IF NOT EXISTS for tables/indexes, ALTER TABLE ... ADD COLUMN
-- IF NOT EXISTS for every column, DROP POLICY/TRIGGER IF EXISTS before
-- every CREATE.

-- ============================================================================
-- cam_machines: two new columns (box-tube vs. plate capability)
-- ============================================================================
ALTER TABLE public.cam_machines ADD COLUMN IF NOT EXISTS can_run_box_tubes boolean NOT NULL DEFAULT false;
ALTER TABLE public.cam_machines ADD COLUMN IF NOT EXISTS can_run_plates boolean NOT NULL DEFAULT true;

-- ============================================================================
-- FUSION PART CATEGORIES: a material+thickness grouping (their PartCategories)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.fusion_part_categories (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  material_id uuid NOT NULL,
  thickness numeric NOT NULL, -- inches
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT fusion_part_categories_pkey PRIMARY KEY (id)
);
ALTER TABLE public.fusion_part_categories ADD COLUMN IF NOT EXISTS material_id uuid;
ALTER TABLE public.fusion_part_categories ADD COLUMN IF NOT EXISTS thickness numeric;
ALTER TABLE public.fusion_part_categories ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now();
ALTER TABLE public.fusion_part_categories ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();
DO $$ BEGIN
  ALTER TABLE public.fusion_part_categories ADD CONSTRAINT fusion_part_categories_material_thickness_key UNIQUE (material_id, thickness);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.fusion_part_categories ADD CONSTRAINT fusion_part_categories_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.cam_materials(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- ============================================================================
-- FUSION PARTS: a named quantity of a category's stock, waiting to be
-- nested onto a plate (their Parts)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.fusion_parts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  epic text, -- optional free-text project/ticket grouping, matching their Parts.epic
  ticket text,
  quantity integer NOT NULL DEFAULT 0, -- remaining quantity still to be nested/cut
  original_quantity integer NOT NULL DEFAULT 0, -- quantity originally requested, for progress tracking
  category_id uuid NOT NULL,
  step_file_name text, -- storage path in the shared manufacturing-files bucket (same bucket/pattern cam_jobs.step_file_name already uses)
  created_by uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT fusion_parts_pkey PRIMARY KEY (id)
);
ALTER TABLE public.fusion_parts ADD COLUMN IF NOT EXISTS epic text;
ALTER TABLE public.fusion_parts ADD COLUMN IF NOT EXISTS ticket text;
ALTER TABLE public.fusion_parts ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 0;
ALTER TABLE public.fusion_parts ADD COLUMN IF NOT EXISTS original_quantity integer NOT NULL DEFAULT 0;
ALTER TABLE public.fusion_parts ADD COLUMN IF NOT EXISTS category_id uuid;
ALTER TABLE public.fusion_parts ADD COLUMN IF NOT EXISTS step_file_name text;
ALTER TABLE public.fusion_parts ADD COLUMN IF NOT EXISTS created_by uuid;
ALTER TABLE public.fusion_parts ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now();
ALTER TABLE public.fusion_parts ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();
DO $$ BEGIN
  ALTER TABLE public.fusion_parts ADD CONSTRAINT fusion_parts_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.fusion_part_categories(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.fusion_parts ADD CONSTRAINT fusion_parts_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- ============================================================================
-- FUSION PLATES: a sheet of stock parts get nested onto (their Plates)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.fusion_plates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  width numeric NOT NULL, -- inches
  length numeric NOT NULL, -- inches
  true_depth numeric NOT NULL, -- inches - this specific plate's actual measured thickness (can vary slightly from its category's nominal thickness)
  category_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT fusion_plates_pkey PRIMARY KEY (id)
);
ALTER TABLE public.fusion_plates ADD COLUMN IF NOT EXISTS width numeric;
ALTER TABLE public.fusion_plates ADD COLUMN IF NOT EXISTS length numeric;
ALTER TABLE public.fusion_plates ADD COLUMN IF NOT EXISTS true_depth numeric;
ALTER TABLE public.fusion_plates ADD COLUMN IF NOT EXISTS category_id uuid;
ALTER TABLE public.fusion_plates ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now();
ALTER TABLE public.fusion_plates ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();
DO $$ BEGIN
  ALTER TABLE public.fusion_plates ADD CONSTRAINT fusion_plates_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.fusion_part_categories(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- ============================================================================
-- FUSION PART CATEGORY ASSIGNMENTS: how many of a part are nested onto a
-- given plate (their PartCategoryAssignments / "parts_to_plates")
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.fusion_part_category_assignments (
  category_id uuid NOT NULL,
  plate_id uuid NOT NULL,
  part_id uuid NOT NULL,
  quantity integer NOT NULL
);
ALTER TABLE public.fusion_part_category_assignments ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE public.fusion_part_category_assignments ADD CONSTRAINT fusion_part_category_assignments_unique UNIQUE (plate_id, part_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.fusion_part_category_assignments ADD CONSTRAINT fusion_pca_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.fusion_part_categories(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.fusion_part_category_assignments ADD CONSTRAINT fusion_pca_plate_id_fkey FOREIGN KEY (plate_id) REFERENCES public.fusion_plates(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.fusion_part_category_assignments ADD CONSTRAINT fusion_pca_part_id_fkey FOREIGN KEY (part_id) REFERENCES public.fusion_parts(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- ============================================================================
-- FUSION BOX TUBES: box-tube stock, a separate physical stock type from
-- flat plates (their BoxTubes)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.fusion_box_tubes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  ticket text,
  epic text,
  quantity integer NOT NULL DEFAULT 1,
  step_file_name text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT fusion_box_tubes_pkey PRIMARY KEY (id)
);
ALTER TABLE public.fusion_box_tubes ADD COLUMN IF NOT EXISTS ticket text;
ALTER TABLE public.fusion_box_tubes ADD COLUMN IF NOT EXISTS epic text;
ALTER TABLE public.fusion_box_tubes ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 1;
ALTER TABLE public.fusion_box_tubes ADD COLUMN IF NOT EXISTS step_file_name text;
ALTER TABLE public.fusion_box_tubes ADD COLUMN IF NOT EXISTS created_by uuid;
ALTER TABLE public.fusion_box_tubes ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now();
ALTER TABLE public.fusion_box_tubes ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();
DO $$ BEGIN
  ALTER TABLE public.fusion_box_tubes ADD CONSTRAINT fusion_box_tubes_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- ============================================================================
-- INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_fusion_parts_category_id ON public.fusion_parts(category_id);
CREATE INDEX IF NOT EXISTS idx_fusion_plates_category_id ON public.fusion_plates(category_id);
CREATE INDEX IF NOT EXISTS idx_fusion_pca_plate_id ON public.fusion_part_category_assignments(plate_id);
CREATE INDEX IF NOT EXISTS idx_fusion_pca_part_id ON public.fusion_part_category_assignments(part_id);

-- ============================================================================
-- ROW LEVEL SECURITY - same shape as cam_studio_system.sql: readable by any
-- approved user, writable by any authenticated user (the real "who can
-- actually manage this" gate is enforced in the frontend via
-- canManageCamProfiles, same as the existing cam_materials/cam_tools/
-- cam_machines panels already do), service_role bypass-all for server code.
-- ============================================================================
ALTER TABLE public.fusion_part_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fusion_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fusion_plates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fusion_part_category_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fusion_box_tubes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fusion_part_categories_select" ON public.fusion_part_categories;
CREATE POLICY "fusion_part_categories_select" ON public.fusion_part_categories FOR SELECT TO authenticated USING (public.approved_user());
DROP POLICY IF EXISTS "fusion_part_categories_write" ON public.fusion_part_categories;
CREATE POLICY "fusion_part_categories_write" ON public.fusion_part_categories FOR ALL TO authenticated USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "fusion_parts_select" ON public.fusion_parts;
CREATE POLICY "fusion_parts_select" ON public.fusion_parts FOR SELECT TO authenticated USING (public.approved_user());
DROP POLICY IF EXISTS "fusion_parts_write" ON public.fusion_parts;
CREATE POLICY "fusion_parts_write" ON public.fusion_parts FOR ALL TO authenticated USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "fusion_plates_select" ON public.fusion_plates;
CREATE POLICY "fusion_plates_select" ON public.fusion_plates FOR SELECT TO authenticated USING (public.approved_user());
DROP POLICY IF EXISTS "fusion_plates_write" ON public.fusion_plates;
CREATE POLICY "fusion_plates_write" ON public.fusion_plates FOR ALL TO authenticated USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "fusion_pca_select" ON public.fusion_part_category_assignments;
CREATE POLICY "fusion_pca_select" ON public.fusion_part_category_assignments FOR SELECT TO authenticated USING (public.approved_user());
DROP POLICY IF EXISTS "fusion_pca_write" ON public.fusion_part_category_assignments;
CREATE POLICY "fusion_pca_write" ON public.fusion_part_category_assignments FOR ALL TO authenticated USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "fusion_box_tubes_select" ON public.fusion_box_tubes;
CREATE POLICY "fusion_box_tubes_select" ON public.fusion_box_tubes FOR SELECT TO authenticated USING (public.approved_user());
DROP POLICY IF EXISTS "fusion_box_tubes_write" ON public.fusion_box_tubes;
CREATE POLICY "fusion_box_tubes_write" ON public.fusion_box_tubes FOR ALL TO authenticated USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "fusion_part_categories_service_all" ON public.fusion_part_categories;
CREATE POLICY "fusion_part_categories_service_all" ON public.fusion_part_categories TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "fusion_parts_service_all" ON public.fusion_parts;
CREATE POLICY "fusion_parts_service_all" ON public.fusion_parts TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "fusion_plates_service_all" ON public.fusion_plates;
CREATE POLICY "fusion_plates_service_all" ON public.fusion_plates TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "fusion_pca_service_all" ON public.fusion_part_category_assignments;
CREATE POLICY "fusion_pca_service_all" ON public.fusion_part_category_assignments TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "fusion_box_tubes_service_all" ON public.fusion_box_tubes;
CREATE POLICY "fusion_box_tubes_service_all" ON public.fusion_box_tubes TO service_role USING (true) WITH CHECK (true);

-- ============================================================================
-- TRIGGER: updated_at (reuses the existing update_cam_studio_updated_at()
-- function from cam_studio_system.sql - same trigger body, no need to
-- redefine it)
-- ============================================================================
DROP TRIGGER IF EXISTS fusion_part_categories_updated_at ON public.fusion_part_categories;
CREATE TRIGGER fusion_part_categories_updated_at BEFORE UPDATE ON public.fusion_part_categories FOR EACH ROW EXECUTE FUNCTION public.update_cam_studio_updated_at();

DROP TRIGGER IF EXISTS fusion_parts_updated_at ON public.fusion_parts;
CREATE TRIGGER fusion_parts_updated_at BEFORE UPDATE ON public.fusion_parts FOR EACH ROW EXECUTE FUNCTION public.update_cam_studio_updated_at();

DROP TRIGGER IF EXISTS fusion_plates_updated_at ON public.fusion_plates;
CREATE TRIGGER fusion_plates_updated_at BEFORE UPDATE ON public.fusion_plates FOR EACH ROW EXECUTE FUNCTION public.update_cam_studio_updated_at();

DROP TRIGGER IF EXISTS fusion_box_tubes_updated_at ON public.fusion_box_tubes;
CREATE TRIGGER fusion_box_tubes_updated_at BEFORE UPDATE ON public.fusion_box_tubes FOR EACH ROW EXECUTE FUNCTION public.update_cam_studio_updated_at();
