-- Direct instruction: a Fusion part must always be requeueable for its full
-- quantity, no matter how many times it's already been queued - the
-- needed/remaining/already-queued workflow this enforced is being dropped
-- from the app (the UI no longer displays or gates on fusion_parts.quantity
-- at all - see PartsTab.svelte/BoxTubesTab.svelte, which now key off
-- original_quantity everywhere).
--
-- fusion_assignment_inventory() (20260906_fusion_grouping_integrity.sql)
-- previously raised "Insufficient remaining quantity..." and rejected the
-- assignment outright once a part's tracked remaining count hit zero -
-- exactly the case a requeue needs to succeed. Clamp the tracked count into
-- [0, original_quantity] instead of rejecting; it's kept only as
-- informational bookkeeping now that nothing reads it to gate a UI action.
CREATE OR REPLACE FUNCTION public.fusion_assignment_inventory() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE delta integer; target_id uuid;
BEGIN
  target_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.part_id ELSE NEW.part_id END;
  delta := CASE WHEN TG_OP = 'DELETE' THEN -OLD.quantity WHEN TG_OP = 'INSERT' THEN NEW.quantity ELSE NEW.quantity - OLD.quantity END;
  UPDATE public.fusion_parts
    SET quantity = GREATEST(0, LEAST(original_quantity, quantity - delta))
    WHERE id = target_id;
  RETURN NULL;
END $$;
