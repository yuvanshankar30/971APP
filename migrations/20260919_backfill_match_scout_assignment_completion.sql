-- Match reports submitted before assignment completion was wired into the
-- Match Scouting form already prove that the assigned scout finished the
-- work. Preserve the assignment row for Home history and backfill only its
-- completion timestamp; nothing is deleted.
WITH report_evidence AS (
  SELECT
    created_by,
    event_key,
    team_key,
    CASE
      WHEN match_key LIKE '%\_%' ESCAPE '\' THEN lower(split_part(match_key, '_', 2))
      WHEN match_key ~* '^(qm|qf|sf|f)[0-9]' THEN lower(match_key)
      ELSE 'qm' || lower(match_key)
    END AS assignment_match_suffix,
    max(coalesce(updated_at, created_at, now())) AS completed_at
  FROM public.match_scout_entries
  WHERE created_by IS NOT NULL
  GROUP BY created_by, event_key, team_key, assignment_match_suffix
)
UPDATE public.scout_match_assignments AS assignment
SET completed_at = evidence.completed_at
FROM report_evidence AS evidence
WHERE assignment.scouting_type = 'data'
  AND assignment.completed_at IS NULL
  AND assignment.assigned_user = evidence.created_by
  AND assignment.team_key = evidence.team_key
  AND split_part(assignment.match_key, '_', 1) = evidence.event_key
  AND lower(split_part(assignment.match_key, '_', 2)) = evidence.assignment_match_suffix;
