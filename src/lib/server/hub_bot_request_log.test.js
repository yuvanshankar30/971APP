import { describe, expect, it, vi } from 'vitest';
import { classifyBotRequestType, logBotRequest } from './hub_bot_request_log.js';

const predicates = {
  isCodeChangeRequest: (q) => /^\/edit\b/i.test(q),
  isHubStatusRequest: (q) => /^\/status\b/i.test(q),
  isTeamReportStatusRequest: (q) => /^\/team\b/i.test(q),
  isScoutingAssignmentQuestion: (q) => /assignment/i.test(q),
  isAdminProfileQuestion: (q) => /admin profile/i.test(q),
  isNamedPurchasingQuestion: (q) => /purchase/i.test(q),
  isFusionRunnerSetupQuestion: (q) => /fusion runner setup/i.test(q)
};

describe('classifyBotRequestType', () => {
  it('returns "empty" for no question', () => {
    expect(classifyBotRequestType('', predicates)).toBe('empty');
    expect(classifyBotRequestType(null, predicates)).toBe('empty');
  });

  it('classifies each recognized request kind, matching handleHubAppMention\'s own branch order', () => {
    expect(classifyBotRequestType('/edit rename the app', predicates)).toBe('edit');
    expect(classifyBotRequestType('/status', predicates)).toBe('status');
    expect(classifyBotRequestType('/team 971', predicates)).toBe('team-report');
    expect(classifyBotRequestType('what is my assignment', predicates)).toBe('scouting-assignment');
    expect(classifyBotRequestType('show admin profile for X', predicates)).toBe('admin-profile');
    expect(classifyBotRequestType('purchase status', predicates)).toBe('purchasing');
    expect(classifyBotRequestType('fusion runner setup help', predicates)).toBe('fusion-runner-setup');
  });

  it('falls back to "qa" for anything none of the predicates recognize', () => {
    expect(classifyBotRequestType('where is the JProg tab', predicates)).toBe('qa');
  });
});

describe('logBotRequest', () => {
  it('inserts a row with the given fields', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const supa = { from: vi.fn(() => ({ insert })) };
    await logBotRequest(supa, {
      slackUserId: 'U1', channelId: 'C1', threadTs: '1.0', eventTs: '1.1',
      requestType: 'edit', question: '/edit rename the app', outcome: 'ok',
      durationMs: 123, responseTs: '1.2'
    });
    expect(supa.from).toHaveBeenCalledWith('hub_bot_requests');
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      slack_user_id: 'U1',
      channel_id: 'C1',
      thread_ts: '1.0',
      event_ts: '1.1',
      request_type: 'edit',
      question: '/edit rename the app',
      outcome: 'ok',
      duration_ms: 123,
      response_ts: '1.2'
    }));
  });

  it('does nothing when no Supabase client is given', async () => {
    await expect(logBotRequest(null, { requestType: 'qa', outcome: 'ok' })).resolves.toBeUndefined();
  });

  it('never throws when the insert itself fails', async () => {
    const supa = { from: () => ({ insert: () => { throw new Error('boom'); } }) };
    await expect(logBotRequest(supa, { requestType: 'qa', outcome: 'ok' })).resolves.toBeUndefined();
  });

  it('never throws when Supabase reports an insert error', async () => {
    const supa = { from: () => ({ insert: async () => ({ error: { message: 'RLS denied' } }) }) };
    await expect(logBotRequest(supa, { requestType: 'qa', outcome: 'ok' })).resolves.toBeUndefined();
  });

  it('truncates an overly long question/error rather than failing the insert', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const supa = { from: () => ({ insert }) };
    await logBotRequest(supa, {
      requestType: 'qa',
      outcome: 'error',
      question: 'x'.repeat(5000),
      errorMessage: 'y'.repeat(5000)
    });
    const arg = insert.mock.calls[0][0];
    expect(arg.question.length).toBe(2000);
    expect(arg.error_message.length).toBe(2000);
  });
});
