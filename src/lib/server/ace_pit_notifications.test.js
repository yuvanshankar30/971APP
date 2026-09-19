import { describe, expect, it, vi } from 'vitest';
import { acePitCompetitionThreadMessage, acePitProblemMessage, sendAcePitProblem } from './ace_pit_notifications.js';

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

  it('summarizes all affected teams in one competition parent message', () => {
    const text = acePitCompetitionThreadMessage('2026cc', [
      problem,
      { ...problem, id: 'problem-2', team_key: 'frc254', match_key: '2026cc_qm13', summary: 'Intake jammed' }
    ]);
    expect(text).toContain('*ACE / Pit issues — 2026cc*');
    expect(text).toContain('*Team 971 · Qualification 12*');
    expect(text).toContain('*Team 254 · Qualification 13*');
    expect(text).toContain('(1 scout)');
  });

  it('does not send new reports, edits, or resolutions', async () => {
    const postMessage = vi.fn();
    const result = await sendAcePitProblem(problem, 'Scout One', {
      client: { chat: { postMessage } },
      supa: {},
      ensureThread: vi.fn()
    });
    expect(postMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: 'ace-pit-notifications-disabled' });
  });
});
