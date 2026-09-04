CREATE TABLE IF NOT EXISTS public.purchasing_checkoff_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchasing_id bigint NOT NULL REFERENCES public.purchasing(id) ON DELETE CASCADE,
  checked_off_by uuid NOT NULL REFERENCES auth.users(id),
  checked_off_at timestamptz NOT NULL DEFAULT now(),
  method text NOT NULL CHECK (method IN ('photo')),
  match_confidence numeric,
  extracted_text text,
  status_before text,
  status_after text
);

CREATE INDEX IF NOT EXISTS purchasing_checkoff_events_item_time_idx
  ON public.purchasing_checkoff_events (purchasing_id, checked_off_at DESC);

ALTER TABLE public.purchasing_checkoff_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "purchasing checkoff events are readable by signed-in users"
  ON public.purchasing_checkoff_events FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.checkoff_purchasing_photo(
  p_purchasing_id bigint,
  p_match_confidence numeric DEFAULT NULL,
  p_extracted_text text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  actor_profile public.user_profiles%ROWTYPE;
  purchase public.purchasing%ROWTYPE;
  event_row public.purchasing_checkoff_events%ROWTYPE;
  allowed boolean;
  status_before_value text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501'; END IF;
  SELECT * INTO actor_profile FROM public.user_profiles WHERE id = auth.uid();
  allowed := actor_profile.role = 'admin'
    OR actor_profile.general_role IN ('member', 'subsystem_lead', 'lead')
    OR actor_profile.purchasing_role IN ('basic', 'approver', 'lead')
    OR actor_profile.team_role = 'Purchasing Lead'
    OR COALESCE(actor_profile.permissions, ARRAY[]::text[]) @> ARRAY['PLACE_ORDERS_MISC'];
  IF actor_profile.id IS NULL OR actor_profile.banned OR NOT allowed THEN
    RAISE EXCEPTION 'Not allowed to receive purchasing items' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO purchase FROM public.purchasing WHERE id = p_purchasing_id FOR UPDATE;
  IF purchase.id IS NULL THEN RAISE EXCEPTION 'Purchasing item not found' USING ERRCODE = 'P0002'; END IF;
  IF purchase.status IN ('delivered', 'kitted') OR purchase.delivered THEN
    RETURN jsonb_build_object('already_checked_off', true, 'item', to_jsonb(purchase));
  END IF;
  status_before_value := purchase.status;

  UPDATE public.purchasing
  SET status = 'delivered',
      delivered = true,
      updated_at = now()
  WHERE id = purchase.id
  RETURNING * INTO purchase;

  INSERT INTO public.purchasing_checkoff_events
    (purchasing_id, checked_off_by, method, match_confidence, extracted_text, status_before, status_after)
  VALUES
    (purchase.id, auth.uid(), 'photo', p_match_confidence, NULLIF(p_extracted_text, ''),
     status_before_value, 'delivered')
  RETURNING * INTO event_row;

  RETURN jsonb_build_object('already_checked_off', false, 'item', to_jsonb(purchase), 'event', to_jsonb(event_row));
END;
$$;

REVOKE ALL ON FUNCTION public.checkoff_purchasing_photo(bigint, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.checkoff_purchasing_photo(bigint, numeric, text) TO authenticated;
