-- Keep assignment completion correct even when an older browser bundle submits
-- a report without calling /api/scout-assignments. The assignment is retained
-- as Home history; only completed_at is filled.
CREATE OR REPLACE FUNCTION public.complete_match_scout_assignment_from_report()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  assignment_match_suffix text;
BEGIN
  assignment_match_suffix := CASE
    WHEN NEW.match_key LIKE '%\_%' ESCAPE '\' THEN lower(split_part(NEW.match_key, '_', 2))
    WHEN NEW.match_key ~* '^(qm|qf|sf|f)[0-9]' THEN lower(NEW.match_key)
    ELSE 'qm' || lower(NEW.match_key)
  END;

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

REVOKE ALL ON FUNCTION public.complete_match_scout_assignment_from_report() FROM PUBLIC;

DROP TRIGGER IF EXISTS match_scout_entry_completes_assignment
ON public.match_scout_entries;

CREATE TRIGGER match_scout_entry_completes_assignment
AFTER INSERT OR UPDATE OF event_key, match_key, team_key, created_by
ON public.match_scout_entries
FOR EACH ROW
EXECUTE FUNCTION public.complete_match_scout_assignment_from_report();

-- Close the race between the earlier one-time backfill and installing this
-- trigger. This is deliberately repeatable and never touches completed rows.
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
