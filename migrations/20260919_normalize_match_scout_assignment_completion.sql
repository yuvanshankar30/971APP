-- Match Scouting historically accepted human-readable keys ("Quals 1",
-- "Qual 1") as well as bare numbers and TBA keys. Normalize all of those to
-- one suffix before comparing reports with assignments. Assignment rows are
-- retained; completion only fills completed_at.
CREATE OR REPLACE FUNCTION public.normalize_match_scout_suffix(raw_match_key text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public
AS $$
DECLARE
  suffix text := lower(trim(regexp_replace(raw_match_key, '^.*_', '')));
  captured text[];
BEGIN
  suffix := regexp_replace(suffix, '\s+', ' ', 'g');

  IF suffix ~ '^(qm|ef|qf|sf|f)\s*[0-9]+(m[0-9]+)?$' THEN
    captured := regexp_match(suffix, '^(qm|ef|qf|sf|f)\s*([0-9]+)(?:m([0-9]+))?$');
    RETURN captured[1] || (captured[2]::integer)::text ||
      CASE WHEN captured[3] IS NULL THEN '' ELSE 'm' || (captured[3]::integer)::text END;
  END IF;

  IF suffix ~ '^[0-9]+$' THEN
    RETURN 'qm' || (suffix::integer)::text;
  END IF;

  captured := regexp_match(suffix, 'qual(?:ification|ifier|s)?\s*[-#:]?\s*([0-9]+)');
  IF captured IS NOT NULL THEN
    RETURN 'qm' || (captured[1]::integer)::text;
  END IF;

  captured := regexp_match(suffix, 'quarter\s*final\s*([0-9]+)\s*(?:match|m)\s*([0-9]+)');
  IF captured IS NOT NULL THEN RETURN 'qf' || (captured[1]::integer)::text || 'm' || (captured[2]::integer)::text; END IF;
  captured := regexp_match(suffix, 'semi\s*final\s*([0-9]+)\s*(?:match|m)\s*([0-9]+)');
  IF captured IS NOT NULL THEN RETURN 'sf' || (captured[1]::integer)::text || 'm' || (captured[2]::integer)::text; END IF;
  captured := regexp_match(suffix, 'octo\s*final\s*([0-9]+)\s*(?:match|m)\s*([0-9]+)');
  IF captured IS NOT NULL THEN RETURN 'ef' || (captured[1]::integer)::text || 'm' || (captured[2]::integer)::text; END IF;
  captured := regexp_match(suffix, '(?:^|\s)finals?\s*[-#:]?\s*([0-9]+)');
  IF captured IS NOT NULL THEN RETURN 'f1m' || (captured[1]::integer)::text; END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.normalize_match_scout_suffix(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.complete_match_scout_assignment_from_report()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.scout_match_assignments
  SET completed_at = coalesce(NEW.updated_at, NEW.created_at, now())
  WHERE scouting_type = 'data'
    AND completed_at IS NULL
    AND assigned_user = NEW.created_by
    AND regexp_replace(lower(team_key), '^frc', '') = regexp_replace(lower(NEW.team_key), '^frc', '')
    AND lower(split_part(match_key, '_', 1)) = lower(NEW.event_key)
    AND public.normalize_match_scout_suffix(match_key) = public.normalize_match_scout_suffix(NEW.match_key);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_match_scout_assignment_from_report() FROM PUBLIC, anon, authenticated;

WITH report_evidence AS (
  SELECT created_by,
    lower(event_key) AS event_key,
    regexp_replace(lower(team_key), '^frc', '') AS team_number,
    public.normalize_match_scout_suffix(match_key) AS match_suffix,
    max(coalesce(updated_at, created_at, now())) AS completed_at
  FROM public.match_scout_entries
  WHERE created_by IS NOT NULL
    AND public.normalize_match_scout_suffix(match_key) IS NOT NULL
  GROUP BY created_by, lower(event_key), regexp_replace(lower(team_key), '^frc', ''), public.normalize_match_scout_suffix(match_key)
)
UPDATE public.scout_match_assignments AS assignment
SET completed_at = evidence.completed_at
FROM report_evidence AS evidence
WHERE assignment.scouting_type = 'data'
  AND assignment.completed_at IS NULL
  AND assignment.assigned_user = evidence.created_by
  AND regexp_replace(lower(assignment.team_key), '^frc', '') = evidence.team_number
  AND lower(split_part(assignment.match_key, '_', 1)) = evidence.event_key
  AND public.normalize_match_scout_suffix(assignment.match_key) = evidence.match_suffix;
