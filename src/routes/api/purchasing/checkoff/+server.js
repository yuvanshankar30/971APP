import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_ANON_KEY, PUBLIC_SUPABASE_URL } from '$env/static/public';

function clientFor(request) {
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: request.headers.get('authorization') || '' } }
  });
}

export async function POST({ request }) {
  const client = clientFor(request);
  const body = await request.json().catch(() => null);
  const purchasingId = Number(body?.purchasing_id);
  if (!Number.isInteger(purchasingId) || purchasingId < 1) return json({ error: 'A purchasing item is required.' }, { status: 400 });
  const confidence = Number(body?.match_confidence);
  const extractedText = String(body?.extracted_text || '').slice(0, 2000);
  const { data, error } = await client.rpc('checkoff_purchasing_photo', {
    p_purchasing_id: purchasingId,
    p_match_confidence: Number.isFinite(confidence) ? confidence : null,
    p_extracted_text: extractedText || null
  });
  if (error) return json({ error: error.message }, { status: error.code === '42501' ? 403 : 400 });
  return json(data);
}
