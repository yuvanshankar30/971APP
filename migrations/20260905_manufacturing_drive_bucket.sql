-- Storage bucket backing the new "Files" tab on /manufacture - a general-
-- purpose shared file/folder holder for the manufacturing team (G-code,
-- reference docs, whatever needs a shared drop spot that isn't tied to a
-- specific part/request). Deliberately a separate bucket from
-- manufacturing-files (that one is STEP files attached to a specific part -
-- see fusion_parts.step_file_name/parts flows) - this one has no owning
-- row at all, it's just a drive.
--
-- No separate folders table: Storage's own list() API already returns
-- folder-like entries for a given prefix (an entry with id = null, one per
-- distinct next path segment) - a real DB table here would just be
-- duplicating what Storage already tracks. An empty folder is represented
-- by a hidden ".emptyFolderPlaceholder" object under that prefix, the same
-- convention Supabase's own dashboard uses when you click "create folder" -
-- so a folder created here also shows up correctly if someone browses the
-- bucket from the Supabase dashboard directly.
--
-- Same 4-policy shape as task-files (20260310_tasks_system.sql) - any
-- authenticated team member can read/write/delete any file, no per-row
-- ownership check, matching how a shared team drive should behave.

INSERT INTO storage.buckets (id, name, public)
VALUES ('manufacturing-drive', 'manufacturing-drive', false)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'manufacturing_drive_select_authenticated'
  ) THEN
    EXECUTE 'CREATE POLICY manufacturing_drive_select_authenticated ON storage.objects FOR SELECT TO authenticated USING (bucket_id = ''manufacturing-drive'')';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'manufacturing_drive_insert_authenticated'
  ) THEN
    EXECUTE 'CREATE POLICY manufacturing_drive_insert_authenticated ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = ''manufacturing-drive'')';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'manufacturing_drive_update_authenticated'
  ) THEN
    EXECUTE 'CREATE POLICY manufacturing_drive_update_authenticated ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = ''manufacturing-drive'') WITH CHECK (bucket_id = ''manufacturing-drive'')';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'manufacturing_drive_delete_authenticated'
  ) THEN
    EXECUTE 'CREATE POLICY manufacturing_drive_delete_authenticated ON storage.objects FOR DELETE TO authenticated USING (bucket_id = ''manufacturing-drive'')';
  END IF;
END $$;
