import { describe, expect, it, vi } from 'vitest';
import {
  askGeminiAboutHub,
  assignmentEventKey,
  fetchAdminProfileForSlackUser,
  fetchScoutingAssignmentsForSlackUser,
  fetchTeamReportSnapshot,
  formatAdminProfile,
  formatHubStatus,
  formatScoutingAssignments,
  formatTeamReportStatus,
  handleHubAppMention,
  isAdminProfileQuestion,
  isScoutingAssignmentQuestion,
  isHubStatusRequest,
  isTeamReportStatusRequest,
  shouldUseGoogleSearch,
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

function supabaseForTeamStatus() {
  return {
    from: (table) => {
      let result = { data: [], error: null, count: 0 };
      const query = {
        select: (_columns, options = {}) => {
          if (table === 'scouting_settings') result = { data: { event_key: '2026cc' }, error: null };
          else if (options.head) result = { data: null, error: null, count: table === 'scout_match_assignments' ? 1 : 2 };
          else if (table === 'scout_match_assignments') result = { data: [
            { id: 'a', match_key: '2026cc_qm1', scouting_type: 'data', completed_at: 'now' },
            { id: 'b', match_key: '2026cc_qm2', scouting_type: 'data', completed_at: null },
            { id: 'c', match_key: '2026cc_qm1', scouting_type: 'note', completed_at: 'now' }
          ], error: null };
          else if (table === 'match_scout_entries') result = { data: [
            { id: 'r1', match_key: '2026cc_qm1', created_at: 'now' },
            { id: 'r2', match_key: '2026cc_qm1', created_at: 'now' }
          ], error: null };
          else if (table === 'pit_scout_entries') result = { data: [{ id: 'p1', updated_at: 'now' }], error: null };
          return query;
        },
        eq: () => query,
        is: () => query,
        in: () => query,
        like: () => query,
        maybeSingle: async () => result,
        then: (resolve) => Promise.resolve(result).then(resolve)
      };
      return query;
    }
  };
}

function supabaseForAssignments({ admin = true } = {}) {
  const profile = {
    id: 'u-requester', full_name: 'Arin Rao', role: admin ? 'admin' : 'member', banned: false,
    permissions: [], general_role: admin ? 'lead' : 'member', purchasing_role: 'basic',
    team_role: admin ? 'Competition Lead' : 'Software Member', frc_team: '971', task_general_categories: ['Software']
  };
  const otherProfile = {
    id: 'u-other', full_name: 'Casey Scout', role: 'member', banned: false,
    permissions: ['DATA_SCOUT_MEMBER'], general_role: 'member', purchasing_role: 'basic',
    team_role: 'Other', frc_team: '9584', task_general_categories: ['Competition']
  };
  const arnavProfile = {
    id: 'u-arnav', full_name: 'Arnav Gathani', role: 'member', banned: false,
    permissions: [], general_role: 'member', purchasing_role: 'basic',
    team_role: 'Mechanical Member', frc_team: '971'
  };
  const tables = {
    scout_match_assignments: [
      { scouting_type: 'data', match_key: '2026cc_qm1', team_key: 'frc971', assigned_user: 'u-requester', completed_at: null },
      { scouting_type: 'note', match_key: '2026cc_qm2', team_key: 'frc254', assigned_user: 'u-other', completed_at: 'now' }
    ],
    scout_pit_assignments: [
      { event_key: '2026cc', team_key: 'frc971', assigned_user: 'u-other', completed_at: null }
    ],
    scout_prescout_assignments: [],
    purchasing: [
      { name: 'Rejected private prototype', project_id: 'Secret Prototype', vendor: 'Example', requester: 'Arnav Gathani', status: 'rejected', approved: false, approver: 'Someone Else', created_at: '2026-09-21T18:00:00Z' },
      { name: '1/4-20 rivet nuts', project_id: '2026 Robot', vendor: 'McMaster', requester: 'Arnav Gathani', status: 'pending', approved: false, created_at: '2026-09-20T18:00:00Z' },
      { name: 'Older bearings', project_id: 'Practice Bot', vendor: 'REV', requester: 'Arnav Gathani', status: 'ordered', approved: true, created_at: '2026-09-10T18:00:00Z' }
    ]
  };
  return {
    from: (table) => {
      const filters = {};
      let head = false;
      const query = {
        select: (_columns, options = {}) => { head = Boolean(options.head); return query; },
        eq: (key, value) => { filters[key] = value; return query; },
        is: (key, value) => { filters[key] = value; return query; },
        like: (key, value) => { filters[key] = value; return query; },
        in: (key, value) => { filters[`${key}In`] = value; return query; },
        order: () => query,
        limit: () => query,
        maybeSingle: async () => result(),
        then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject)
      };
      function result() {
        if (table === 'scouting_settings') return { data: { event_key: '2026cc' }, error: null };
        if (head) {
          const count = table === 'scout_match_assignments' ? 2 : 0;
          return { data: null, error: null, count };
        }
        if (table === 'user_profiles' && filters.slack_user_id) return { data: profile, error: null };
        if (table === 'user_profiles' && filters.idIn) {
          return { data: [profile, otherProfile, arnavProfile]
            .filter((row) => filters.idIn.includes(row.id)), error: null };
        }
        if (table === 'user_profiles') return { data: [profile, otherProfile, arnavProfile], error: null };
        if (table === 'roster_entries') {
          return { data: admin ? [{ key: { key_name: 'Scouting Admin' } }] : [], error: null };
        }
        let rows = [...(tables[table] || [])];
        if (filters.event_key) rows = rows.filter((row) => row.event_key === filters.event_key);
        if (filters.match_key) rows = rows.filter((row) => row.match_key?.startsWith(filters.match_key.replace('%', '')));
        if (filters.assigned_user) rows = rows.filter((row) => row.assigned_user === filters.assigned_user);
        if (filters.requester) rows = rows.filter((row) => row.requester === filters.requester);
        return { data: rows, error: null, count: rows.length };
      }
      return query;
    }
  };
}

