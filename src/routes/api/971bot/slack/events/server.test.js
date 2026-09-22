import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handleHubAppMention, getSupabase, claimSlackEvent, completeSlackEvent, failSlackEvent, isHubAssistantThread } = vi.hoisted(() => ({
  handleHubAppMention: vi.fn(),
  getSupabase: vi.fn(() => ({ name: 'test-supabase' })),
  claimSlackEvent: vi.fn(),
  completeSlackEvent: vi.fn(),
  failSlackEvent: vi.fn(),
  isHubAssistantThread: vi.fn()
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
vi.mock('$lib/server/hub_slack_assistant.js', () => ({ handleHubAppMention }));
vi.mock('$lib/server/slack_event_receipts.js', () => ({ claimSlackEvent, completeSlackEvent, failSlackEvent, isHubAssistantThread }));

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
    claimSlackEvent.mockReset().mockResolvedValue({ claimed: true, retried: false });
    completeSlackEvent.mockReset().mockResolvedValue(undefined);
    failSlackEvent.mockReset().mockResolvedValue(undefined);
    isHubAssistantThread.mockReset().mockResolvedValue(false);
  });

  it('routes mentions from any channel where Slack delivers an app_mention event', async () => {
    const event = { type: 'app_mention', channel: 'C-RANDOM', ts: '1.5', text: '<@U971APP> status' };
    const response = await POST({ request: slackRequest({ type: 'event_callback', event_id: 'Ev-member-channel', event }) });
    expect(response.status).toBe(200);
    expect(claimSlackEvent).toHaveBeenCalledWith(
      { name: 'test-supabase' },
      expect.objectContaining({ eventId: 'Ev-member-channel', channelId: 'C-RANDOM' })
    );
    expect(handleHubAppMention).toHaveBeenCalledWith(event, { supa: { name: 'test-supabase' } });
    expect(await response.json()).toMatchObject({ ok: true, handled: true });
  });

  it('routes app_mention events to the Hub assistant', async () => {
    const event = { type: 'app_mention', channel: 'C1', ts: '1.0', text: '<@U971> status' };
    const response = await POST({ request: slackRequest({ type: 'event_callback', event_id: 'Ev-one', event }) });
    expect(response.status).toBe(200);
    expect(handleHubAppMention).toHaveBeenCalledWith(event, { supa: { name: 'test-supabase' } });
    expect(completeSlackEvent).toHaveBeenCalledWith({ name: 'test-supabase' }, 'Ev-one');
    expect(await response.json()).toMatchObject({ ok: true, handled: true });
  });

  it('records an in-thread mention against the thread root for later follow-ups', async () => {
    const event = { type: 'app_mention', channel: 'C1', ts: '1.5', thread_ts: '1.0', text: '<@U971> status' };
    await POST({ request: slackRequest({ type: 'event_callback', event_id: 'Ev-in-thread', event }) });
    expect(claimSlackEvent).toHaveBeenCalledWith(
      { name: 'test-supabase' },
      expect.objectContaining({ eventId: 'Ev-in-thread', eventTs: '1.0' })
    );
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

  it('answers an unmentioned human reply in a thread started by the assistant', async () => {
    isHubAssistantThread.mockResolvedValueOnce(true);
    const event = { type: 'message', channel: 'C1', ts: '6.0', thread_ts: '1.0', user: 'U1', text: 'What role am I?' };
    const response = await POST({ request: slackRequest({ type: 'event_callback', event_id: 'Ev-thread', event }) });
    expect(isHubAssistantThread).toHaveBeenCalledWith({ name: 'test-supabase' }, 'C1', '1.0');
    expect(handleHubAppMention).toHaveBeenCalledWith(event, { supa: { name: 'test-supabase' } });
    expect(claimSlackEvent).toHaveBeenCalledWith(
      { name: 'test-supabase' },
      expect.objectContaining({ eventId: 'Ev-thread', eventType: 'message.thread_reply' })
    );
    expect(response.status).toBe(200);
  });

  it('ignores ambient messages and replies in threads the assistant did not start', async () => {
    const ambient = { type: 'message', channel: 'C1', ts: '7.0', user: 'U1', text: 'hello' };
    await POST({ request: slackRequest({ type: 'event_callback', event_id: 'Ev-ambient', event: ambient }) });
    const unrelatedThread = { ...ambient, ts: '7.1', thread_ts: '2.0', text: 'follow up' };
    await POST({ request: slackRequest({ type: 'event_callback', event_id: 'Ev-other-thread', event: unrelatedThread }) });
    expect(handleHubAppMention).not.toHaveBeenCalled();
    expect(claimSlackEvent).not.toHaveBeenCalled();
  });
});
