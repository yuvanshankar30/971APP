import { describe, expect, it, vi } from 'vitest';
import { claimSlackEvent, completeSlackEvent, failSlackEvent } from './slack_event_receipts.js';

function queryResult(result) {
  const query = {
    eq: vi.fn(() => query),
    select: vi.fn(() => query),
    maybeSingle: vi.fn(async () => result),
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
});