describe('Slack Hub assistant', () => {
  it('removes Slack mention markup and recognizes the status command', () => {
    expect(stripAppMention('<@U123ABC> status')).toBe('status');
    expect(isHubStatusRequest('Hub status please')).toBe(true);
    expect(isHubStatusRequest('/status')).toBe(true);
    expect(isHubStatusRequest('Where is Match Scouting?')).toBe(false);
    expect(isTeamReportStatusRequest('Have all reports for team 971 been finished?')).toBe(true);
    expect(isScoutingAssignmentQuestion('What tasks were scouts assigned for Chezy?')).toBe(true);
    expect(isAdminProfileQuestion('What role am I?')).toBe(true);
    expect(isAdminProfileQuestion('What role does Casey Scout have?')).toBe(true);
    expect(shouldUseGoogleSearch('When does Madtown start?')).toBe(true);
    expect(shouldUseGoogleSearch('What shifts were scouts assigned?')).toBe(false);
    expect(shouldUseGoogleSearch('What does Scouting Admin do?')).toBe(false);
    expect(assignmentEventKey('What was assigned for Chezy?', '2026mrcmp')).toBe('2026cc');
    expect(assignmentEventKey('What was assigned for 2025 Chezy?', '2026mrcmp')).toBe('2025cc');
  });

  it('formats live status and recent changes', () => {
    const text = formatHubStatus(snapshot);
    expect(text).toContain('*Spartans Hub status:* Operational');
    expect(text).toContain('*Active scouting event:* 2026cc');
    expect(text).toContain('*Open ACE / Pit issues:* 2');
    expect(text).toContain('*Most recent changes:*');
  });

  it('calls Gemini without exposing its key in the request body and sanitizes mass mentions', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '<!channel> Open ' }, { text: 'Match Scouting.' }] } }] })
    });
    const answer = await askGeminiAboutHub('Where do I scout?', snapshot, { apiKey: 'test-secret', fetchImpl });
    const request = fetchImpl.mock.calls[0][1];
    expect(fetchImpl.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    expect(request.headers['x-goog-api-key']).toBe('test-secret');
    expect(request.body).not.toContain('test-secret');
    expect(answer).toBe('@channel (mention suppressed) Open Match Scouting.');
    expect(request.body).toContain('dead, disabled');
    expect(JSON.parse(request.body).contents[0].parts[0].text).toBe('Where do I scout?');
  });

  it('enables Google Search only when requested and appends grounded sources', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{
          content: { parts: [{ text: 'Madtown starts November 13.' }] },
          groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.test/madtown', title: 'Madtown event' } }] }
        }]
      })
    });
    const answer = await askGeminiAboutHub('When does Madtown start?', snapshot, {
      apiKey: 'test-secret',
      fetchImpl,
      useGoogleSearch: true
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.tools).toEqual([{ google_search: {} }]);
    expect(answer).toContain('<https://example.test/madtown|Madtown event>');
  });

  it('answers a general math question without offering live Hub data to an unlinked Slack user', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, channel: 'C1', ts: '2.0' });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '2' }] } }] })
    });
    await handleHubAppMention({ channel: 'C1', user: 'U1', ts: '1.0', text: '<@U971> what is 1+1?' }, {
      supa: supabaseForStatus(),
      slack: { chat: { postMessage } },
      apiKey: 'test-secret',
      fetchImpl
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
    expect(postMessage.mock.calls[0][0].text).toBe('2');
  });

  it('offers the allowlisted live-data tool to a linked active Hub user', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, channel: 'C1', ts: '2.0' });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '2' }] } }] })
    });
    await handleHubAppMention({ channel: 'C1', user: 'U-ADMIN', ts: '1.0', text: '<@U971> what is 1+1?' }, {
      supa: supabaseForAssignments({ admin: true }),
      slack: { chat: { postMessage } },
      apiKey: 'test-secret',
      fetchImpl
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.tools[0].function_declarations[0].name).toBe('query_hub_data');
    expect(postMessage.mock.calls[0][0].text).toBe('2');
  });

  it('answers detailed Hub tab questions locally instead of sending product knowledge to Gemini', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, channel: 'C1', ts: '2.0' });
    const fetchImpl = vi.fn();
    await handleHubAppMention({ channel: 'C1', user: 'U1', ts: '1.0', text: '<@U971> where are the JProg settings?' }, {
      supa: supabaseForStatus(),
      slack: { chat: { postMessage } },
      apiKey: 'test-secret',
      fetchImpl
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(postMessage.mock.calls[0][0].text).toContain('/jprog/settings');
    expect(postMessage.mock.calls[0][0].text).toContain('*Settings — JProg*');
  });

  it('answers an authorized named-person purchasing-history question locally', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, channel: 'C1', ts: '2.0' });
    const fetchImpl = vi.fn();
    await handleHubAppMention({
      channel: 'C1', user: 'U-ADMIN', ts: '1.0',
      text: "<@U971> what was Arnav Gathani's last purchasing request?"
    }, {
      supa: supabaseForAssignments({ admin: true }),
      slack: { chat: { postMessage } },
      apiKey: 'test-secret',
      fetchImpl
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(postMessage.mock.calls[0][0].text).toContain("Arnav Gathani's latest purchasing request");
    expect(postMessage.mock.calls[0][0].text).toContain('1/4-20 rivet nuts');
    expect(postMessage.mock.calls[0][0].text).not.toContain('Rejected private prototype');
    expect(postMessage.mock.calls[0][0].text).not.toContain('Older bearings');
  });

  it('blocks ordinary members from reading another person’s purchasing history', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, channel: 'C1', ts: '2.0' });
    await handleHubAppMention({
      channel: 'C1', user: 'U-MEMBER', ts: '1.0',
      text: "<@U971> what was Arnav Gathani's last purchasing request?"
    }, {
      supa: supabaseForAssignments({ admin: false }),
      slack: { chat: { postMessage } }
    });
    expect(postMessage.mock.calls[0][0].text).toContain('require Purchasing Admin access');
  });

  it('never offers the data tool alongside Google Search', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'Madtown starts November 13.' }] } }] })
    });
    await askGeminiAboutHub('When does Madtown start?', snapshot, {
      apiKey: 'test-secret',
      fetchImpl,
      supa: supabaseForStatus(),
      useGoogleSearch: true
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.tools).toEqual([{ google_search: {} }]);
  });

  it('runs a query_hub_data round trip against an allowlisted table and answers from the result', async () => {
    const queried = { table: null, columns: null };
    const supa = {
      from: (table) => {
        queried.table = table;
        const query = {
          select: (columns) => { queried.columns = columns; return query; },
          eq: () => query,
          limit: () => query,
          order: () => query,
          then: (resolve) => Promise.resolve({
            data: [{ label: 'EPA', href: '/epa', category: 'Competition', keywords: 'expected points added model ratings' }],
            error: null
          }).then(resolve)
        };
        return query;
      }
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              parts: [{ functionCall: { name: 'query_hub_data', args: { table: 'parts', filters: { status: 'active' }, limit: 5 } } }]
            }
          }]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'You have 1 active part.' }] } }] })
      });
    const answer = await askGeminiAboutHub('How many active parts are there?', snapshot, {
      apiKey: 'test-secret',
      fetchImpl,
      supa
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(queried.table).toBe('parts');
    const secondBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    const functionResponsePart = secondBody.contents.at(-1).parts[0].functionResponse;
    expect(functionResponsePart.name).toBe('query_hub_data');
    expect(functionResponsePart.response.rows).toHaveLength(1);
    expect(answer).toBe('You have 1 active part.');
  });

  it('rejects a query_hub_data call against a table that is not on the allowlist', async () => {
    const executed = [];
    const supa = { from: (table) => { executed.push(table); throw new Error('should never query a disallowed table'); } };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ functionCall: { name: 'query_hub_data', args: { table: 'user_profiles' } } }] } }]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'I could not look that up.' }] } }] })
      });
    await askGeminiAboutHub('What is my email?', snapshot, { apiKey: 'test-secret', fetchImpl, supa });
    expect(executed).toHaveLength(0);
    const secondBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(secondBody.contents.at(-1).parts[0].functionResponse.response.error).toContain('Unknown table');
  });

  it('reads all assignment types for admins and only the requester rows for members', async () => {
    const adminContext = await fetchScoutingAssignmentsForSlackUser(
      supabaseForAssignments({ admin: true }),
      'U-ADMIN',
      '2026cc'
    );
    expect(adminContext.visibility).toBe('all-scouts');
    expect(formatScoutingAssignments(adminContext, 'What tasks were scouts assigned?')).toContain('specify exactly one scout');
    const casey = formatScoutingAssignments(adminContext, 'What tasks was Casey Scout assigned?');
    expect(casey).toContain('Casey Scout');
    expect(casey).toContain('pit: T971');
    expect(casey).not.toContain('Arin Rao');

    const memberContext = await fetchScoutingAssignmentsForSlackUser(
      supabaseForAssignments({ admin: false }),
      'U-MEMBER',
      '2026cc'
    );
    expect(memberContext.visibility).toBe('requester-only');
    expect(memberContext.assignments).toHaveLength(1);
    expect(formatScoutingAssignments(memberContext, 'What are my scouting assignments?')).not.toContain('Casey Scout');
  });

  it('answers assignment questions locally without sending scout data to Gemini', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, channel: 'C1', ts: '2.0' });
    const fetchImpl = vi.fn();
    await handleHubAppMention({
      channel: 'C1',
      user: 'U-ADMIN',
      ts: '1.0',
      text: '<@U971> what tasks was Casey Scout assigned in for Chezy?'
    }, {
      supa: supabaseForAssignments({ admin: true }),
      slack: { chat: { postMessage } },
      apiKey: 'test-secret',
      fetchImpl
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(postMessage.mock.calls[0][0].text).toContain('Casey Scout');
    expect(postMessage.mock.calls[0][0].text).toContain('Q2/T254');
  });

  it('requires one scout for broad assignment questions', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, channel: 'C1', ts: '2.0' });
    const fetchImpl = vi.fn();
    await handleHubAppMention({ channel: 'C1', user: 'U-ADMIN', ts: '1.0', text: '<@U971> what tasks were scouts assigned?' }, {
      supa: supabaseForAssignments({ admin: true }),
      slack: { chat: { postMessage } },
      apiKey: 'test-secret',
      fetchImpl
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(postMessage.mock.calls[0][0].text).toContain('specify exactly one scout');
  });

  it('answers self profile questions and lets Admin-page users inspect one named profile', async () => {
    const supa = supabaseForAssignments({ admin: true });
    const self = await fetchAdminProfileForSlackUser(supa, 'U-ADMIN', 'What role am I?');
    expect(formatAdminProfile(self)).toContain('General role: lead');

    const named = await fetchAdminProfileForSlackUser(supa, 'U-ADMIN', 'What permissions does Casey Scout have?');
    const formatted = formatAdminProfile(named);
    expect(formatted).toContain('*Casey Scout*');
    expect(formatted).toContain('DATA_SCOUT_MEMBER');
    expect(formatted).not.toContain('Arin Rao');
  });

  it('does not let ordinary users inspect another profile', async () => {
    const context = await fetchAdminProfileForSlackUser(
      supabaseForAssignments({ admin: false }),
      'U-MEMBER',
      'What role does Casey Scout have?'
    );
    expect(formatAdminProfile(context)).toContain('only Admin-page users');
  });

  it('rejects a missing Gemini key and an empty model response', async () => {
    await expect(askGeminiAboutHub('hello', snapshot, { apiKey: '' })).rejects.toThrow('GEMINI_API_KEY');
    await expect(askGeminiAboutHub('hello', snapshot, {
      apiKey: 'test-secret',
      fetchImpl: async () => ({ ok: true, json: async () => ({ candidates: [] }) })
    })).rejects.toThrow('Gemini returned an empty answer');
  });

  it('reports rejected Gemini credentials without exposing provider details', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, channel: 'C1', ts: '2.0' });
    await handleHubAppMention({ channel: 'C1', ts: '1.0', text: '<@U971> where do I scout?' }, {
      supa: supabaseForStatus(),
      slack: { chat: { postMessage } },
      apiKey: 'test-secret',
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: { status: 'INVALID_ARGUMENT', message: 'API key not valid: test-secret' } })
      })
    });
    const reply = postMessage.mock.calls[0][0].text;
    expect(reply).toContain('rejected the server credential');
    expect(reply).not.toContain('test-secret');
  });

  it('reports unavailable models separately from credential failures', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, channel: 'C1', ts: '2.0' });
    await handleHubAppMention({ channel: 'C1', ts: '1.0', text: '<@U971> where do I scout?' }, {
      supa: supabaseForStatus(),
      slack: { chat: { postMessage } },
      apiKey: 'test-secret',
      fetchImpl: async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: { status: 'NOT_FOUND' } })
      })
    });
    expect(postMessage.mock.calls[0][0].text).toContain('model is unavailable');
  });

  it('reports assignment completion and submitted entries for a team without Gemini', async () => {
    const teamStatus = await fetchTeamReportSnapshot(supabaseForTeamStatus(), '971', '2026cc');
    expect(teamStatus).toMatchObject({
      totalAssignments: 3,
      completedAssignments: 2,
      remainingAssignments: 1,
      allAssignedReportsComplete: false,
      submittedMatchReports: 2,
      submittedMatchCount: 1,
      pitReportPresent: true
    });
    const text = formatTeamReportStatus(teamStatus);
    expect(text).toContain('*Assigned reports:* 2/3 complete — 1 remaining');
    expect(text).toContain('2026cc_qm2');
  });

  it('answers status in the mention thread without calling Gemini', async () => {
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

  it('answers team report completion from live tables without calling Gemini', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, channel: 'C1', ts: '2.0' });
    const fetchImpl = vi.fn();
    await handleHubAppMention({ channel: 'C1', ts: '1.0', text: '<@U971> have all reports for team 971 been finished?' }, {
      supa: supabaseForTeamStatus(),
      slack: { chat: { postMessage } },
      apiKey: 'unused',
      fetchImpl
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(postMessage.mock.calls[0][0].text).toContain('2/3 complete');
  });

  it('explains when a model-backed question needs Gemini but Gemini is not configured', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, channel: 'C1', ts: '2.0' });
    const fetchImpl = vi.fn();
    await handleHubAppMention({ channel: 'C1', ts: '1.0', text: '<@U971> summarize what changed recently' }, {
      supa: supabaseForStatus(),
      slack: { chat: { postMessage } },
      apiKey: '',
      fetchImpl
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(postMessage.mock.calls[0][0].text).toContain('not configured on this server');
  });

  it('keeps replies inside an existing Slack thread for either app display name', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, channel: 'C-ACE', ts: '8.1' });
    await handleHubAppMention({
      channel: 'C-ACE',
      ts: '8.0',
      thread_ts: '7.0',
      text: '<@U971APP> /status'
    }, {
      supa: supabaseForStatus(),
      slack: { chat: { postMessage } }
    });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C-ACE', thread_ts: '7.0' }));
  });
});
