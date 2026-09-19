import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handleHubAppMention } = vi.hoisted(() => ({ handleHubAppMention: vi.fn() }));

vi.mock('$lib/server/971bot', () => ({
  verifySlackSignature: () => true,
  approvePurchaseInDb: vi.fn(),
  getSlackClient: vi.fn(),
  ensureApproverDmChannel: vi.fn(),
  messageToPurchaseMap: new Map(),
  getSupabase: vi.fn()
}));
vi.mock('$lib/server/planner_notifications.js', () => ({ handlePlannerReaction: vi.fn() }));
vi.mock('$lib/server/slack_notifications.js', () => ({ handleP0BugAssignmentReaction: vi.fn() }));
vi.mock('$lib/server/hub_slack_assistant.js', () => ({ handleHubAppMention }));

const { POST } = await import('./+server.js');

function slackRequest(payload) {
  return new Request('https://hub.test/api/971bot/slack/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

describe('Slack app mention events', () => {
  beforeEach(() => handleHubAppMention.mockReset().mockResolvedValue({ ok: true }));

  it('routes app_mention events to the Hub assistant', async () => {
    const event = { type: 'app_mention', channel: 'C1', ts: '1.0', text: '<@U971> status' };
    const response = await POST({ request: slackRequest({ type: 'event_callback', event_id: 'Ev-one', event }) });
    expect(response.status).toBe(200);
    expect(handleHubAppMention).toHaveBeenCalledWith(event);
    expect(await response.json()).toMatchObject({ ok: true, handled: true });
  });

  it('deduplicates Slack retries by event_id', async () => {
    const event = { type: 'app_mention', channel: 'C1', ts: '2.0', text: '<@U971> help' };
    await POST({ request: slackRequest({ type: 'event_callback', event_id: 'Ev-two', event }) });
    const duplicate = await POST({ request: slackRequest({ type: 'event_callback', event_id: 'Ev-two', event }) });
    expect(handleHubAppMention).toHaveBeenCalledTimes(1);
    expect(await duplicate.json()).toMatchObject({ ok: true, duplicate: true });
  });
});
