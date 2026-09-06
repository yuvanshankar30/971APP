-- Fusion Data Panel folder tree cache
-- Backs the folder picker shown when queueing a plate CAM job (Plates tab):
-- rather than a fixed drop folder, a user can pick where the saved Fusion
-- document goes. The web app has no live connection to Fusion's Data
-- Panel - only a Runner (a real Fusion 360 instance) can see it - so a
-- Runner periodically pushes a read-only snapshot of the folder tree here
-- (see dropFolder.py's list_data_folder_tree() and the "sync-folders"
-- action on /api/fusion-runner) and the UI reads the cache, not Fusion
-- directly. One row per Data Panel project; whichever Runner synced last
-- wins, which is fine - it's the same real Data Panel either way.
--
-- SAFE TO RE-RUN: same idempotent pattern as the other fusion_ migrations.

CREATE TABLE IF NOT EXISTS public.fusion_data_folders (
  project_name text PRIMARY KEY,
  tree jsonb NOT NULL,
  synced_by text,
  synced_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.fusion_data_folders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fusion_data_folders_select" ON public.fusion_data_folders;
CREATE POLICY "fusion_data_folders_select" ON public.fusion_data_folders FOR SELECT TO authenticated USING (public.approved_user());
