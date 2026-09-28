-- The budget categories a purchase can be filed under, as the team's real
-- budget actually splits: Manufacturing, Electrical, Software, Third Robot,
-- Superpit, Field.
--
-- These used to be a hardcoded list in three separate .svelte files, which
-- meant two things the shop actually felt: the lists drifted apart from each
-- other, and nobody could add a category without a code change and a deploy.
-- Direct instruction: anyone may add one, and when they do it has to show up
-- for everyone else - which makes this shared data, not a constant.
CREATE TABLE IF NOT EXISTS public.purchasing_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Matched against purchasing.project_id, which is plain text, so the name
  -- IS the key a purchase is filed under. Unique and case-insensitive so
  -- "Field" and "field" can't become two categories that split one budget.
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS purchasing_categories_name_lower_idx
  ON public.purchasing_categories (lower(name));

ALTER TABLE public.purchasing_categories ENABLE ROW LEVEL SECURITY;

-- Readable by anyone who can see the purchasing page at all - the dropdown
-- is useless to someone who can file a purchase but can't load the options.
-- Mirrors purchasing_select_authenticated exactly.
DROP POLICY IF EXISTS purchasing_categories_select_authenticated ON public.purchasing_categories;
CREATE POLICY purchasing_categories_select_authenticated
  ON public.purchasing_categories FOR SELECT
  USING (approved_user() OR has_any_permission(ARRAY['PLACE_ORDERS_MISC', 'APPROVE_PURCHASES', 'EDIT_BUDGETS']));

-- Anyone who can file a purchase can add a category, per the same direct
-- instruction - the alternative is people filing things under the wrong
-- category because the right one doesn't exist yet.
DROP POLICY IF EXISTS purchasing_categories_insert_authenticated ON public.purchasing_categories;
CREATE POLICY purchasing_categories_insert_authenticated
  ON public.purchasing_categories FOR INSERT
  WITH CHECK (approved_user() OR has_any_permission(ARRAY['PLACE_ORDERS_MISC', 'APPROVE_PURCHASES', 'EDIT_BUDGETS']));

-- Renaming or deleting one is different: every purchase already filed under
-- that name keeps the old text, so it silently splits a budget in two. Kept
-- to the same people who can edit the budgets themselves.
DROP POLICY IF EXISTS purchasing_categories_update_authenticated ON public.purchasing_categories;
CREATE POLICY purchasing_categories_update_authenticated
  ON public.purchasing_categories FOR UPDATE
  USING (has_any_permission(ARRAY['APPROVE_PURCHASES', 'EDIT_BUDGETS']))
  WITH CHECK (has_any_permission(ARRAY['APPROVE_PURCHASES', 'EDIT_BUDGETS']));

DROP POLICY IF EXISTS purchasing_categories_delete_authenticated ON public.purchasing_categories;
CREATE POLICY purchasing_categories_delete_authenticated
  ON public.purchasing_categories FOR DELETE
  USING (has_any_permission(ARRAY['APPROVE_PURCHASES', 'EDIT_BUDGETS']));

DROP POLICY IF EXISTS purchasing_categories_service_all ON public.purchasing_categories;
CREATE POLICY purchasing_categories_service_all
  ON public.purchasing_categories FOR ALL
  USING (true) WITH CHECK (true);

-- The real budget's own six lines, in the order the shop lists them.
INSERT INTO public.purchasing_categories (name, sort_order) VALUES
  ('Manufacturing', 10),
  ('Electrical', 20),
  ('Software', 30),
  ('Third Robot', 40),
  ('Superpit', 50),
  ('Field', 60)
ON CONFLICT DO NOTHING;
