import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSupabase, update, postMessage, rejectDraftCodeChangePr, approveDraftCodeChangePr } = vi.hoisted(() => ({
  getSupabase: vi.fn(),
  update: vi.fn(),
  postMessage: vi.fn(),
  rejectDraftCodeChangePr: vi.fn(),
  approveDraftCodeChangePr: vi.fn()
}));

vi.mock('$lib/server/971bot.js', () => ({
  verifySlackSignature: () => true,
  getSupabase,
  getSlackClient: () => ({ chat: { update, postMessage } })
}));
vi.mock('$lib/server/hub_change_request.js', () => ({ rejectDraftCodeChangePr, approveDraftCodeChangePr }));

const { POST } = await import('./+server.js');

function actionRequest(payload) {
  return new Request('https://hub.test/api/971bot/slack/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ payload: JSON.stringify(payload) })
  });
}

function supabaseFor(profile) {
  return {
    from: (table) => {
      if (table === 'roster_entries') {
        return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
      }
      if (table === 'edit_preview_notifications') {
        const query = {
          select: () => query,
          eq: () => query,
          order: () => query,
          limit: () => query,
          maybeSingle: async () => ({ data: { slack_channel: 'C1', slack_thread_ts: '0.5' }, error: null })
        };
        return query;
      }
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: profile, error: null })
      };
      return query;
    }
  };
}

describe('Slack edit review actions', () => {
  beforeEach(() => {
    getSupabase.mockReset();
    update.mockReset().mockResolvedValue({ ok: true });
    postMessage.mockReset().mockResolvedValue({ ok: true });
    rejectDraftCodeChangePr.mockReset().mockResolvedValue({ number: 42, state: 'closed' });
    approveDraftCodeChangePr.mockReset().mockResolvedValue({ merged: true, merge: { html_url: 'https://github.com/frc971/spartanshub/pull/42' } });
  });

  it('lets a Change Lead reject a bot draft and replaces the DM controls', async () => {
    getSupabase.mockReturnValue(supabaseFor({ full_name: 'Casey Lead', banned: false, permissions: ['REQUEST_CODE_CHANGES'] }));
    const response = await POST({ request: actionRequest({
      type: 'block_actions', user: { id: 'U-LEAD' },
      actions: [{ action_id: 'hub_reject_edit_pr', value: '42' }],
      container: { channel_id: 'D1', message_ts: '1.0' }
    }) });
    expect(rejectDraftCodeChangePr).toHaveBeenCalledWith(42, { supa: expect.any(Object) });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ channel: 'D1', ts: '1.0', text: expect.stringContaining('rejected') }));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C1', thread_ts: '0.5', text: expect.stringContaining('rejected') }));
    expect(await response.json()).toMatchObject({ ok: true, rejected: true });
  });

  it('does not let a non-lead reject a draft', async () => {
    getSupabase.mockReturnValue(supabaseFor({ full_name: 'Member', banned: false, permissions: [] }));
    const response = await POST({ request: actionRequest({
      type: 'block_actions', user: { id: 'U-MEMBER' },
      actions: [{ action_id: 'hub_reject_edit_pr', value: '42' }]
    }) });
    expect(rejectDraftCodeChangePr).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ ok: true, error: expect.stringContaining('Change Lead') });
  });

  it('merges only when the guarded approval service reports every gate passed', async () => {
    getSupabase.mockReturnValue(supabaseFor({ full_name: 'Casey Lead', banned: false, permissions: ['REQUEST_CODE_CHANGES'] }));
    const response = await POST({ request: actionRequest({
      type: 'block_actions', user: { id: 'U-LEAD' },
      actions: [{ action_id: 'hub_approve_edit_pr', value: '42' }],
      container: { channel_id: 'D1', message_ts: '1.0' }
    }) });
    expect(approveDraftCodeChangePr).toHaveBeenCalledWith(42, { supa: expect.any(Object) });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('merged') }));
    expect(await response.json()).toMatchObject({ ok: true, merged: true });
  });

  it('keeps the approval control active when GitHub checks are still pending', async () => {
    approveDraftCodeChangePr.mockResolvedValueOnce({
      merged: false, phase: 'checks', checks: { message: '1 GitHub check is still running.' }
    });
    getSupabase.mockReturnValue(supabaseFor({ full_name: 'Casey Lead', banned: false, permissions: ['REQUEST_CODE_CHANGES'] }));
    const response = await POST({ request: actionRequest({
      type: 'block_actions', user: { id: 'U-LEAD' },
      actions: [{ action_id: 'hub_approve_edit_pr', value: '42' }],
      container: { channel_id: 'D1', message_ts: '1.0' }
    }) });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ blocks: expect.any(Array) }));
    expect(await response.json()).toMatchObject({ ok: true, merged: false, phase: 'checks' });
  });

  it('ignores unrelated interactive payloads', async () => {
    const response = await POST({ request: actionRequest({ type: 'block_actions', actions: [{ action_id: 'other' }] }) });
    expect(rejectDraftCodeChangePr).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ ok: true, ignored: true });
  });
});
