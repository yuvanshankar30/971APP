import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { createClient } from '@supabase/supabase-js';
import { isAuthorizedCronRequest } from '$lib/server/cron_auth.js';
import { runDriveWatcherSweep } from '$autocam/inprocess/drive_watcher.js';

const LEASE_KEY = 'drive_watcher_sweep';
const LEASE_SECONDS = 240; // generous - a sweep can involve several Drive downloads + STEP generation calls

function getServiceSupabase() {
  const url = env.SUPABASE_URL || env.PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  return createClient(url, serviceKey);
}

async function handleRequest({ url, request }) {
  if (!isAuthorizedCronRequest({ url, headers: request.headers, env })) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = getServiceSupabase();
  const { data: claimed, error: claimError } = await supabase.rpc('claim_runtime_lease', {
    lease_key: LEASE_KEY,
    lease_seconds: LEASE_SECONDS,
    min_interval_seconds: 0
  });
  if (claimError) {
    return json({ ok: false, error: `Could not claim sweep lease: ${claimError.message}` }, { status: 500 });
  }
  if (!claimed) {
    return json({ ok: true, skipped: true, reason: 'lease-unavailable' });
  }

  try {
    const result = await runDriveWatcherSweep({ appOrigin: url.origin });
    return json(result);
  } catch (error) {
    return json({ ok: false, error: error?.message || 'Drive watcher sweep failed' }, { status: 500 });
  } finally {
    const { error: releaseError } = await supabase.rpc('release_runtime_lease', { lease_key: LEASE_KEY });
    if (releaseError) console.warn('Drive watcher: failed to release sweep lease (non-fatal)', releaseError.message);
  }
}

export async function GET(event) {
  return handleRequest(event);
}

export async function POST(event) {
  return handleRequest(event);
}
