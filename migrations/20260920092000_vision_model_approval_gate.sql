CREATE TABLE IF NOT EXISTS public.vision_model_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_name text NOT NULL,
  model_version text NOT NULL,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  notes text,
  UNIQUE (model_name, model_version)
);
CREATE TABLE IF NOT EXISTS public.vision_event_policies (
  event_key text PRIMARY KEY,
  require_approved_model boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.vision_model_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vision_event_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vision_model_approvals_read ON public.vision_model_approvals;
CREATE POLICY vision_model_approvals_read ON public.vision_model_approvals FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS vision_model_approvals_service ON public.vision_model_approvals;
CREATE POLICY vision_model_approvals_service ON public.vision_model_approvals TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS vision_event_policies_read ON public.vision_event_policies;
CREATE POLICY vision_event_policies_read ON public.vision_event_policies FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS vision_event_policies_service ON public.vision_event_policies;
CREATE POLICY vision_event_policies_service ON public.vision_event_policies TO service_role USING (true) WITH CHECK (true);
GRANT SELECT ON public.vision_model_approvals, public.vision_event_policies TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vision_model_approvals, public.vision_event_policies TO service_role;
