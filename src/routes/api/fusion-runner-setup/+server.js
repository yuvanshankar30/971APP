import { env } from '$env/dynamic/private';
import { startFusionRunnerSetup, pollFusionRunnerSetup, FusionRunnerSetupError } from '$lib/server/fusion_runner_setup.js';
import { createClient } from '@supabase/supabase-js';
import { json } from '@sveltejs/kit';

function getServiceSupabase() {
  const url = env.SUPABASE_URL || env.PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) throw new Error('Fusion Runner setup is missing Supabase service configuration');
  return createClient(url, serviceKey);
}

export async function POST({ request, url }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const action = url.searchParams.get('action') || body?.action;
    const supabase = getServiceSupabase();
    if (action === 'start') {
      const session = await startFusionRunnerSetup(supabase, body?.runnerName);
      return json({
        sessionId: session.id,
        pollSecret: session.pollSecret,
        expiresAt: session.expiresAt,
        configureUrl: `${url.origin}/install/fusion-runner/setup?session=${session.id}`
      });
    }
    if (action === 'poll') {
      const result = await pollFusionRunnerSetup(supabase, body?.sessionId, body?.pollSecret);
      return json(result, { status: result.status === 'pending' ? 202 : 200 });
    }
    return json({ error: 'Unknown action. Expected start or poll.' }, { status: 400 });
  } catch (error) {
    const status = error instanceof FusionRunnerSetupError ? error.status : 500;
    return json({ error: error?.message || 'Fusion Runner setup failed' }, { status });
  }
}
