import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_ANON_KEY, PUBLIC_SUPABASE_URL } from '$env/static/public';
import { env } from '$env/dynamic/private';
import { rankPurchasingPhotoCandidates } from '$lib/purchasingPhotoMatch.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Temporary: no working OpenAI key yet. Explicit rather than relying only on
// env.OPENAI_API_KEY being unset - flip back to false (or delete this check)
// once a real OPENAI_API_KEY is configured.
const AI_PHOTO_ID_TEMPORARILY_DISABLED = true;

function clientFor(request) {
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: request.headers.get('authorization') || '' } }
  });
}

async function actorCanReceive(client) {
  const { data: auth } = await client.auth.getUser();
  if (!auth?.user?.id) return false;
  const { data: profile } = await client.from('user_profiles')
    .select('role, banned, general_role, purchasing_role, team_role, permissions')
    .eq('id', auth.user.id).maybeSingle();
  if (!profile || profile.banned) return false;
  return profile.role === 'admin'
    || ['member', 'subsystem_lead', 'lead'].includes(profile.general_role)
    || ['basic', 'approver', 'lead'].includes(profile.purchasing_role)
    || profile.team_role === 'Purchasing Lead'
    || (Array.isArray(profile.permissions) && profile.permissions.includes('PLACE_ORDERS_MISC'));
}

function responseText(response) {
  if (typeof response?.output_text === 'string') return response.output_text;
  return (response?.output || []).flatMap((item) => item.content || [])
    .filter((content) => content.type === 'output_text')
    .map((content) => content.text || '').join('');
}

function cleanExtraction(value) {
  const text = (field) => typeof value?.[field] === 'string' ? value[field].trim().slice(0, 2000) : null;
  return {
    vendorGuess: text('vendorGuess'),
    productName: text('productName'),
    orderNumber: text('orderNumber'),
    rawText: text('rawText') || ''
  };
}

export async function POST({ request, fetch }) {
  const client = clientFor(request);
  if (!await actorCanReceive(client)) return json({ error: 'You are not allowed to receive purchasing items.' }, { status: 403 });

  const body = await request.json().catch(() => null);
  const imageDataUrl = typeof body?.image === 'string' ? body.image : '';
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(imageDataUrl)) {
    return json({ error: 'Send a JPEG, PNG, or WebP photo.' }, { status: 400 });
  }
  const encoded = imageDataUrl.slice(imageDataUrl.indexOf(',') + 1);
  if ((encoded.length * 3) / 4 > MAX_IMAGE_BYTES) return json({ error: 'Keep the photo under 5 MB.' }, { status: 413 });
  if (AI_PHOTO_ID_TEMPORARILY_DISABLED || !env.OPENAI_API_KEY) {
    return json({ error: 'Photo receiving is not configured yet.' }, { status: 503 });
  }

  const visionResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      store: false,
      max_output_tokens: 300,
      text: { format: { type: 'json_object' } },
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'Read packaging, shipping-label, and packing-slip text in this receiving photo. Return JSON only: {"vendorGuess":string|null,"productName":string|null,"orderNumber":string|null,"rawText":string}. Do not guess text that is not visible.' },
          { type: 'input_image', image_url: imageDataUrl, detail: 'low' }
        ]
      }]
    })
  });
  if (!visionResponse.ok) {
    console.error('Purchasing photo vision request failed', visionResponse.status, await visionResponse.text());
    return json({ error: 'The photo could not be identified. Try a clearer picture of the label.' }, { status: 502 });
  }

  let extraction;
  try { extraction = cleanExtraction(JSON.parse(responseText(await visionResponse.json()))); }
  catch { return json({ error: 'The photo response was unreadable. Try a clearer picture of the label.' }, { status: 502 }); }

  const { data: purchasing, error } = await client.from('purchasing')
    .select('id, name, vendor, url, part_number, project_id, quantity, status, is_pickup')
    .not('status', 'in', '(delivered,kitted,picked_up,rejected)');
  if (error) return json({ error: error.message }, { status: 500 });
  const candidates = rankPurchasingPhotoCandidates(extraction, purchasing || []).map(({ item, score }) => ({ ...item, confidence: score }));
  return json({ extraction, candidates });
}
