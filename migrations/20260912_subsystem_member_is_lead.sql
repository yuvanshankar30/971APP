-- Support multiple leads per subsystem. subsystems.lead_user_id stays as
-- the original/primary lead (untouched - still works exactly as before for
-- every existing single-lead subsystem); this adds a way for existing
-- leads to promote other members to co-lead without replacing that primary
-- lead. A lead must already be a member, so this lives on subsystem_members
-- rather than a separate leads table.

ALTER TABLE public.subsystem_members
ADD COLUMN IF NOT EXISTS is_lead boolean NOT NULL DEFAULT false;

-- subsystem_members had no UPDATE policy at all before this (only
-- SELECT/INSERT/DELETE for authenticated users, plus the service-role
-- catch-all) - toggling is_lead needs one. Lets the subsystem's primary
-- lead (subsystems.lead_user_id), any existing co-lead of that subsystem,
-- or a general CREATE_SUBSYSTEMS permission holder (the same override
-- already used on this table's insert/delete policies) update a member row.
DROP POLICY IF EXISTS subsystem_members_update_lead ON public.subsystem_members;
CREATE POLICY subsystem_members_update_lead ON public.subsystem_members
FOR UPDATE
USING (
  has_permission('CREATE_SUBSYSTEMS')
  OR EXISTS (
    SELECT 1 FROM public.subsystems s
    WHERE s.id = subsystem_members.subsystem_id
      AND s.lead_user_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1 FROM public.subsystem_members sm2
    WHERE sm2.subsystem_id = subsystem_members.subsystem_id
      AND sm2.user_id = auth.uid()
      AND sm2.is_lead = true
  )
)
WITH CHECK (
  has_permission('CREATE_SUBSYSTEMS')
  OR EXISTS (
    SELECT 1 FROM public.subsystems s
    WHERE s.id = subsystem_members.subsystem_id
      AND s.lead_user_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1 FROM public.subsystem_members sm2
    WHERE sm2.subsystem_id = subsystem_members.subsystem_id
      AND sm2.user_id = auth.uid()
      AND sm2.is_lead = true
  )
);
