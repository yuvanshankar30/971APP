-- Keep historical brownout/unknown reports valid while adding Stopped.
ALTER TABLE public.match_scout_entries
  DROP CONSTRAINT IF EXISTS match_scout_entries_teleop_robot_status_check;
ALTER TABLE public.match_scout_entries
  ADD CONSTRAINT match_scout_entries_teleop_robot_status_check
  CHECK (teleop_robot_status IN ('active', 'dead', 'stopped', 'brownout', 'unknown'));
