import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handleHubAppMention, isHubAssistantChannelAllowed, getSupabase, claimSlackEvent, completeSlackEvent, failSlackEvent } = vi.hoisted(() => ({
  handleHubAppMention: vi.fn(),
  isHubAssistantChannelAllowed: vi.fn(),
  getSupabase: vi.fn(() => ({ name: 'test-supabase' })),
  claimSlackEvent: vi.fn(),
  completeSlackEvent: vi.fn(),
  failSlackEvent: vi.fn()
}));

vi.mock('$lib/server/971bot', () => ({
  verifySlackSignature: () => true,
  approvePurchaseInDb: vi.fn(),
  getSlackClient: vi.fn(),
  ensureApproverDmChannel: vi.fn(),
  messageToPurchaseMap: new Map(),
  getSupabase
}));
vi.mock('$lib/server/planner_notifications.js', () => ({ handlePlannerReaction: vi.fn() }));
vi.mock('$lib/server/slack_notifications.js', () => ({ handleP0BugAssignmentReaction: vi.fn() }));
vi.mock('$lib/server/hub_slack_assistant.js', () => ({ handleHubAppMention, isHubAssistantChannelAllowed }));
vi.mock('$lib/server/slack_event_receipts.js', () => ({ claimSlackEvent, completeSlackEvent, failSlackEvent }));

const { POST } = await import('./+server.js');

function slackRequest(payload) {
  return new Request('https://hub.test/api/971bot/slack/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

describe('Slack app mention events', () => {
  beforeEach(() => {
    handleHubAppMention.mockReset().mockResolvedValue({ ok: true });
    isHubAssistantChannelAllowed.mockReset().mockResolvedValue(true);
    claimSlackEvent.mockReset().mockResolvedValue({ claimed: true, retried: false });
    completeSlackEvent.mockReset().mockResolvedValue(undefined);
    failSlackEvent.mockReset().mockResolvedValue(undefined);
  });

  it('ignores mentions outside the ACE/Pit channel before claiming a receipt', async () => {
    isHubAssistantChannelAllowed.mockResolvedValueOnce(false);
    const event = { type: 'app_mention', channel: 'C-RANDOM', ts: '1.5', text: '<@U971APP> status' };
    const response = await POST({ request: slackRequest({ type: 'event_callback', event_id: 'Ev-wrong-channel', event }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, ignored: true, reason: 'channel-not-allowed' });
    expect(claimSlackEvent).not.toHaveBeenCalled();
    expect(handleHubAppMention).not.toHaveBeenCalled();
  });

  it('routes app_mention events to the Hub assistant', async () => {
    const event = { type: 'app_mention', channel: 'C1', ts: '1.0', text: '<@U971> status' };
    const response = await POST({ request: slackRequest({ type: 'event_callback', event_id: 'Ev-one', event }) });
    expect(response.status).toBe(200);
    expect(handleHubAppMention).toHaveBeenCalledWith(event, { supa: { name: 'test-supabase' } });
    expect(completeSlackEvent).toHaveBeenCalledWith({ name: 'test-supabase' }, 'Ev-one');
    expect(await response.json()).toMatchObject({ ok: true, handled: true });
  });

  it('deduplicates Slack retries by event_id', async () => {
    const event = { type: 'app_mention', channel: 'C1', ts: '2.0', text: '<@U971> help' };
    claimSlackEvent.mockResolvedValueOnce({ claimed: true }).mockResolvedValueOnce({ claimed: false });
    await POST({ request: slackRequest({ type: 'event_callback', event_id: 'Ev-two', event }) });
    const duplicate = await POST({ request: slackRequest({ type: 'event_callback', event_id: 'Ev-two', event }) });
    expect(handleHubAppMention).toHaveBeenCalledTimes(1);
    expect(await duplicate.json()).toMatchObject({ ok: true, duplicate: true });
  });

  it('marks failed events for a safe retry and returns a retryable status', async () => {
    handleHubAppMention.mockRejectedValueOnce(new Error('temporary Slack failure'));
    const event = { type: 'app_mention', channel: 'C1', ts: '3.0', text: '<@U971> help' };
    const response = await POST({ request: slackRequest({ type: 'event_callback', event_id: 'Ev-three', event }) });
    expect(response.status).toBe(503);
    expect(failSlackEvent).toHaveBeenCalledWith({ name: 'test-supabase' }, 'Ev-three', expect.any(Error));
  });

  it('requests a retry when the durable receipt cannot be claimed', async () => {
    claimSlackEvent.mockRejectedValueOnce(new Error('database unavailable'));
    const event = { type: 'app_mention', channel: 'C1', ts: '4.0', text: '<@U971> status' };
    const response = await POST({ request: slackRequest({ type: 'event_callback', event_id: 'Ev-four', event }) });
    expect(response.status).toBe(503);
    expect(handleHubAppMention).not.toHaveBeenCalled();
    expect(failSlackEvent).not.toHaveBeenCalled();
  });

  it('does not make an already-posted reply retryable when receipt completion fails', async () => {
    completeSlackEvent.mockRejectedValueOnce(new Error('completion update failed'));
    const event = { type: 'app_mention', channel: 'C1', ts: '5.0', text: '<@U971> status' };
    const response = await POST({ request: slackRequest({ type: 'event_callback', event_id: 'Ev-five', event }) });
    expect(response.status).toBe(200);
    expect(failSlackEvent).not.toHaveBeenCalled();
  });
});
