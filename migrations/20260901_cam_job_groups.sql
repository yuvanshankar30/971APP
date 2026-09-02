-- One physical sheet/program can contain several already-generated router jobs.
-- The item table records the exact, reviewed placement used to make the G-code.
CREATE TABLE IF NOT EXISTS public.cam_job_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  project_id text,
  material_id uuid REFERENCES public.cam_materials(id) ON DELETE SET NULL,
  tool_id uuid REFERENCES public.cam_tools(id) ON DELETE SET NULL,
  machine_id uuid REFERENCES public.cam_machines(id) ON DELETE SET NULL,
  stock_width numeric NOT NULL CHECK (stock_width > 0),
  stock_height numeric NOT NULL CHECK (stock_height > 0),
  edge_margin numeric NOT NULL DEFAULT 0.5 CHECK (edge_margin >= 0),
  tolerance numeric NOT NULL DEFAULT 0.01 CHECK (tolerance >= 0),
  clearance numeric NOT NULL CHECK (clearance >= 0),
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  gcode text NOT NULL,
  gcode_file_name text NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cam_job_group_items (
  group_id uuid NOT NULL REFERENCES public.cam_job_groups(id) ON DELETE CASCADE,
  cam_job_id uuid NOT NULL REFERENCES public.cam_jobs(id) ON DELETE RESTRICT,
  offset_x numeric NOT NULL,
  offset_y numeric NOT NULL,
  bounds jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order integer NOT NULL,
  PRIMARY KEY (group_id, cam_job_id)
);

CREATE INDEX IF NOT EXISTS cam_job_groups_project_id_idx ON public.cam_job_groups(project_id);
CREATE INDEX IF NOT EXISTS cam_job_group_items_cam_job_id_idx ON public.cam_job_group_items(cam_job_id);

ALTER TABLE public.cam_job_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cam_job_group_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY cam_job_groups_select ON public.cam_job_groups FOR SELECT TO authenticated USING (public.approved_user());
CREATE POLICY cam_job_groups_write ON public.cam_job_groups FOR ALL TO authenticated USING (public.approved_user()) WITH CHECK (public.approved_user());
CREATE POLICY cam_job_group_items_select ON public.cam_job_group_items FOR SELECT TO authenticated USING (public.approved_user());
CREATE POLICY cam_job_group_items_write ON public.cam_job_group_items FOR ALL TO authenticated USING (public.approved_user()) WITH CHECK (public.approved_user());
CREATE POLICY cam_job_groups_service_all ON public.cam_job_groups TO service_role USING (true) WITH CHECK (true);
CREATE POLICY cam_job_group_items_service_all ON public.cam_job_group_items TO service_role USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS cam_job_groups_updated_at ON public.cam_job_groups;
CREATE TRIGGER cam_job_groups_updated_at BEFORE UPDATE ON public.cam_job_groups
FOR EACH ROW EXECUTE FUNCTION public.update_cam_studio_updated_at();
