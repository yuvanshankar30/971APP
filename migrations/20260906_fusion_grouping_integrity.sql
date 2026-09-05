-- Ship with the Fusion grouping client: inventory is maintained by triggers,
-- never by a second browser request. No historical inventory is rewritten.
BEGIN;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM public.fusion_parts p LEFT JOIN public.fusion_part_category_assignments a ON a.part_id=p.id
    GROUP BY p.id HAVING p.quantity < 0 OR p.original_quantity < 0 OR p.quantity + coalesce(sum(a.quantity),0) <> p.original_quantity
  ) THEN RAISE EXCEPTION 'Fusion inventory is inconsistent. Reconcile remaining and assigned quantities before applying this migration.'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.can_manage_fusion_stock() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
 SELECT public.approved_user() AND EXISTS (
   SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND NOT coalesce(banned, false)
   AND (role = 'admin' OR general_role IN ('lead', 'subsystem_lead') OR team_role = 'Manufacturing Lead')
 );
$$;
REVOKE ALL ON FUNCTION public.can_manage_fusion_stock() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_manage_fusion_stock() TO authenticated;

DO $$
DECLARE t text; prefix text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fusion_part_categories','fusion_parts','fusion_plates','fusion_part_category_assignments','fusion_box_tubes'] LOOP
    prefix := CASE WHEN t = 'fusion_part_category_assignments' THEN 'fusion_pca' ELSE t END;
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', prefix || '_write', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (public.can_manage_fusion_stock())', prefix || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (public.can_manage_fusion_stock()) WITH CHECK (public.can_manage_fusion_stock())', prefix || '_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (public.can_manage_fusion_stock())', prefix || '_delete', t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.fusion_validate_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE plate public.fusion_plates%ROWTYPE; part_category uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.plate_id, NEW.part_id) IS DISTINCT FROM (OLD.plate_id, OLD.part_id) THEN
    RAISE EXCEPTION 'Remove an assignment before moving it to another plate or part';
  END IF;
  SELECT * INTO plate FROM public.fusion_plates WHERE id = NEW.plate_id FOR UPDATE;
  SELECT category_id INTO part_category FROM public.fusion_parts WHERE id = NEW.part_id FOR UPDATE;
  IF plate.id IS NULL OR part_category IS NULL THEN RAISE EXCEPTION 'Plate or part not found'; END IF;
  IF NEW.category_id IS DISTINCT FROM plate.category_id OR part_category IS DISTINCT FROM plate.category_id THEN
    RAISE EXCEPTION 'Part and plate must share the same material and thickness category';
  END IF;
  IF NEW.quantity IS NULL OR NEW.quantity <= 0 THEN RAISE EXCEPTION 'Assignment quantity must be a positive integer'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fusion_validate_assignment BEFORE INSERT OR UPDATE
ON public.fusion_part_category_assignments FOR EACH ROW EXECUTE FUNCTION public.fusion_validate_assignment();

-- AFTER is intentional: an upsert must apply only its final INSERT or UPDATE
-- delta, not both BEFORE INSERT and BEFORE UPDATE effects.
CREATE OR REPLACE FUNCTION public.fusion_assignment_inventory() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE delta integer; target_id uuid;
BEGIN
  target_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.part_id ELSE NEW.part_id END;
  delta := CASE WHEN TG_OP = 'DELETE' THEN -OLD.quantity WHEN TG_OP = 'INSERT' THEN NEW.quantity ELSE NEW.quantity - OLD.quantity END;
  UPDATE public.fusion_parts SET quantity = quantity - delta
    WHERE id = target_id AND quantity - delta >= 0 AND quantity - delta <= original_quantity;
  IF NOT FOUND AND EXISTS (SELECT 1 FROM public.fusion_parts WHERE id = target_id) THEN
    RAISE EXCEPTION 'Insufficient remaining quantity or inconsistent inventory; refresh and check this part';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER fusion_assignment_inventory AFTER INSERT OR UPDATE OR DELETE
ON public.fusion_part_category_assignments FOR EACH ROW EXECUTE FUNCTION public.fusion_assignment_inventory();

CREATE OR REPLACE FUNCTION public.fusion_protect_part_stock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.quantity < 0 OR NEW.original_quantity < 0 OR NEW.quantity > NEW.original_quantity THEN
    RAISE EXCEPTION 'Invalid part quantities';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.quantity <> NEW.original_quantity THEN
    RAISE EXCEPTION 'A new part must start with all quantities available';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.quantity IS DISTINCT FROM OLD.quantity AND pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'Remaining quantity is maintained by plate assignments';
    END IF;
    IF (NEW.category_id, NEW.original_quantity) IS DISTINCT FROM (OLD.category_id, OLD.original_quantity) THEN
      RAISE EXCEPTION 'Stock category and requested quantity are immutable; create a new part';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fusion_protect_part_stock BEFORE INSERT OR UPDATE ON public.fusion_parts
FOR EACH ROW EXECUTE FUNCTION public.fusion_protect_part_stock();

