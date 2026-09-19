import { describe, expect, it, vi } from 'vitest';
import { ACE_PIT_CHANNEL_NAME, acePitProblemMessage, sendAcePitProblem } from './ace_pit_notifications.js';

const problem = {
  id: 'problem-1',
  event_key: '2026cc',
  match_key: '2026cc_qm12',
  team_key: 'frc971',
  summary: 'Left drive gearbox failed',
  detail: 'Robot stopped near the hub',
  severity: 'urgent'
};

describe('ACE pit Slack notifications', () => {
  it('formats a useful urgent alert and neutralizes mass mentions', () => {
    const text = acePitProblemMessage({ ...problem, detail: '<!channel> inspect immediately' }, 'Scout One');
    expect(text).toContain(':rotating_light: *URGENT ACE / Pit issue*');
    expect(text).toContain('*Team:* 971');
    expect(text).toContain('*Match:* Qualification 12');
    expect(text).toContain('*Competition:* 2026cc');
    expect(text).toContain('@channel inspect immediately');
    expect(text).not.toContain('<!channel>');
  });

  it('posts new issues to the requested ACE channel and logs the delivery', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, channel: 'CACE', ts: '123.4' });
    const insert = vi.fn().mockResolvedValue({ error: null });
    const result = await sendAcePitProblem(problem, 'Scout One', {
      client: { chat: { postMessage } },
      supa: { from: () => ({ insert }) }
    });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: ACE_PIT_CHANNEL_NAME }));
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ table_name: 'slack_messages' }));
    expect(result).toEqual({ ok: true, channel: 'CACE', ts: '123.4' });
  });

  it('updates the original Slack alert when a saved issue is edited', async () => {
    const update = vi.fn().mockResolvedValue({ ok: true, channel: 'CACE', ts: '123.4' });
    await sendAcePitProblem({ ...problem, slack_channel: 'CACE', slack_ts: '123.4' }, 'Scout One', {
      client: { chat: { update } },
      supa: { from: () => ({ insert: vi.fn().mockResolvedValue({ error: null }) }) }
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ channel: 'CACE', ts: '123.4' }));
  });
});
