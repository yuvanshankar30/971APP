import { describe, expect, it, vi } from 'vitest';
import {
  acePitCompetitionThreadMessage,
  acePitProblemMessage,
  acePitThreadTitle,
  backfillUnsentAcePitProblems,
  ensureAcePitCompetitionThread,
  sendAcePitProblem
} from './ace_pit_notifications.js';

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

  it('names the thread root by date, not event key, so it reads naturally in Slack', () => {
    const text = acePitThreadTitle(new Date('2026-09-19T12:00:00-07:00'));
    expect(text).toContain('*September 19 Ace Issues*');
  });

  it('posts a brand-new report as a reply into that competition\'s thread', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, channel: 'C123', ts: '111.222' });
    const ensureThread = vi.fn().mockResolvedValue({ channel: 'C123', root_ts: '100.000' });
    const result = await sendAcePitProblem(problem, 'Scout One', {
      client: { chat: { postMessage } },
      supa: {},
      ensureThread
    });
    expect(ensureThread).toHaveBeenCalledWith(expect.anything(), expect.anything(), problem.event_key);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C123', thread_ts: '100.000' }));
    expect(result).toEqual({ ok: true, channel: 'C123', ts: '111.222', payload: expect.stringContaining('Team 971') });
  });

  it('updates the SAME reply in place for an edit or resolution, instead of posting a duplicate', async () => {
    const update = vi.fn().mockResolvedValue({ ok: true, channel: 'C123', ts: '111.222' });
    const postMessage = vi.fn();
    const ensureThread = vi.fn();
    const alreadySent = { ...problem, slack_channel: 'C123', slack_ts: '111.222' };
    const result = await sendAcePitProblem(alreadySent, 'Scout One', {
      client: { chat: { update, postMessage } },
      supa: {},
      ensureThread
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C123', ts: '111.222' }));
    expect(postMessage).not.toHaveBeenCalled();
    // An update never needs a thread lookup - it already knows exactly
    // which message to edit.
    expect(ensureThread).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, channel: 'C123', ts: '111.222', payload: expect.any(String) });
  });

  it('rejects without an id rather than silently doing nothing useful', async () => {
    const result = await sendAcePitProblem({ ...problem, id: undefined }, 'Scout One', {});
    expect(result).toEqual({ ok: false, reason: 'missing-problem-id' });
  });

  describe('ensureAcePitCompetitionThread', () => {
    it('reuses an existing thread for the event and day instead of creating a second one', async () => {
      const maybeSingle = vi.fn().mockResolvedValue({ data: { channel: 'C123', root_ts: '100.000' }, error: null });
      const supa = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle }) }) }) }) };
      const postMessage = vi.fn();
      const thread = await ensureAcePitCompetitionThread({ chat: { postMessage } }, supa, '2026cc', new Date('2026-09-19T12:00:00-07:00'));
      expect(postMessage).not.toHaveBeenCalled();
      expect(thread).toEqual({ channel: 'C123', root_ts: '100.000' });
    });

    it('creates and records a new thread when the event/day has none yet, addressed by channel NAME (not a looked-up ID)', async () => {
      // conversations.list (looking a name up into an ID) needs a Slack
      // scope this bot's token was never granted - chat.postMessage accepts
      // a bare channel name directly instead, and Slack's own response
      // carries back the real resolved ID, which is what gets stored.
      const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      const single = vi.fn().mockResolvedValue({ data: { channel: 'C999', root_ts: '200.000' }, error: null });
      const supa = {
        from: () => ({
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle, single }) }) }),
          insert: () => ({ select: () => ({ single }) })
        })
      };
      const postMessage = vi.fn().mockResolvedValue({ ok: true, channel: 'C999', ts: '200.000' });
      const thread = await ensureAcePitCompetitionThread(
        { chat: { postMessage } },
        supa,
        '2026cc',
        new Date('2026-09-19T12:00:00-07:00')
      );
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: '2026-ace-pit-bot', text: expect.stringContaining('September 19 Ace Issues') }));
      expect(thread).toEqual({ channel: 'C999', root_ts: '200.000' });
    });

    it('starts a fresh thread for the same event on a new day rather than reusing the prior day\'s', async () => {
      // No existing row for THIS day (the mock's maybeSingle always misses),
      // so every call falls through to creating a brand-new thread - proving
      // a later day never silently reuses an earlier day's thread lookup.
      const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      const single = vi.fn().mockResolvedValue({ data: { channel: 'C999', root_ts: '300.000' }, error: null });
      const supa = {
        from: () => ({
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle, single }) }) }),
          insert: () => ({ select: () => ({ single }) })
        })
      };
      const postMessage = vi.fn().mockResolvedValue({ ok: true, channel: 'C999', ts: '300.000' });
      const thread = await ensureAcePitCompetitionThread(
        { chat: { postMessage } },
        supa,
        '2026cc',
        new Date('2026-09-20T09:00:00-07:00')
      );
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('September 20 Ace Issues') }));
      expect(thread).toEqual({ channel: 'C999', root_ts: '300.000' });
    });
  });

  describe('backfillUnsentAcePitProblems', () => {
    it('sends every unsent report oldest-first and records each delivery', async () => {
      const unsent = [
        { ...problem, id: 'older', created_at: '2026-09-19T10:00:00Z' },
        { ...problem, id: 'newer', team_key: 'frc254', created_at: '2026-09-19T11:00:00Z' }
      ];
      const order = vi.fn().mockResolvedValue({ data: unsent, error: null });
      const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
      const supa = {
        from: () => ({
          select: () => ({ is: () => ({ order }) }),
          update
        })
      };
      const notify = vi.fn()
        .mockResolvedValueOnce({ ok: true, channel: 'C1', ts: '1.1', payload: 'a' })
        .mockResolvedValueOnce({ ok: true, channel: 'C1', ts: '1.2', payload: 'b' });

      const result = await backfillUnsentAcePitProblems({ supa, notify });
      expect(notify.mock.calls[0][0].id).toBe('older');
      expect(notify.mock.calls[1][0].id).toBe('newer');
      expect(result).toEqual({ ok: true, sent: 2, failed: 0, total: 2, failure_reasons: {} });
    });

    it('counts a failed delivery instead of throwing, so one bad report cannot block the rest', async () => {
      const unsent = [{ ...problem, id: 'only' }];
      const order = vi.fn().mockResolvedValue({ data: unsent, error: null });
      const supa = { from: () => ({ select: () => ({ is: () => ({ order }) }) }) };
      const notify = vi.fn().mockResolvedValue({ ok: false, reason: 'slack-error' });

      const result = await backfillUnsentAcePitProblems({ supa, notify });
      expect(result).toEqual({ ok: true, sent: 0, failed: 1, total: 1, failure_reasons: { 'slack-error': 1 } });
    });

    it('reports WHY each failure happened, not just a count, so a real backfill run is diagnosable', async () => {
      const unsent = [
        { ...problem, id: 'a' },
        { ...problem, id: 'b' },
        { ...problem, id: 'c' }
      ];
      const order = vi.fn().mockResolvedValue({ data: unsent, error: null });
      const supa = { from: () => ({ select: () => ({ is: () => ({ order }) }) }) };
      const notify = vi.fn()
        .mockResolvedValueOnce({ ok: false, reason: 'not_in_channel' })
        .mockResolvedValueOnce({ ok: false, reason: 'not_in_channel' })
        .mockResolvedValueOnce({ ok: false, reason: 'channel_not_found' });

      const result = await backfillUnsentAcePitProblems({ supa, notify });
      expect(result.failure_reasons).toEqual({ not_in_channel: 2, channel_not_found: 1 });
    });
  });
});
