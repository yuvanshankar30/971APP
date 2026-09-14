-- Standalone web port of the shop's JProg nesting workspace.  It deliberately
-- has no AutoCAM/Fusion-job foreign keys: nesting owns manual sheet placement
-- and G-code emission independently.
CREATE TABLE IF NOT EXISTS nesting_sheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  width_in numeric NOT NULL CHECK (width_in > 0),
  height_in numeric NOT NULL CHECK (height_in > 0),
  thickness_key text NOT NULL DEFAULT '0.125',
  active_cut_id uuid,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nesting_cuts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id uuid NOT NULL REFERENCES nesting_sheets(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE nesting_sheets DROP CONSTRAINT IF EXISTS nesting_sheets_active_cut_id_fkey;
ALTER TABLE nesting_sheets
  ADD CONSTRAINT nesting_sheets_active_cut_id_fkey
  FOREIGN KEY (active_cut_id) REFERENCES nesting_cuts(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS nesting_placements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cut_id uuid NOT NULL REFERENCES nesting_cuts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('part', 'hole')),
  part_library_path text,
  label text NOT NULL DEFAULT '',
  x numeric NOT NULL,
  y numeric NOT NULL,
  rotation numeric NOT NULL DEFAULT 0,
  width_in numeric NOT NULL DEFAULT 0,
  height_in numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nesting_emissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cut_id uuid NOT NULL REFERENCES nesting_cuts(id) ON DELETE CASCADE,
  suffix text NOT NULL DEFAULT '',
  dialect text NOT NULL CHECK (dialect IN ('linuxcnc', 'wincnc')),
  output_storage_path text NOT NULL,
  tool_order jsonb NOT NULL DEFAULT '[]'::jsonb,
  emitted_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE nesting_sheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE nesting_cuts ENABLE ROW LEVEL SECURITY;
ALTER TABLE nesting_placements ENABLE ROW LEVEL SECURITY;
ALTER TABLE nesting_emissions ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['nesting_sheets','nesting_cuts','nesting_placements','nesting_emissions'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS nesting_%s_authenticated ON %I', table_name, table_name);
    EXECUTE format('CREATE POLICY nesting_%s_authenticated ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)', table_name, table_name);
  END LOOP;
END $$;
