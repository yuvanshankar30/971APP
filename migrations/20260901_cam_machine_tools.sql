-- Machine-scoped CAM tooling. A tool can be installed on more than one
-- machine, while job creation only offers the tools installed on its machine.

CREATE TABLE IF NOT EXISTS public.cam_machine_tools (
  machine_id uuid NOT NULL REFERENCES public.cam_machines(id) ON DELETE CASCADE,
  tool_id uuid NOT NULL REFERENCES public.cam_tools(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (machine_id, tool_id)
);

CREATE INDEX IF NOT EXISTS cam_machine_tools_tool_id_idx
  ON public.cam_machine_tools (tool_id);

ALTER TABLE public.cam_machine_tools ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cam_machine_tools_select ON public.cam_machine_tools;
CREATE POLICY cam_machine_tools_select ON public.cam_machine_tools
  FOR SELECT TO authenticated USING (public.approved_user());

DROP POLICY IF EXISTS cam_machine_tools_write ON public.cam_machine_tools;
CREATE POLICY cam_machine_tools_write ON public.cam_machine_tools
  FOR ALL TO authenticated
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS cam_machine_tools_service_all ON public.cam_machine_tools;
CREATE POLICY cam_machine_tools_service_all ON public.cam_machine_tools
  TO service_role USING (true) WITH CHECK (true);

-- Preserve existing default-tool configurations as installed tools.
INSERT INTO public.cam_machine_tools (machine_id, tool_id)
SELECT id, default_tool_id
FROM public.cam_machines
WHERE default_tool_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- The UNC router's standard flat end mill. Its diameter is the source of truth for
-- generated router G-code and the 3D toolpath simulation.
INSERT INTO public.cam_tools (name, tool_type, diameter, enabled)
VALUES ('UNC Router 0.1575 in Flat End Mill', 'endmill', 0.1575, true)
ON CONFLICT (name) DO UPDATE
  SET tool_type = EXCLUDED.tool_type,
      diameter = EXCLUDED.diameter,
      enabled = true;

INSERT INTO public.cam_machine_tools (machine_id, tool_id)
SELECT machine.id, tool.id
FROM public.cam_machines AS machine
CROSS JOIN public.cam_tools AS tool
WHERE machine.name = 'UNC Router'
  AND tool.name = 'UNC Router 0.1575 in Flat End Mill'
ON CONFLICT DO NOTHING;

UPDATE public.cam_machines AS machine
SET default_tool_id = tool.id,
    default_params = jsonb_set(
      COALESCE(machine.default_params, '{}'::jsonb),
      '{toolDiameter}',
      '0.1575'::jsonb,
      true
    )
FROM public.cam_tools AS tool
WHERE machine.name = 'UNC Router'
  AND tool.name = 'UNC Router 0.1575 in Flat End Mill';
