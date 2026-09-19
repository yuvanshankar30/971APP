import { describe, expect, it, vi } from 'vitest';
import { acePitProblemMessage, acePitTeamThreadMessage, sendAcePitProblem } from './ace_pit_notifications.js';

const problem = {
  id: 'problem-1',
  event_key: '2026cc',
  match_key: '2026cc_qm12',
  team_key: 'frc971',
  summary: 'Left drive gearbox failed',
  detail: 'Robot stopped near the hub',
  severity: 'urgent',
  resolved: false
};

function activitySupa(insert = vi.fn().mockResolvedValue({ error: null })) {
  return { from: () => ({ insert }) };
}

describe('ACE pit Slack notifications', () => {
  it('formats a useful team update and neutralizes mass mentions', () => {
    const text = acePitProblemMessage({ ...problem, detail: '<!channel> inspect immediately' }, 'Scout One');
    expect(text).toContain(':rotating_light: *Team 971 — URGENT pit update*');
    expect(text).toContain('*Match:* Qualification 12');
    expect(text).toContain('*Competition:* 2026cc');
    expect(text).toContain('@channel inspect immediately');
    expect(text).not.toContain('<!channel>');
  });

  it('combines all of the same robot observations in one update', () => {
    const text = acePitProblemMessage({
      ...problem,
      scout_observations: [
        { scout_name: 'Scout One', summary: 'Drive failed', detail: 'left side' },
        { scout_name: 'Scout Two', summary: 'Robot stopped', detail: 'after contact' }
      ]
    });
    expect(text).toContain('*Scout reports (2):*');
    expect(text).toContain('*Scout One:* Drive failed — left side');
    expect(text).toContain('*Scout Two:* Robot stopped — after contact');
  });

  it('summarizes only one affected team in its parent message', () => {
    const text = acePitTeamThreadMessage('2026cc', 'frc971', [problem]);
    expect(text).toContain('*ACE / Pit thread — Team 971 · 2026cc*');
    expect(text).toContain('*Qualification 12*');
    expect(text).toContain('(1 scout)');
  });

  it('posts a new report as a reply in that team thread and logs it', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, channel: 'CACE', ts: 'reply.1' });
    const insert = vi.fn().mockResolvedValue({ error: null });
    const result = await sendAcePitProblem(problem, 'Scout One', {
      client: { chat: { postMessage } },
      supa: activitySupa(insert),
      ensureThread: vi.fn().mockResolvedValue({ channel: 'CACE', rootTs: 'root.1' })
    });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'CACE', thread_ts: 'root.1' }));
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ table_name: 'slack_messages' }));
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      channel: 'CACE',
      ts: 'root.1',
      replyTs: 'reply.1',
      duplicate: false
    }));
  });

  it('does not send an unchanged report a second time', async () => {
    const text = acePitProblemMessage(problem, 'Scout One');
    const postMessage = vi.fn();
    const result = await sendAcePitProblem({ ...problem, slack_last_payload: text }, 'Scout One', {
      client: { chat: { postMessage } },
      supa: activitySupa(),
      ensureThread: vi.fn().mockResolvedValue({ channel: 'CACE', rootTs: 'root.1' })
    });
    expect(postMessage).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ ok: true, duplicate: true, ts: 'root.1' }));
  });

  it('sends a resolution as a thread update', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, channel: 'CACE', ts: 'reply.2' });
    await sendAcePitProblem({ ...problem, resolved: true }, 'Pit Lead', {
      client: { chat: { postMessage } },
      supa: activitySupa(),
      ensureThread: vi.fn().mockResolvedValue({ channel: 'CACE', rootTs: 'root.1' })
    });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      thread_ts: 'root.1',
      text: expect.stringContaining(':white_check_mark: *Team 971 — issue resolved*')
    }));
  });
});
