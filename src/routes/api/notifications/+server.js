import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import {
  notifyPartAssignmentById,
  notifyPartCompletedById,
  notifyPurchaseApprovedById,
  notifyManufacturingRequestById,
  notifyPartRequesterStatusById,
  notifyRouterLeadsStatusById
} from '$lib/server/slack_notifications.js';

function getClientFromRequest(request) {
  const auth = request?.headers?.get('authorization') || '';
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: auth } }
  });
}

export async function POST({ request }) {
  const supa = getClientFromRequest(request);
  const { data: authData, error: authError } = await supa.auth.getUser();
  if (authError || !authData?.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const type = body?.type;
  if (!type) {
    return json({ error: 'type required' }, { status: 400 });
  }

  try {
    if (type === 'part-assigned') {
      if (!body.part_id) return json({ error: 'part_id required' }, { status: 400 });
      const result = await notifyPartAssignmentById(body.part_id);
      return json({ ok: true, result });
    }
    if (type === 'part-complete') {
      if (!body.part_id) return json({ error: 'part_id required' }, { status: 400 });
      const result = await notifyPartCompletedById(body.part_id);
      return json({ ok: true, result });
    }
    if (type === 'purchase-approved') {
      if (!body.purchase_id) return json({ error: 'purchase_id required' }, { status: 400 });
      const result = await notifyPurchaseApprovedById(body.purchase_id);
      return json({ ok: true, result });
    }
    if (type === 'manufacturing-request') {
      if (!body.part_id) return json({ error: 'part_id required' }, { status: 400 });
      const result = await notifyManufacturingRequestById(body.part_id);
      return json({ ok: true, result });
    }
    if (type === 'manufacturing-request-status') {
      if (!body.part_id || !body.status) return json({ error: 'part_id and status required' }, { status: 400 });
      const result = await notifyPartRequesterStatusById(body.part_id, body.status);
      return json({ ok: true, result });
    }
    if (type === 'router-status') {
      if (!body.part_id || !body.status) return json({ error: 'part_id and status required' }, { status: 400 });
      const result = await notifyRouterLeadsStatusById(body.part_id, body.status);
      return json({ ok: true, result });
    }
    return json({ error: 'Unknown notification type' }, { status: 400 });
  } catch (error) {
    console.error('Notification dispatch failed', error);
    return json({ ok: false, error: error.message || 'Failed to send notification' }, { status: 500 });
  }
}
