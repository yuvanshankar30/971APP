-- The app's Robot Role field has always been free text ("e.g. shooter,
-- shuttler, hybrid" placeholder, plain <input>, 80-char maxlength) - it
-- never matched pit_scout_entries_robot_archetype_check's fixed capitalized
-- enum. Real pit scouting data collected during Chezy Champs ("hybrid",
-- "scoring", "scorer", "shootinf", etc.) proved that mismatch: every one of
-- those submissions would have been rejected by Postgres with a raw
-- constraint-violation error.
--
-- shooter_type/hopper_type/drivebase_type separately grew beyond their
-- original DB CHECK lists this same session: Hopper's <select> now also
-- offers Floor roller/Passive roller/Other, and all three fields gained a
-- write-in "Other" that saves the scout's own typed text (not the literal
-- word "Other") once selected. The old fixed-enum constraints only ever
-- matched the original, narrower option lists and would reject every one of
-- those too - confirmed live by real pit data ("Floor roller" hopper,
-- "Dumper"/"drum shooter" shooters) the DB would have rejected outright.
--
-- All four constraints are dropped so the DB matches what the UI actually
-- collects; length is already bounded client and server-side (sanitizeLongText
-- / maxlength on each input).
ALTER TABLE public.pit_scout_entries DROP CONSTRAINT IF EXISTS pit_scout_entries_robot_archetype_check;
ALTER TABLE public.pit_scout_entries DROP CONSTRAINT IF EXISTS pit_scout_entries_shooter_check;
ALTER TABLE public.pit_scout_entries DROP CONSTRAINT IF EXISTS pit_scout_entries_hopper_check;
ALTER TABLE public.pit_scout_entries DROP CONSTRAINT IF EXISTS pit_scout_entries_drivebase_check;
