import { describe, expect, it, vi } from 'vitest';
import { dispatchPreviewWorkflow, findDispatchedWorkflowRun, findVercelDeployment, processEditPreviewNotifications } from './edit_preview.js';

function response(payload, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => payload };
}

function pendingSupa(rows) {
  const updates = [];
  return {
    updates,
    rpc: async (_name, { secret_name: name }) => ({ data: name === 'github_token' ? 'github-token' : 'vercel-token', error: null }),
    from: () => ({
      select: () => ({ is: () => ({ order: () => ({ limit: async () => ({ data: rows, error: null }) }) }) }),
      update: (values) => ({ eq: async (id) => { updates.push({ id, values }); return { error: null }; } })
    })
  };
}

describe('edit preview helpers', () => {
  it('dispatches the named branch through the existing manual workflow', async () => {
    const fetchImpl = vi.fn(async () => response({ workflow_run_id: 123 }));
    await dispatchPreviewWorkflow(fetchImpl, 'token', 'gemini-edit/test-abc');
    expect(fetchImpl.mock.calls[0][0]).toContain('/actions/workflows/preview-deploy.yml/dispatches');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ ref: 'main', inputs: { branch: 'gemini-edit/test-abc' } });
  });

  it('finds the newest workflow dispatch after the saved request time', () => {
    const run = findDispatchedWorkflowRun([
      { id: 1, event: 'push', created_at: '2026-09-23T10:00:00Z' },
      { id: 2, event: 'workflow_dispatch', created_at: '2026-09-23T10:01:00Z' },
      { id: 3, event: 'workflow_dispatch', created_at: '2026-09-23T10:02:00Z' }
    ], '2026-09-23T10:00:30Z');
    expect(run.id).toBe(3);
  });

  it('matches deployments by the commit that the preview workflow pushed', () => {
    expect(findVercelDeployment([
      { url: 'old.vercel.app', meta: { githubCommitSha: 'old' } },
      { url: 'new.vercel.app', meta: { githubCommitSha: 'new' } }
    ], 'new')).toMatchObject({ url: 'new.vercel.app' });
  });

  it('posts one Slack follow-up when the matched Vercel deployment is ready', async () => {
    const row = {
      id: 'row-1', pr_number: 42, branch_name: 'gemini-edit/test', slack_channel: 'C1', slack_thread_ts: '1.0',
      workflow_run_id: 123, workflow_dispatched_at: '2026-09-23T10:00:00Z', status: 'workflow_running', created_at: '2026-09-23T10:00:00Z'
    };
    const supa = pendingSupa([row]);
    const postMessage = vi.fn(async () => ({ ok: true }));
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes('/actions/runs/123')) return response({ id: 123, status: 'completed', conclusion: 'success' });
      if (url.includes('/git/ref/heads/main')) return response({ object: { sha: 'preview-sha' } });
      if (url.includes('/v9/projects/')) return response({ id: 'prj_1' });
      if (url.includes('/v6/deployments')) return response({ deployments: [{ state: 'READY', url: 'preview.vercel.app', meta: { githubCommitSha: 'preview-sha' } }] });
      throw new Error(`Unexpected URL ${url}`);
    });
    await expect(processEditPreviewNotifications({ supa, slack: { chat: { postMessage } }, fetchImpl, now: new Date('2026-09-23T10:05:00Z') }))
      .resolves.toEqual({ checked: 1, completed: 1 });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C1', thread_ts: '1.0', text: expect.stringContaining('https://preview.vercel.app') }));
    expect(supa.updates.at(-1).values.status).toBe('sent');
  });

  it('posts a timeout instead of leaving a preview pending forever', async () => {
    const row = {
      id: 'row-1', pr_number: 42, slack_channel: 'C1', slack_thread_ts: '1.0', status: 'workflow_dispatched', created_at: '2026-09-23T10:00:00Z'
    };
    const supa = pendingSupa([row]);
    const postMessage = vi.fn(async () => ({ ok: true }));
    await processEditPreviewNotifications({ supa, slack: { chat: { postMessage } }, now: new Date('2026-09-23T10:21:00Z') });
    expect(postMessage.mock.calls[0][0].text).toContain('did not finish within 20 minutes');
    expect(supa.updates.at(-1).values.status).toBe('timed_out');
  });
});
