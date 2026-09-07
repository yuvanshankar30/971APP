-- AutoCAM (CAM Studio) system
-- STEP -> G-code job queue, distinct from the legacy DXF/PenguinCAM
-- autocam_* tables (which only handle 2D sheet-cutting for the router
-- workflow and are currently disabled via DISABLE_AUTOCAM).
--
-- Turning and routing are generated synchronously, server-side, by pure
-- geometry math (src/lib/cam/turning.js, src/lib/cam/routing.js) driven off
-- geometry extracted directly from the part's STEP file (src/lib/cam/stepProfile.js,
-- via occt-import-js) - no DXF, no separate 2D drawing, no external CAM
-- software involved. Milling is not implemented (see millimplementations.md)
-- but 'milling' stays a valid operation_type for forward-compatibility.
--
-- SAFE TO RE-RUN: this file was revised several times while being built, so
-- every table/column/policy/index below is written to be safely re-applied
-- no matter which earlier revision (if any) already ran against this
-- database - CREATE ... IF NOT EXISTS for tables/indexes, explicit
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS for every column so an older,
-- partially-applied version gets brought fully up to date, DROP POLICY IF
-- EXISTS before every CREATE POLICY, and DROP TRIGGER IF EXISTS before every
-- CREATE TRIGGER. If AutoCAM is failing with empty material/tool/machine
-- dropdowns or "relation does not exist" errors, just re-run this whole file.

-- ============================================================================
-- REFERENCE TABLES: materials, tools, machines
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.cam_materials (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category text, -- e.g. 'aluminum', 'polycarbonate', 'plywood', 'delrin'
  notes text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT cam_materials_pkey PRIMARY KEY (id)
);
ALTER TABLE public.cam_materials ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE public.cam_materials ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.cam_materials ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE public.cam_materials ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now();
ALTER TABLE public.cam_materials ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();
DO $$ BEGIN
  ALTER TABLE public.cam_materials ADD CONSTRAINT cam_materials_name_key UNIQUE (name);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.cam_tools (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  tool_type text, -- e.g. 'endmill', 'ball-nose', 'router-bit', 'drill', 'turning-insert'
  diameter numeric, -- inches
  flutes integer,
  nose_radius numeric, -- inches; lathe insert nose radius, used for a simplified finishing-pass offset
  tool_number integer, -- fixed slot/number this tool corresponds to on the machine, referenced in tool-change G-code blocks
  notes text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT cam_tools_pkey PRIMARY KEY (id)
);
ALTER TABLE public.cam_tools ADD COLUMN IF NOT EXISTS tool_type text;
ALTER TABLE public.cam_tools ADD COLUMN IF NOT EXISTS diameter numeric;
ALTER TABLE public.cam_tools ADD COLUMN IF NOT EXISTS flutes integer;
ALTER TABLE public.cam_tools ADD COLUMN IF NOT EXISTS nose_radius numeric;
ALTER TABLE public.cam_tools ADD COLUMN IF NOT EXISTS tool_number integer;
ALTER TABLE public.cam_tools ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.cam_tools ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE public.cam_tools ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now();
ALTER TABLE public.cam_tools ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();
DO $$ BEGIN
  ALTER TABLE public.cam_tools ADD CONSTRAINT cam_tools_name_key UNIQUE (name);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- Machine profiles: a named, reusable bundle of default settings for a
