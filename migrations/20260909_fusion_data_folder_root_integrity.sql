-- A cached Fusion Data Panel tree is only valid when its root agrees with
-- the project name used as its key. Older Runner versions could fall back to
-- Fusion's active project during startup and store that unrelated tree under
-- "2026 Season CAM", making the web picker look rooted at AutoCAM.
--
-- The Runner and API now reject that mismatch. Remove any old poisoned cache
-- rows once so the UI waits for the next verified Runner sync instead.

DELETE FROM public.fusion_data_folders
WHERE COALESCE(tree->>'name', '') <> project_name;
