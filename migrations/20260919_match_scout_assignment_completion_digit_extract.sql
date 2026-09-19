-- The completion trigger/backfill added in
-- 20260919_match_scout_assignment_completion_sync.sql derived a qm-suffix by
-- gluing "qm" onto match_key verbatim when it wasn't already prefixed or
-- underscore-delimited. That's fine for a clean "9", but Match #'s field is
-- free text - real scouts type "Quals 9", "Qual 4", "Q9", etc (see the
-- historical match_scout_entries rows) - and those became garbage suffixes
-- like "qmquals 9" that never match a real assignment's "qm9". Extract the
-- first run of digits instead, so any of those spellings resolves the same
-- match number.
CREATE OR REPLACE FUNCTION public.complete_match_scout_assignment_from_report()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  assignment_match_suffix text;
  match_digits text;
BEGIN
  IF NEW.match_key LIKE '%\_%' ESCAPE '\' THEN
    assignment_match_suffix := lower(split_part(NEW.match_key, '_', 2));
  ELSIF NEW.match_key ~* '^(qm|qf|sf|f)[0-9]' THEN
    assignment_match_suffix := lower(NEW.match_key);
  ELSE
    match_digits := (regexp_match(NEW.match_key, '[0-9]+'))[1];
    assignment_match_suffix := CASE WHEN match_digits IS NOT NULL THEN 'qm' || match_digits ELSE NULL END;
  END IF;

  IF assignment_match_suffix IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.scout_match_assignments
  SET completed_at = coalesce(NEW.updated_at, NEW.created_at, now())
  WHERE scouting_type = 'data'
    AND completed_at IS NULL
    AND assigned_user = NEW.created_by
    AND team_key = NEW.team_key
    AND split_part(match_key, '_', 1) = NEW.event_key
    AND lower(split_part(match_key, '_', 2)) = assignment_match_suffix;

  RETURN NEW;
END;
$$;

-- Re-sweep with the corrected suffix derivation - repeatable, never touches
-- an already-completed row, so this is safe to run again in dev/staging.
WITH report_evidence AS (
  SELECT
    created_by,
    event_key,
    team_key,
    CASE
      WHEN match_key LIKE '%\_%' ESCAPE '\' THEN lower(split_part(match_key, '_', 2))
      WHEN match_key ~* '^(qm|qf|sf|f)[0-9]' THEN lower(match_key)
      WHEN (regexp_match(match_key, '[0-9]+'))[1] IS NOT NULL THEN 'qm' || (regexp_match(match_key, '[0-9]+'))[1]
      ELSE NULL
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
  AND evidence.assignment_match_suffix IS NOT NULL
  AND lower(split_part(assignment.match_key, '_', 2)) = evidence.assignment_match_suffix;