-- specific physical machine, so parameters don't have to be re-entered for
-- every job. Each profile is locked to one operation_type (a lathe profile
-- only makes sense for turning, a router profile only for routing).
CREATE TABLE IF NOT EXISTS public.cam_machines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  operation_type text NOT NULL DEFAULT 'routing', -- 'turning' | 'routing' | 'milling'
  post_processor text, -- Fusion post-processor identifier (milling only, reserved for a future Runner)
  default_material_id uuid,
  default_tool_id uuid,
  default_params jsonb NOT NULL DEFAULT '{}'::jsonb, -- same shape as cam_jobs.params, see src/lib/cam/*.js
  gcode_extension text NOT NULL DEFAULT 'ngc', -- 'ngc' | 'tap' - output file extension for this machine (Mach3/Mach4 controls expect .tap)
  controller text NOT NULL DEFAULT 'linuxcnc', -- 'linuxcnc' | 'wincnc' (routing only - turning always targets the Haas TL-1's Fanuc-dialect control) - see src/lib/cam/routing.js file header for the real dialect differences this switches between
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT cam_machines_pkey PRIMARY KEY (id)
);
ALTER TABLE public.cam_machines ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE public.cam_machines ADD COLUMN IF NOT EXISTS operation_type text NOT NULL DEFAULT 'routing';
ALTER TABLE public.cam_machines ADD COLUMN IF NOT EXISTS post_processor text;
ALTER TABLE public.cam_machines ADD COLUMN IF NOT EXISTS default_material_id uuid;
ALTER TABLE public.cam_machines ADD COLUMN IF NOT EXISTS default_tool_id uuid;
ALTER TABLE public.cam_machines ADD COLUMN IF NOT EXISTS default_params jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.cam_machines ADD COLUMN IF NOT EXISTS gcode_extension text NOT NULL DEFAULT 'ngc';
ALTER TABLE public.cam_machines ADD COLUMN IF NOT EXISTS controller text NOT NULL DEFAULT 'linuxcnc';
ALTER TABLE public.cam_machines ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE public.cam_machines ADD COLUMN IF NOT EXISTS created_by uuid;
ALTER TABLE public.cam_machines ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now();
ALTER TABLE public.cam_machines ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();
DO $$ BEGIN
  ALTER TABLE public.cam_machines ADD CONSTRAINT cam_machines_name_key UNIQUE (name);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.cam_machines ADD CONSTRAINT cam_machines_operation_type_check CHECK (operation_type = ANY (ARRAY['turning'::text, 'routing'::text, 'milling'::text]));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.cam_machines ADD CONSTRAINT cam_machines_gcode_extension_check CHECK (gcode_extension = ANY (ARRAY['ngc'::text, 'tap'::text]));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.cam_machines ADD CONSTRAINT cam_machines_controller_check CHECK (controller = ANY (ARRAY['linuxcnc'::text, 'wincnc'::text]));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.cam_machines ADD CONSTRAINT cam_machines_default_material_id_fkey FOREIGN KEY (default_material_id) REFERENCES public.cam_materials(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.cam_machines ADD CONSTRAINT cam_machines_default_tool_id_fkey FOREIGN KEY (default_tool_id) REFERENCES public.cam_tools(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.cam_machines ADD CONSTRAINT cam_machines_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- ============================================================================
-- CAM JOBS: the queue
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.cam_jobs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text,
  notes text,
  source_type text NOT NULL DEFAULT 'upload',
  part_id bigint,
  step_file_name text,
  operation_type text NOT NULL DEFAULT 'routing',
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  material_id uuid,
  tool_id uuid,
  machine_id uuid,
  status text NOT NULL DEFAULT 'queued',
  claimed_by text,
  claimed_at timestamp with time zone,
  gcode text,
  gcode_file_name text,
  gcode_format text NOT NULL DEFAULT 'ngc',
  errors text[],
  warnings text[],
  stats jsonb,
  progress integer NOT NULL DEFAULT 0, -- 0-100, written incrementally during generation so the UI can show real progress instead of an indefinite spinner
  progress_message text, -- short human-readable stage label, e.g. "Extracting toolpath geometry..."
  requested_by uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT cam_jobs_pkey PRIMARY KEY (id)
);
-- Every column added explicitly too, in case an earlier revision of this
-- table already exists without some of them.
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS name text; -- user-given job name; falls back to the part/file name in the UI when blank
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS notes text; -- free-text operator notes (e.g. "verify stock height before running", "customer wants 2 of these") - purely informational, never read by generation logic
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'upload';
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS part_id bigint;
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS step_file_name text; -- storage path of the STEP file - both the 3D viewer AND CAM generation read this
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS operation_type text NOT NULL DEFAULT 'routing';
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS params jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS material_id uuid;
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS tool_id uuid;
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS machine_id uuid;
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'queued';
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS claimed_by text; -- reserved for a future external Runner (milling only - see autocam-runner/README.md)
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS claimed_at timestamp with time zone;
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS gcode text;
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS gcode_file_name text;
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS gcode_format text NOT NULL DEFAULT 'ngc'; -- must stay 'ngc'
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS errors text[];
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS warnings text[];
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS stats jsonb;
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS progress integer NOT NULL DEFAULT 0;
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS progress_message text;
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS requested_by uuid;
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now();
ALTER TABLE public.cam_jobs ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();
-- A very early revision of this table had a separate `profile_file_name`
-- column before it was merged into `step_file_name` - drop it if present.
ALTER TABLE public.cam_jobs DROP COLUMN IF EXISTS profile_file_name;

DO $$ BEGIN
  ALTER TABLE public.cam_jobs ADD CONSTRAINT cam_jobs_source_type_check CHECK (source_type = ANY (ARRAY['upload'::text, 'part'::text]));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.cam_jobs ADD CONSTRAINT cam_jobs_operation_type_check CHECK (operation_type = ANY (ARRAY['turning'::text, 'routing'::text, 'milling'::text]));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.cam_jobs ADD CONSTRAINT cam_jobs_status_check CHECK (status = ANY (ARRAY['queued'::text, 'claimed'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'rejected'::text]));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.cam_jobs ADD CONSTRAINT cam_jobs_part_id_fkey FOREIGN KEY (part_id) REFERENCES public.parts(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.cam_jobs ADD CONSTRAINT cam_jobs_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.cam_materials(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.cam_jobs ADD CONSTRAINT cam_jobs_tool_id_fkey FOREIGN KEY (tool_id) REFERENCES public.cam_tools(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.cam_jobs ADD CONSTRAINT cam_jobs_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES public.cam_machines(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.cam_jobs ADD CONSTRAINT cam_jobs_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_cam_jobs_status ON public.cam_jobs(status);
CREATE INDEX IF NOT EXISTS idx_cam_jobs_part_id ON public.cam_jobs(part_id);
CREATE INDEX IF NOT EXISTS idx_cam_jobs_created_at ON public.cam_jobs(created_at);

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
ALTER TABLE public.cam_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cam_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cam_machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cam_jobs ENABLE ROW LEVEL SECURITY;

-- Reference tables: readable by any approved user, writable by any
-- authenticated user (mirrors the existing autocam_profiles/autocam_settings
-- policy shape - the manufacturing-lead gate for editing is enforced in the
-- frontend, same as /manufacture/autocam today).
DROP POLICY IF EXISTS "cam_materials_select" ON public.cam_materials;
CREATE POLICY "cam_materials_select" ON public.cam_materials FOR SELECT TO authenticated USING (public.approved_user());
DROP POLICY IF EXISTS "cam_materials_write" ON public.cam_materials;
CREATE POLICY "cam_materials_write" ON public.cam_materials FOR ALL TO authenticated USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "cam_tools_select" ON public.cam_tools;
CREATE POLICY "cam_tools_select" ON public.cam_tools FOR SELECT TO authenticated USING (public.approved_user());
DROP POLICY IF EXISTS "cam_tools_write" ON public.cam_tools;
CREATE POLICY "cam_tools_write" ON public.cam_tools FOR ALL TO authenticated USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "cam_machines_select" ON public.cam_machines;
CREATE POLICY "cam_machines_select" ON public.cam_machines FOR SELECT TO authenticated USING (public.approved_user());
DROP POLICY IF EXISTS "cam_machines_write" ON public.cam_machines;
CREATE POLICY "cam_machines_write" ON public.cam_machines FOR ALL TO authenticated USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

-- Jobs: same approved_user() gate the purchasing/parts tables use.
DROP POLICY IF EXISTS "cam_jobs_select" ON public.cam_jobs;
CREATE POLICY "cam_jobs_select" ON public.cam_jobs FOR SELECT TO authenticated USING (public.approved_user());
DROP POLICY IF EXISTS "cam_jobs_insert" ON public.cam_jobs;
CREATE POLICY "cam_jobs_insert" ON public.cam_jobs FOR INSERT TO authenticated WITH CHECK (public.approved_user());
DROP POLICY IF EXISTS "cam_jobs_update" ON public.cam_jobs;
CREATE POLICY "cam_jobs_update" ON public.cam_jobs FOR UPDATE TO authenticated USING (public.approved_user()) WITH CHECK (public.approved_user());
DROP POLICY IF EXISTS "cam_jobs_delete" ON public.cam_jobs;
CREATE POLICY "cam_jobs_delete" ON public.cam_jobs FOR DELETE TO authenticated USING (public.approved_user());

DROP POLICY IF EXISTS "cam_materials_service_all" ON public.cam_materials;
CREATE POLICY "cam_materials_service_all" ON public.cam_materials TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "cam_tools_service_all" ON public.cam_tools;
CREATE POLICY "cam_tools_service_all" ON public.cam_tools TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "cam_machines_service_all" ON public.cam_machines;
CREATE POLICY "cam_machines_service_all" ON public.cam_machines TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "cam_jobs_service_all" ON public.cam_jobs;
CREATE POLICY "cam_jobs_service_all" ON public.cam_jobs TO service_role USING (true) WITH CHECK (true);

-- ============================================================================
-- TRIGGER: updated_at
-- ============================================================================
CREATE OR REPLACE FUNCTION public.update_cam_studio_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cam_materials_updated_at ON public.cam_materials;
CREATE TRIGGER cam_materials_updated_at BEFORE UPDATE ON public.cam_materials FOR EACH ROW EXECUTE FUNCTION public.update_cam_studio_updated_at();

DROP TRIGGER IF EXISTS cam_tools_updated_at ON public.cam_tools;
CREATE TRIGGER cam_tools_updated_at BEFORE UPDATE ON public.cam_tools FOR EACH ROW EXECUTE FUNCTION public.update_cam_studio_updated_at();

DROP TRIGGER IF EXISTS cam_machines_updated_at ON public.cam_machines;
CREATE TRIGGER cam_machines_updated_at BEFORE UPDATE ON public.cam_machines FOR EACH ROW EXECUTE FUNCTION public.update_cam_studio_updated_at();

DROP TRIGGER IF EXISTS cam_jobs_updated_at ON public.cam_jobs;
CREATE TRIGGER cam_jobs_updated_at BEFORE UPDATE ON public.cam_jobs FOR EACH ROW EXECUTE FUNCTION public.update_cam_studio_updated_at();

-- ============================================================================
-- ACTIVITY LOG INTEGRATION
-- ============================================================================
-- The Admin Activity Log (src/routes/admin/ActivityLogTab.svelte) reads from
-- a generic `activity_log` table, populated by one shared trigger function,
-- public.log_activity() (SECURITY DEFINER, live in Supabase - not checked
-- into this repo, same as the rest of the app's tables already using it:
-- parts, builds, orders, purchasing, vendors, kitting, etc). It logs
-- table_name/operation/row_id/actor plus old/new row jsonb, matching the
-- app-wide zz_activity_log naming convention exactly - confirmed by reading
-- a live example trigger (on public.parts) rather than guessing.
DROP TRIGGER IF EXISTS zz_activity_log ON public.cam_jobs;
CREATE TRIGGER zz_activity_log AFTER INSERT OR UPDATE OR DELETE ON public.cam_jobs
  FOR EACH ROW EXECUTE FUNCTION public.log_activity();

DROP TRIGGER IF EXISTS zz_activity_log ON public.cam_materials;
CREATE TRIGGER zz_activity_log AFTER INSERT OR UPDATE OR DELETE ON public.cam_materials
  FOR EACH ROW EXECUTE FUNCTION public.log_activity();

DROP TRIGGER IF EXISTS zz_activity_log ON public.cam_tools;
CREATE TRIGGER zz_activity_log AFTER INSERT OR UPDATE OR DELETE ON public.cam_tools
  FOR EACH ROW EXECUTE FUNCTION public.log_activity();

DROP TRIGGER IF EXISTS zz_activity_log ON public.cam_machines;
CREATE TRIGGER zz_activity_log AFTER INSERT OR UPDATE OR DELETE ON public.cam_machines
  FOR EACH ROW EXECUTE FUNCTION public.log_activity();

-- ============================================================================
-- DRIVE WATCHER (scaffolding - see autocam/docs/drive-watcher-cron-plan.md)
-- ============================================================================
-- Auto-triggers a CAM job when a STEP file lands in a Google Drive folder
-- mapped to a machine profile. Schema/endpoint/UI (src/lib/server/drive_watcher.js,
-- src/routes/api/drive-watcher/+server.js) are built and safe to ship with
-- zero configuration - the sweep is a deliberate no-op until a real Google
-- service-account key (GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY env var) and at
-- least one cam_machines.drive_folder_id are set. No pg_cron schedule is
-- created by this file - see the comment at the bottom of this section for
-- why, and the exact SQL to run once real credentials exist.

ALTER TABLE public.cam_machines ADD COLUMN IF NOT EXISTS drive_folder_id text; -- INPUT: Google Drive folder ID this machine auto-triggers a job from when a STEP file lands in it; null = auto-trigger disabled for this machine
ALTER TABLE public.cam_machines ADD COLUMN IF NOT EXISTS drive_output_folder_id text; -- OUTPUT: Google Drive folder ID a completed job's G-code gets written to (any job on this machine, not just Drive-triggered ones) - pairs with a Drive desktop sync client on the machine's control PC so the file appears locally with no manual download; null = no auto-delivery for this machine. Deliberately a SEPARATE folder from drive_folder_id (see autocam/docs/direct-machine-file-transfer-plan.md) so the input watcher never mistakes its own output for a new STEP file to process.

CREATE TABLE IF NOT EXISTS public.drive_watcher_state (
  folder_id text NOT NULL,
  page_token text, -- Drive Changes API resumable cursor; null = never swept yet, next sweep calls changes.getStartPageToken
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT drive_watcher_state_pkey PRIMARY KEY (folder_id)
);

CREATE TABLE IF NOT EXISTS public.drive_watcher_files (
  drive_file_id text NOT NULL,
  cam_job_id uuid,
  processed_at timestamp with time zone DEFAULT now(),
  status text NOT NULL DEFAULT 'queued', -- 'processing' | 'queued' | 'failed' - reservation/idempotency/audit trail
  error text,
  CONSTRAINT drive_watcher_files_pkey PRIMARY KEY (drive_file_id)
);
ALTER TABLE public.drive_watcher_files ADD COLUMN IF NOT EXISTS cam_job_id uuid;
ALTER TABLE public.drive_watcher_files ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'queued';
ALTER TABLE public.drive_watcher_files ADD COLUMN IF NOT EXISTS error text;
DO $$ BEGIN
  ALTER TABLE public.drive_watcher_files ADD CONSTRAINT drive_watcher_files_cam_job_id_fkey FOREIGN KEY (cam_job_id) REFERENCES public.cam_jobs(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

ALTER TABLE public.drive_watcher_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drive_watcher_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "drive_watcher_state_select" ON public.drive_watcher_state;
CREATE POLICY "drive_watcher_state_select" ON public.drive_watcher_state FOR SELECT TO authenticated USING (public.approved_user());
DROP POLICY IF EXISTS "drive_watcher_state_service_all" ON public.drive_watcher_state;
CREATE POLICY "drive_watcher_state_service_all" ON public.drive_watcher_state TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "drive_watcher_files_select" ON public.drive_watcher_files;
CREATE POLICY "drive_watcher_files_select" ON public.drive_watcher_files FOR SELECT TO authenticated USING (public.approved_user());
DROP POLICY IF EXISTS "drive_watcher_files_service_all" ON public.drive_watcher_files;
CREATE POLICY "drive_watcher_files_service_all" ON public.drive_watcher_files TO service_role USING (true) WITH CHECK (true);

-- Deliberately NOT applied here (needs real Vault secrets this environment
-- doesn't have). The final activation step, once Google credentials exist:
--
--   1. Store secrets in Supabase Vault: drive_watcher_app_url (this app's
--      base URL), drive_watcher_cron_token (matches DRIVE_WATCHER_CRON_TOKEN
--      or CRON_SECRET in the app's own env vars - see cron_auth.js, which
--      the new endpoint reuses as-is).
--   2. CREATE a Postgres function public.invoke_drive_watcher_cron(),
--      near-identical to invoke_planner_notification_cron() - reads the two
--      secrets above from Vault, pg_net.http_post()'s to
--      {app_url}/api/drive-watcher with an Authorization: Bearer
--      {cron_token} header.
--   3. SELECT cron.schedule('drive-watcher-sweep', '*/5 * * * *',
--      'SELECT public.invoke_drive_watcher_cron();'); -- every 5 min is a
--      starting guess, not a measured choice - see the plan doc's open
--      question #2 (how fast a dropped file actually needs to be picked up).

