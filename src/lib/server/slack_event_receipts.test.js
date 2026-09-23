import { describe, expect, it, vi } from 'vitest';
import { claimSlackEvent, completeSlackEvent, failSlackEvent, recordSlackAssistantQuestion, readSlackAssistantThread } from './slack_event_receipts.js';

function queryResult(result) {
  const query = {
    eq: vi.fn(() => query),
    select: vi.fn(() => query),
    maybeSingle: vi.fn(async () => result),
    in: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  };
  return query;
}

function supabase({ insertResult = { error: null }, updateResults = [] } = {}) {
  const updates = [...updateResults];
  const table = {
    insert: vi.fn(async () => insertResult),
    update: vi.fn(() => queryResult(updates.shift() || { error: null, data: null }))
  };
  return { client: { from: vi.fn(() => table) }, table };
}

const event = { eventId: 'Ev-123', eventType: 'app_mention', channelId: 'C1', eventTs: '1.0' };

describe('Slack event receipts', () => {
  it('claims a new event by inserting its durable receipt', async () => {
    const { client, table } = supabase();
    await expect(claimSlackEvent(client, event)).resolves.toEqual({ claimed: true, retried: false });
    expect(table.insert).toHaveBeenCalledWith(expect.objectContaining({
      event_id: 'Ev-123',
      event_type: 'app_mention',
      status: 'processing'
    }));
  });

  it('does not claim a duplicate event that is already processing or complete', async () => {
    const { client } = supabase({
      insertResult: { error: { code: '23505', message: 'duplicate key' } },
      updateResults: [{ error: null, data: null }]
    });
    await expect(claimSlackEvent(client, event)).resolves.toEqual({ claimed: false, retried: false });
  });

  it('atomically reclaims an event previously marked failed', async () => {
    const { client } = supabase({
      insertResult: { error: { code: '23505', message: 'duplicate key' } },
      updateResults: [{ error: null, data: { event_id: 'Ev-123' } }]
    });
    await expect(claimSlackEvent(client, event)).resolves.toEqual({ claimed: true, retried: true });
  });

  it('records completion and bounded failure details', async () => {
    const { client, table } = supabase({ updateResults: [{ error: null }, { error: null }] });
    await completeSlackEvent(client, 'Ev-123');
    await failSlackEvent(client, 'Ev-123', new Error('x'.repeat(800)));
    expect(table.update.mock.calls[0][0]).toMatchObject({ status: 'completed', last_error: null });
    expect(table.update.mock.calls[1][0].status).toBe('failed');
    expect(table.update.mock.calls[1][0].last_error).toHaveLength(500);
  });

  it('recalls the root question, replies, and an in-progress question in chronological order', async () => {
    const { client, table } = supabase();
    await recordSlackAssistantQuestion(client, 'Ev-current', { ts: '3.0', question: 'And then?' });
    const current = table.update.mock.calls[0][0].last_error;
    await completeSlackEvent(client, 'Ev-root', { ts: '1.0', question: '<@U1> Tell me about Alice', answer: 'Alice is the lead.' });
    const completedRoot = table.update.mock.calls[1][0].last_error;
    await completeSlackEvent(client, 'Ev-next', { ts: '2.0', question: 'What does she do?', answer: 'She leads manufacturing.' });
    const completedNext = table.update.mock.calls[2][0].last_error;
    const query = queryResult({ error: null, data: [
      { last_error: current }, // current event is excluded by timestamp
      { last_error: completedNext },
      { last_error: completedRoot },
      { last_error: 'old failure' }
    ] });
    const history = await readSlackAssistantThread({ from: () => query }, {
      channel: 'C1', threadTs: '1.0', beforeTs: '3.0'
    });
    expect(history).toEqual([
      { role: 'user', text: '<@U1> Tell me about Alice' },
      { role: 'assistant', text: 'Alice is the lead.' },
      { role: 'user', text: 'What does she do?' },
      { role: 'assistant', text: 'She leads manufacturing.' }
    ]);
    expect(query.eq).toHaveBeenCalledWith('event_ts', '1.0');
  });

  it('retrieves the original exchange when a long thread fills the recent receipt window', async () => {
    const { client, table } = supabase();
    await completeSlackEvent(client, 'Ev-root', { ts: '1.0', question: 'Original topic', answer: 'Original answer' });
    const rootContext = table.update.mock.calls[0][0].last_error;
    await completeSlackEvent(client, 'Ev-later', { ts: '50.0', question: 'Later question', answer: 'Later answer' });
    const laterContext = table.update.mock.calls[1][0].last_error;
    const recent = queryResult({ error: null, data: [{ last_error: laterContext }] });
    const root = queryResult({ error: null, data: { last_error: rootContext } });
    const from = vi.fn().mockReturnValueOnce(recent).mockReturnValueOnce(root);
    const history = await readSlackAssistantThread({ from }, {
      channel: 'C1', threadTs: '1.0', beforeTs: '51.0'
    });
    expect(history.map((turn) => turn.text)).toEqual([
      'Original topic', 'Original answer', 'Later question', 'Later answer'
    ]);
    expect(root.eq).toHaveBeenCalledWith('event_type', 'app_mention');
  });
});
