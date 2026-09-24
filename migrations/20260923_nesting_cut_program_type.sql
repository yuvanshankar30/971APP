-- Feature request: different cuts on the same sheet should be able to emit
-- different G-code types (LinuxCNC .ngc vs WinCNC .tap). This was already
-- safe at the emission level - nesting_emissions has always recorded
-- `dialect` per cut_id, and buildEmissions() in +page.svelte already emits
-- each cut as its own independent G-code document with its own
-- preamble/postamble/bracket style. The only thing actually locking a whole
-- sheet to one program type was program_extension living on nesting_sheets:
-- assertProgramTypeCompatible() gated every part placement against the
-- sheet-wide value regardless of which cut the part was being added to.
--
-- Fix: move program_extension down to nesting_cuts, one per cut, backfilled
-- from the sheet's current value so existing sheets/cuts keep behaving
-- exactly as before. Then drop it from nesting_sheets - nothing should read
-- it there anymore.

ALTER TABLE nesting_cuts
  ADD COLUMN IF NOT EXISTS program_extension text
  CHECK (program_extension IN ('ngc', 'tap'));

-- Guarded so this stays rerunnable: the second run finds nesting_sheets no
-- longer has the column and skips straight past.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'nesting_sheets' AND column_name = 'program_extension'
  ) THEN
    UPDATE nesting_cuts
    SET program_extension = nesting_sheets.program_extension
    FROM nesting_sheets
    WHERE nesting_sheets.id = nesting_cuts.sheet_id
      AND nesting_cuts.program_extension IS NULL
      AND nesting_sheets.program_extension IS NOT NULL;

    ALTER TABLE nesting_sheets DROP COLUMN program_extension;
  END IF;
END $$;
