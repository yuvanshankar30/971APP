import { describe, expect, it, vi } from 'vitest';
import { buildSlackActivityEntry, recordSlackActivity } from './slack_activity.js';

describe('Slack activity logging', () => {
  it('creates a readable activity-log row without changing the message content', () => {
    expect(buildSlackActivityEntry({
      text: 'Team 971\nwas assigned to scouting.',
      channel: 'D123',
      ts: '123.45',
      recipient: 'Arya Saikia',
      category: 'Scouting assignment',
      notificationKey: 'shift_assignments'
    })).toMatchObject({
      table_name: 'slack_messages',
      operation: 'INSERT',
      row_id: 'D123:123.45',
      actor: null,
      changed_columns: [],
      new_data: {
        name: 'Scouting assignment',
        message: 'Team 971 was assigned to scouting.',
        recipient: 'Arya Saikia',
        notification_key: 'shift_assignments'
      }
    });
  });

  it('does not log blank messages', async () => {
    const insert = vi.fn();
    const supa = { from: vi.fn(() => ({ insert })) };
    await expect(recordSlackActivity(supa, { text: '   ' })).resolves.toBe(false);
    expect(supa.from).not.toHaveBeenCalled();
  });
});
