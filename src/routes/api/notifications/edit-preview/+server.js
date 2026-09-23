import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getCronSecrets, isAuthorizedCronRequest } from '$lib/server/cron_auth.js';
import { getSlackClient, getSupabase } from '$lib/server/971bot.js';
import { processEditPreviewNotifications } from '$lib/server/edit_preview.js';

export async function POST({ url, request }) {
  if (!getCronSecrets(env).length) {
    return json({ error: 'No cron secret configured; refusing to run an unauthenticated sweep.' }, { status: 503 });
  }
  if (!isAuthorizedCronRequest({ url, headers: request.headers, env })) return json({ error: 'Unauthorized' }, { status: 401 });
  return json(await processEditPreviewNotifications({ supa: getSupabase(), slack: getSlackClient() }));
}
