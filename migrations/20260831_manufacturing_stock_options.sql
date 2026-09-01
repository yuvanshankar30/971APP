-- User-maintained stock choices for the new manufacturing-request form.
-- Bundled stock.json entries remain the baseline; these rows are additions
-- shared by every approved user without requiring another code deployment.

CREATE TABLE IF NOT EXISTS public.manufacturing_stock_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow text NOT NULL CHECK (workflow IN ('laser-cut', 'router', 'lathe', 'mill', '3d-print')),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 120),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS manufacturing_stock_options_workflow_description_unique
  ON public.manufacturing_stock_options (workflow, lower(description));

ALTER TABLE public.manufacturing_stock_options ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS manufacturing_stock_options_select ON public.manufacturing_stock_options;
CREATE POLICY manufacturing_stock_options_select ON public.manufacturing_stock_options
  FOR SELECT TO authenticated USING (public.approved_user());

DROP POLICY IF EXISTS manufacturing_stock_options_insert ON public.manufacturing_stock_options;
CREATE POLICY manufacturing_stock_options_insert ON public.manufacturing_stock_options
  FOR INSERT TO authenticated
  WITH CHECK (public.approved_user() AND auth.uid() = created_by);
