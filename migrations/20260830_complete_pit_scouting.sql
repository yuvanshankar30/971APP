-- Complete the durable pit profile used by the Pit Scouting workspace and
-- Power Rankings. Existing rows remain valid and gain neutral null values.

ALTER TABLE public.pit_scout_entries
  ADD COLUMN IF NOT EXISTS robot_archetype text,
  ADD COLUMN IF NOT EXISTS additional_notes text;

ALTER TABLE public.pit_scout_entries
  DROP CONSTRAINT IF EXISTS pit_scout_entries_robot_archetype_check;

ALTER TABLE public.pit_scout_entries
  DROP CONSTRAINT IF EXISTS pit_scout_entries_additional_notes_length_check;

ALTER TABLE public.pit_scout_entries
  ADD CONSTRAINT pit_scout_entries_robot_archetype_check
  CHECK (
    robot_archetype IS NULL OR robot_archetype IN (
      'Shooter',
      'Shuttler',
      'Defender',
      'Climber',
      'Hybrid',
      'Support / Feeder',
      'Unknown'
    )
  );

ALTER TABLE public.pit_scout_entries
  ADD CONSTRAINT pit_scout_entries_additional_notes_length_check
  CHECK (additional_notes IS NULL OR length(additional_notes) <= 4000);
