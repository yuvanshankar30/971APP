import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { isAuthorizedCronRequest } from '$lib/server/cron_auth.js';
import { syncScoutingDataToSheet } from '$lib/server/google_sheets_sync.js';

// Cron-only trigger for the batch Google Sheets sync - same trust
// boundary/token as the other first-party scheduled sweeps (planner
// reminders), not a new secret.
// The manual "Sync Now" path in scouting-admin goes through the regular
// authenticated POST /api/scouting-admin action instead of this route.
export async function GET({ url, request }) {
  if (!isAuthorizedCronRequest({ url, headers: request.headers, env })) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await syncScoutingDataToSheet();
  return json(result);
}