-- ============================================================================
-- SEED DATA (idempotent - ON CONFLICT (name) needs the UNIQUE constraints above)
-- ============================================================================
INSERT INTO public.cam_materials (name, category) VALUES
  ('Aluminum 6061', 'aluminum'),
  ('Polycarbonate (Lexan)', 'polycarbonate'),
  ('Baltic Birch Plywood', 'plywood'),
  ('Delrin (Acetal)', 'delrin')
ON CONFLICT (name) DO NOTHING;

-- Machine profiles. Defaults are reasonable starting points (documented as
-- such in the generators themselves) - edit them from the AutoCAM "Manage
-- Profiles" panel once real values for these machines are known.
-- 971 Lathe = Haas TL-1 (Fanuc-dialect - turning.js's only target, no
-- controller switch needed). UNC Router = LinuxCNC. New Router = a real
-- ShopSabre Pro 408, which runs WinCNC - a genuinely different G-code
-- dialect (see routing.js file header) - hence controller='wincnc' and
-- gcode_extension='tap' (WinCNC's own conventional output extension).
INSERT INTO public.cam_machines (name, description, operation_type, controller, gcode_extension, default_params) VALUES
  ('971 Lathe', 'Haas TL-1', 'turning', 'linuxcnc', 'ngc', '{
    "stepDown": 0.05, "finishAllowance": 0.02, "feedRough": 0.008,
    "feedFinish": 0.004, "surfaceSpeed": 150, "maxRpm": 2500
  }'::jsonb),
  ('UNC Router', 'LinuxCNC router', 'routing', 'linuxcnc', 'ngc', '{
    "toolDiameter": 0.25, "stepDown": 0.1, "tabWidth": 0.25, "tabHeight": 0.06,
    "tabSpacing": 6, "feedRate": 40, "plungeRate": 15, "spindleSpeed": 16000
  }'::jsonb),
  ('New Router', 'ShopSabre Pro 408 (WinCNC control)', 'routing', 'wincnc', 'tap', '{
    "toolDiameter": 0.25, "stepDown": 0.1, "tabWidth": 0.25, "tabHeight": 0.06,
    "tabSpacing": 6, "feedRate": 40, "plungeRate": 15, "spindleSpeed": 16000
  }'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- The rows above may already have existed (ON CONFLICT DO NOTHING) with an
-- older, wrong controller/extension from before this machine identification
-- was confirmed - fix them in place too, idempotently.
UPDATE public.cam_machines SET controller = 'wincnc', gcode_extension = 'tap', description = 'ShopSabre Pro 408 (WinCNC control)' WHERE name = 'New Router';
UPDATE public.cam_machines SET description = 'LinuxCNC router' WHERE name = 'UNC Router' AND (description IS NULL OR description = 'Router #1');
