import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const SESSION_LIFETIME_MS = 10 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class FusionRunnerSetupError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

function cleanRunnerName(value) {
  const name = String(value || '').trim();
  if (!name) throw new FusionRunnerSetupError('Runner name is required', 400);
  return name.slice(0, 120);
}

function requireSessionId(value) {
  const id = String(value || '').trim();
  if (!UUID_RE.test(id)) throw new FusionRunnerSetupError('Invalid setup session', 400);
  return id;
}

function secretsMatch(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));
  return actualBuffer.length === expectedBuffer.length
    && actualBuffer.length > 0
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

export async function startFusionRunnerSetup(supabase, runnerName) {
  const id = randomUUID();
  const pollSecret = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS).toISOString();
  const { error } = await supabase.from('fusion_runner_setup_sessions').insert({
    id,
    poll_secret: pollSecret,
    runner_name: cleanRunnerName(runnerName),
    expires_at: expiresAt
  });
  if (error) throw new FusionRunnerSetupError(error.message);
  return { id, pollSecret, expiresAt };
}

async function getSetupSession(supabase, sessionId) {
  const { data, error } = await supabase
    .from('fusion_runner_setup_sessions')
    .select('id, runner_name, poll_secret, expires_at, completed_at, consumed_at, machine_id')
    .eq('id', requireSessionId(sessionId))
    .maybeSingle();
  if (error) throw new FusionRunnerSetupError(error.message);
  if (!data) throw new FusionRunnerSetupError('Setup session not found', 404);
  if (new Date(data.expires_at).getTime() <= Date.now()) {
    throw new FusionRunnerSetupError('Setup session expired. Run the install command again.', 410);
  }
  return data;
}

export async function authorizeFusionRunnerSetup(supabase, env, sessionId, submittedToken) {
  if (!secretsMatch(submittedToken, env?.FUSION_RUNNER_TOKEN)) {
    throw new FusionRunnerSetupError('Invalid Fusion Runner token', 401);
  }

  const session = await getSetupSession(supabase, sessionId);
  if (session.consumed_at) throw new FusionRunnerSetupError('Setup session has already been used', 410);
  if (session.completed_at) return { machineId: session.machine_id, alreadyCompleted: true };

  const token = `frt_${randomUUID()}`;
  const { data, error } = await supabase.rpc('authorize_fusion_runner_setup_session', {
    requested_session_id: session.id,
    issued_token: token
  });
  if (error) throw new FusionRunnerSetupError(error.message);
  const machineId = data?.[0]?.machine_id;
  if (!machineId) throw new FusionRunnerSetupError('Setup session is no longer available', 409);
  return { machineId, alreadyCompleted: false };
}

export async function pollFusionRunnerSetup(supabase, sessionId, pollSecret) {
  const session = await getSetupSession(supabase, sessionId);
  if (!secretsMatch(pollSecret, session.poll_secret)) {
    throw new FusionRunnerSetupError('Invalid setup session secret', 401);
  }
  if (session.consumed_at) throw new FusionRunnerSetupError('Setup session has already been used', 410);
  if (!session.completed_at) return { status: 'pending' };

  const { data, error } = await supabase.rpc('consume_fusion_runner_setup_session', {
    requested_session_id: session.id,
    requested_poll_secret: pollSecret
  });
  if (error) throw new FusionRunnerSetupError(error.message);
  const result = data?.[0];
  if (!result?.token || !result?.machine_id) {
    throw new FusionRunnerSetupError('Setup session is no longer available', 409);
  }
  return {
    status: 'complete',
    runnerName: result.runner_name,
    machineId: result.machine_id,
    token: result.token
  };
}
