import { describe, expect, it, vi } from 'vitest';
import {
  askGroqAboutHub,
  formatHubStatus,
  handleHubAppMention,
  isHubStatusRequest,
  stripAppMention
} from './hub_slack_assistant.js';

const snapshot = {
  databaseOk: true,
  eventKey: '2026cc',
  openAceIssues: 2,
  openScoutingAssignments: 8,
  matchReportCount: 42
};

function supabaseForStatus() {
  return {
    from: (table) => {
      const result = table === 'scouting_settings'
        ? { data: { event_key: '2026cc' }, error: null }
        : { data: null, error: null, count: table === 'pit_problem_reports' ? 2 : table === 'scout_match_assignments' ? 8 : 42 };
      const query = {
        select: () => query,
        eq: () => query,
        is: () => query,
        like: () => query,
        maybeSingle: async () => result,
        then: (resolve) => Promise.resolve(result).then(resolve)
      };
      return query;
    }
  };
}

describe('Slack Hub assistant', () => {
  it('removes Slack mention markup and recognizes the status command', () => {
    expect(stripAppMention('<@U123ABC> status')).toBe('status');
    expect(isHubStatusRequest('Hub status please')).toBe(true);
    expect(isHubStatusRequest('Where is Match Scouting?')).toBe(false);
  });

  it('formats live status and recent changes', () => {
    const text = formatHubStatus(snapshot);
    expect(text).toContain('*Spartans Hub status:* Operational');
    expect(text).toContain('*Active scouting event:* 2026cc');
    expect(text).toContain('*Open ACE / Pit issues:* 2');
    expect(text).toContain('*Most recent changes:*');
  });

  it('calls Groq without exposing its key in the request body and sanitizes mass mentions', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '<!channel> Open Match Scouting.' } }] })
    });
    const answer = await askGroqAboutHub('Where do I scout?', snapshot, { apiKey: 'test-secret', fetchImpl });
    const request = fetchImpl.mock.calls[0][1];
    expect(request.headers.Authorization).toBe('Bearer test-secret');
    expect(request.body).not.toContain('test-secret');
    expect(answer).toBe('@channel (mention suppressed) Open Match Scouting.');
  });

  it('answers status in the mention thread without calling Groq', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, channel: 'C1', ts: '2.0' });
    const result = await handleHubAppMention({ channel: 'C1', ts: '1.0', text: '<@U971> status' }, {
      supa: supabaseForStatus(),
      slack: { chat: { postMessage } },
      apiKey: 'unused',
      fetchImpl: vi.fn()
    });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C1', thread_ts: '1.0' }));
    expect(postMessage.mock.calls[0][0].text).toContain('Operational');
    expect(result.ok).toBe(true);
  });
});
