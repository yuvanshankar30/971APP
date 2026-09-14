ALTER TABLE nesting_sheets
  ADD COLUMN IF NOT EXISTS program_extension text
  CHECK (program_extension IN ('ngc', 'tap'));