CREATE OR REPLACE FUNCTION public.fusion_protect_plate_category() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.category_id IS DISTINCT FROM OLD.category_id AND EXISTS (
    SELECT 1 FROM public.fusion_part_category_assignments WHERE plate_id = OLD.id
  ) THEN RAISE EXCEPTION 'Remove nested parts before changing plate stock'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fusion_protect_plate_category BEFORE UPDATE ON public.fusion_plates
FOR EACH ROW EXECUTE FUNCTION public.fusion_protect_plate_category();

-- Snapshot raw file paths, never expiring download URLs. The Runner signs them
-- when claiming. This also covers clients inserting cam_jobs directly.
CREATE OR REPLACE FUNCTION public.fusion_snapshot_plate_job() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE plate public.fusion_plates%ROWTYPE; category public.fusion_part_categories%ROWTYPE;
  assignments jsonb; material_name text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.operation_type = 'milling' AND NEW.params->>'fusionJobKind' IN ('plate:cam', 'plate:arrange')
      AND NOT (OLD.operation_type = 'milling' AND coalesce(OLD.params->>'fusionJobKind', '') IN ('plate:cam', 'plate:arrange')) THEN
      RAISE EXCEPTION 'Create a new Fusion plate job instead of converting an existing job';
    END IF;
    IF OLD.operation_type = 'milling' AND OLD.params->>'fusionJobKind' IN ('plate:cam', 'plate:arrange')
      AND (NEW.params, NEW.machine_id, NEW.tool_id, NEW.material_id, NEW.operation_type)
      IS DISTINCT FROM (OLD.params, OLD.machine_id, OLD.tool_id, OLD.material_id, OLD.operation_type) THEN
      RAISE EXCEPTION 'Queued Fusion inputs are immutable; queue a new job';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.operation_type <> 'milling' OR coalesce(NEW.params->>'fusionJobKind', '') NOT IN ('plate:cam', 'plate:arrange') THEN RETURN NEW; END IF;
  IF NEW.status <> 'queued' THEN RAISE EXCEPTION 'Fusion plate jobs must start queued'; END IF;
  SELECT * INTO plate FROM public.fusion_plates WHERE id = (NEW.params->>'plateId')::uuid FOR UPDATE;
  IF plate.id IS NULL THEN RAISE EXCEPTION 'Plate not found'; END IF;
  SELECT * INTO category FROM public.fusion_part_categories WHERE id = plate.category_id;
  SELECT name INTO material_name FROM public.cam_materials WHERE id = category.material_id;
  IF plate.length <= 0 OR plate.width <= 0 OR plate.true_depth <= 0 OR category.thickness <= 0
     OR plate.length::text IN ('NaN','Infinity') OR plate.width::text IN ('NaN','Infinity')
     OR plate.true_depth::text IN ('NaN','Infinity') OR category.thickness::text IN ('NaN','Infinity') THEN
    RAISE EXCEPTION 'Plate dimensions and thickness must be finite and positive';
  END IF;
  IF NEW.params->>'fusionJobKind' = 'plate:cam' AND NOT EXISTS (
    SELECT 1 FROM public.cam_machines m JOIN public.cam_machine_tools mt ON mt.machine_id = m.id
    WHERE m.id = NEW.machine_id AND m.enabled AND m.can_run_plates AND mt.tool_id = NEW.tool_id
  ) THEN RAISE EXCEPTION 'Choose an enabled plate machine and a tool installed on it'; END IF;
  IF EXISTS (SELECT 1 FROM public.fusion_part_category_assignments a JOIN public.fusion_parts p ON p.id = a.part_id
    WHERE a.plate_id = plate.id AND (a.quantity <= 0 OR a.category_id <> plate.category_id OR p.category_id <> plate.category_id
      OR nullif(trim(p.step_file_name), '') IS NULL)) THEN
    RAISE EXCEPTION 'Every nested part needs matching stock, a positive quantity, and a STEP file';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('part_id', p.id, 'quantity', a.quantity,
    'step_file_name', p.step_file_name, 'fusion_file_name', p.fusion_file_name) ORDER BY p.id)
    INTO assignments FROM public.fusion_part_category_assignments a JOIN public.fusion_parts p ON p.id = a.part_id WHERE a.plate_id = plate.id;
  IF assignments IS NULL THEN RAISE EXCEPTION 'Nest at least one part before queueing a plate'; END IF;
  NEW.material_id := category.material_id;
  NEW.part_id := NULL;
  NEW.params := NEW.params || jsonb_build_object('fusionPlateSnapshot', jsonb_build_object(
    'version', 1, 'plate_id', plate.id, 'length', plate.length, 'width', plate.width,
    'true_depth', plate.true_depth, 'thickness', category.thickness, 'material', material_name, 'assignments', assignments));
  RETURN NEW;
END $$;
CREATE TRIGGER fusion_snapshot_plate_job BEFORE INSERT OR UPDATE ON public.cam_jobs
FOR EACH ROW EXECUTE FUNCTION public.fusion_snapshot_plate_job();

-- Trigger helpers are not callable application APIs.
REVOKE ALL ON FUNCTION public.fusion_validate_assignment(), public.fusion_assignment_inventory(),
 public.fusion_protect_part_stock(), public.fusion_protect_plate_category(), public.fusion_snapshot_plate_job() FROM PUBLIC;
COMMIT;
