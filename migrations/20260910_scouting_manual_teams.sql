-- Manually-added team keys for the active scouting event, so admins can
-- prescout teams before an event's official roster exists on TBA.

ALTER TABLE public.scouting_settings
ADD COLUMN IF NOT EXISTS manual_teams text[] NOT NULL DEFAULT '{}'::text[];
