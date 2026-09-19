-- One robot in one match has one shared open ACE issue, even when multiple
-- scouts report it. Each scout's observation remains separately editable.
ALTER TABLE public.pit_problem_reports
  ADD COLUMN IF NOT EXISTS scout_observations jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS slack_last_payload text;

-- Each team with an issue gets one durable Slack parent per competition.
-- Every later report/edit/resolution is a reply in that team's thread.
CREATE TABLE IF NOT EXISTS public.ace_pit_slack_threads (
  event_key text NOT NULL,
  team_key text NOT NULL,
  channel text NOT NULL,
  root_ts text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_key, team_key)
);

ALTER TABLE public.ace_pit_slack_threads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ace_pit_slack_threads FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.ace_pit_slack_threads TO service_role;

-- Preserve every old per-report message coordinate before duplicate database
-- rows are consolidated. The notifier consumes this queue when it creates the
-- replacement team thread, so no legacy bot message is orphaned in Slack.
CREATE TABLE IF NOT EXISTS public.ace_pit_slack_legacy_messages (
  event_key text NOT NULL,
  team_key text NOT NULL,
  channel text NOT NULL,
  message_ts text NOT NULL,
  PRIMARY KEY (channel, message_ts)
);

ALTER TABLE public.ace_pit_slack_legacy_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ace_pit_slack_legacy_messages FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.ace_pit_slack_legacy_messages TO service_role;

INSERT INTO public.ace_pit_slack_legacy_messages (event_key, team_key, channel, message_ts)
SELECT event_key, team_key, slack_channel, slack_ts
FROM public.pit_problem_reports
WHERE slack_channel IS NOT NULL AND slack_ts IS NOT NULL
ON CONFLICT (channel, message_ts) DO NOTHING;

UPDATE public.pit_problem_reports AS problem
SET scout_observations = jsonb_build_array(jsonb_build_object(
  'created_by', problem.created_by,
  'scout_name', coalesce(profile.full_name, profile.email, 'Match Scout'),
  'summary', problem.summary,
  'detail', problem.detail,
  'severity', problem.severity,
  'reported_at', problem.created_at
))
FROM public.user_profiles AS profile
WHERE problem.created_by = profile.id
  AND problem.scout_observations = '[]'::jsonb;

UPDATE public.pit_problem_reports AS problem
SET scout_observations = jsonb_build_array(jsonb_build_object(
  'created_by', problem.created_by,
  'scout_name', 'Match Scout',
  'summary', problem.summary,
  'detail', problem.detail,
  'severity', problem.severity,
  'reported_at', problem.created_at
))
WHERE problem.scout_observations = '[]'::jsonb;

-- Prefer the row that already owns a Slack message as the survivor. The
-- current duplicate rows are merged before the partial unique index is added.
WITH ranked AS (
  SELECT id,
    first_value(id) OVER (
      PARTITION BY event_key, team_key, match_key, source
      ORDER BY (slack_ts IS NOT NULL) DESC, created_at ASC, id
    ) AS survivor_id
  FROM public.pit_problem_reports
  WHERE resolved = false AND source = 'Match scout'
), merged AS (
  SELECT ranked.survivor_id,
    jsonb_agg(observation.value ORDER BY duplicate.created_at, observation.ordinality) AS observations
  FROM ranked
  JOIN public.pit_problem_reports AS duplicate ON duplicate.id = ranked.id
  CROSS JOIN LATERAL jsonb_array_elements(duplicate.scout_observations) WITH ORDINALITY AS observation(value, ordinality)
  GROUP BY ranked.survivor_id
), combined AS (
  SELECT merged.survivor_id, merged.observations,
    jsonb_array_length(merged.observations) AS scout_count,
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(merged.observations) AS item
      WHERE item->>'severity' = 'urgent'
    ) AS urgent,
    (
      SELECT string_agg(
        coalesce(item->>'scout_name', 'Match Scout') || ': ' || coalesce(item->>'summary', 'Mechanical issue flagged after match') ||
        CASE WHEN nullif(item->>'detail', '') IS NULL THEN '' ELSE ' — ' || (item->>'detail') END,
        E'\n'
      )
      FROM jsonb_array_elements(merged.observations) AS item
    ) AS combined_detail
  FROM merged
)
UPDATE public.pit_problem_reports AS survivor
SET scout_observations = combined.observations,
    summary = CASE WHEN combined.scout_count = 1
      THEN combined.observations->0->>'summary'
      ELSE combined.scout_count || ' scouts reported issues for this robot' END,
    detail = combined.combined_detail,
    severity = CASE WHEN combined.urgent THEN 'urgent' ELSE 'watch' END
FROM combined
WHERE survivor.id = combined.survivor_id;

WITH ranked AS (
  SELECT id,
    first_value(id) OVER (
      PARTITION BY event_key, team_key, match_key, source
      ORDER BY (slack_ts IS NOT NULL) DESC, created_at ASC, id
    ) AS survivor_id
  FROM public.pit_problem_reports
  WHERE resolved = false AND source = 'Match scout'
)
DELETE FROM public.pit_problem_reports AS duplicate
USING ranked
WHERE duplicate.id = ranked.id
  AND ranked.id <> ranked.survivor_id;

CREATE UNIQUE INDEX IF NOT EXISTS pit_problem_reports_one_open_match_issue_idx
  ON public.pit_problem_reports (event_key, team_key, match_key, source)
  WHERE resolved = false AND source = 'Match scout';
