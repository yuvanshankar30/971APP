const GITHUB_API = 'https://api.github.com';
const VERCEL_API = 'https://api.vercel.com';
const PREVIEW_OWNER = 'frc971';
const PREVIEW_REPO = 'spartanshub';
const PREVIEW_WORKFLOW = 'preview-deploy.yml';
const PREVIEW_MIRROR_OWNER = 'yuvanshankar30';
const PREVIEW_MIRROR_REPO = '971APP';
const VERCEL_PROJECT = 'spartanshub-edit-testing';
const VERCEL_TEAM = 'lightning-s-projects1';
const TIMEOUT_MS = 20 * 60 * 1000;

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
    'Content-Type': 'application/json'
  };
}

async function readVaultSecret(supa, name) {
  const { data, error } = await supa.rpc('get_app_secret', { secret_name: name });
  if (error) throw new Error(`Could not read ${name} from Vault: ${error.message}`);
  if (!data) throw new Error(`No "${name}" secret is stored in Vault yet`);
  return data;
}

async function githubRequest(fetchImpl, token, path, options = {}) {
  const response = await fetchImpl(`${GITHUB_API}${path}`, {
    ...options,
    headers: { ...githubHeaders(token), ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || `GitHub request failed (${response.status})`);
  return payload;
}

export async function dispatchPreviewWorkflow(fetchImpl, githubToken, branch) {
  return githubRequest(fetchImpl, githubToken, `/repos/${PREVIEW_OWNER}/${PREVIEW_REPO}/actions/workflows/${PREVIEW_WORKFLOW}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: 'main', inputs: { branch } })
  });
}

export function findDispatchedWorkflowRun(runs, dispatchedAt) {
  const earliest = new Date(dispatchedAt).getTime() - 60 * 1000;
  return (runs || [])
    .filter((run) => run?.event === 'workflow_dispatch' && new Date(run.created_at).getTime() >= earliest)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0] || null;
}

async function findWorkflowRun(fetchImpl, githubToken, pending) {
  if (pending.workflow_run_id) {
    return githubRequest(fetchImpl, githubToken, `/repos/${PREVIEW_OWNER}/${PREVIEW_REPO}/actions/runs/${pending.workflow_run_id}`);
  }
  const result = await githubRequest(fetchImpl, githubToken, `/repos/${PREVIEW_OWNER}/${PREVIEW_REPO}/actions/workflows/${PREVIEW_WORKFLOW}/runs?event=workflow_dispatch&per_page=20`);
  return findDispatchedWorkflowRun(result.workflow_runs, pending.workflow_dispatched_at);
}

async function previewMirrorHeadSha(fetchImpl, githubToken) {
  const result = await githubRequest(fetchImpl, githubToken, `/repos/${PREVIEW_MIRROR_OWNER}/${PREVIEW_MIRROR_REPO}/git/ref/heads/main`);
  return result?.object?.sha || null;
}

async function vercelRequest(fetchImpl, token, path) {
  const response = await fetchImpl(`${VERCEL_API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || `Vercel request failed (${response.status})`);
  return payload;
}

export function findVercelDeployment(deployments, commitSha) {
  return (deployments || []).find((deployment) => deployment?.meta?.githubCommitSha === commitSha) || null;
}

async function findPreviewDeployment(fetchImpl, vercelToken, commitSha) {
  const project = await vercelRequest(fetchImpl, vercelToken, `/v9/projects/${VERCEL_PROJECT}?teamId=${VERCEL_TEAM}`);
  const deployments = await vercelRequest(fetchImpl, vercelToken, `/v6/deployments?projectId=${encodeURIComponent(project.id)}&teamId=${VERCEL_TEAM}&limit=100`);
  return findVercelDeployment(deployments.deployments, commitSha);
}

async function updatePending(supa, id, values) {
  const { error } = await supa.from('edit_preview_notifications').update(values).eq('id', id);
  if (error) throw new Error(`Could not update edit preview notification: ${error.message}`);
}

async function postAndFinish(supa, slack, pending, text, status) {
  const response = await slack.chat.postMessage({
    channel: pending.slack_channel,
    thread_ts: pending.slack_thread_ts,
    text
  });
  if (!response?.ok) throw new Error('Slack rejected the edit preview follow-up');
  await updatePending(supa, pending.id, { status, notified_at: new Date().toISOString(), last_error: null });
}

async function handlePendingPreview({ supa, slack, fetchImpl, githubToken, getVercelToken, pending, now }) {
  if (now.getTime() - new Date(pending.created_at).getTime() >= TIMEOUT_MS) {
    await postAndFinish(supa, slack, pending, `The preview for PR #${pending.pr_number} did not finish within 20 minutes. Please run the preview workflow again or check its Actions run.`, 'timed_out');
    return 'timed_out';
  }
  if (pending.status === 'dispatch_failed') {
    await postAndFinish(supa, slack, pending, `I could not start the preview for PR #${pending.pr_number}: ${pending.last_error || 'unknown GitHub Actions error'}.`, 'failed');
    return 'failed';
  }

  const workflowRun = await findWorkflowRun(fetchImpl, githubToken, pending);
  if (!workflowRun) return 'waiting_for_workflow';
  if (!pending.workflow_run_id) await updatePending(supa, pending.id, { workflow_run_id: workflowRun.id, status: 'workflow_running' });
  if (workflowRun.status !== 'completed') return 'workflow_running';
  if (workflowRun.conclusion !== 'success') {
    await postAndFinish(supa, slack, pending, `The preview workflow for PR #${pending.pr_number} ${workflowRun.conclusion || 'did not complete successfully'}. Check <${workflowRun.html_url}|the Actions run> for details.`, 'failed');
    return 'failed';
  }

  const commitSha = await previewMirrorHeadSha(fetchImpl, githubToken);
  if (!commitSha) throw new Error('The preview repository main branch has no commit SHA');
  const deployment = await findPreviewDeployment(fetchImpl, await getVercelToken(), commitSha);
  if (!deployment) return 'waiting_for_vercel';
  if (deployment.state === 'READY') {
    await postAndFinish(supa, slack, pending, `Preview ready for PR #${pending.pr_number}: <https://${deployment.url}|Open the Vercel preview>.`, 'sent');
    return 'sent';
  }
  if (['ERROR', 'CANCELED'].includes(deployment.state)) {
    await postAndFinish(supa, slack, pending, `The Vercel preview for PR #${pending.pr_number} failed. Check <https://${deployment.url}|the deployment> for details.`, 'failed');
    return 'failed';
  }
  return 'vercel_building';
}

export async function queueEditPreview({ supa, fetchImpl = fetch, githubToken, prNumber, branch, slackChannel, slackThreadTs }) {
  const workflowDispatchedAt = new Date().toISOString();
  const { data: pending, error } = await supa.from('edit_preview_notifications').insert({
    pr_number: prNumber,
    branch_name: branch,
    slack_channel: slackChannel,
    slack_thread_ts: slackThreadTs,
    workflow_dispatched_at: workflowDispatchedAt
  }).select().single();
  if (error) throw new Error(`Could not queue edit preview notification: ${error.message}`);
  try {
    const dispatch = await dispatchPreviewWorkflow(fetchImpl, githubToken, branch);
    await updatePending(supa, pending.id, {
      status: 'workflow_dispatched',
      workflow_run_id: dispatch?.workflow_run_id || null
    });
  } catch (dispatchError) {
    await updatePending(supa, pending.id, { status: 'dispatch_failed', last_error: dispatchError.message || 'unknown dispatch error' });
  }
}

export async function processEditPreviewNotifications({ supa, slack, fetchImpl = fetch, now = new Date() }) {
  const { data: pendingRows, error } = await supa.from('edit_preview_notifications')
    .select('*')
    .is('notified_at', null)
    .order('created_at', { ascending: true })
    .limit(50);
  if (error) throw new Error(`Could not load edit preview notifications: ${error.message}`);
  if (!pendingRows?.length) return { checked: 0, completed: 0 };

  const githubToken = await readVaultSecret(supa, 'github_token');
  let vercelToken;
  const getVercelToken = async () => {
    if (!vercelToken) vercelToken = await readVaultSecret(supa, 'vercel_token');
    return vercelToken;
  };
  let completed = 0;
  for (const pending of pendingRows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const status = await handlePendingPreview({ supa, slack, fetchImpl, githubToken, getVercelToken, pending, now });
      if (['sent', 'failed', 'timed_out'].includes(status)) completed += 1;
    } catch (error) {
      console.error('Edit preview follow-up failed', pending.id, error?.message || error);
      // eslint-disable-next-line no-await-in-loop
      await updatePending(supa, pending.id, { last_error: error?.message || 'unknown preview follow-up error' });
    }
  }
  return { checked: pendingRows.length, completed };
}
