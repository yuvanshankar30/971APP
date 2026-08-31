import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_ANON_KEY, PUBLIC_SUPABASE_URL } from '$env/static/public';
import { canAccessSpecialThemes, SPECIAL_THEME_GROUPS } from '$lib/server/special_themes.js';

export async function GET({ request }) {
  const auth = request.headers.get('authorization') || '';
  const client = createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await client.auth.getUser();
  if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
  if (!canAccessSpecialThemes(user)) {
    return json({ error: 'Not found' }, { status: 404 });
  }
  return json({ success: true, data: SPECIAL_THEME_GROUPS });
}
