import { describe, expect, it } from 'vitest';
import { fetchPlannerSnapshot, normalizeP0BugStatus, plannerTeamEnabled } from './planner_data.js';

describe('normalizeP0BugStatus', () => {
  it('passes through the canonical statuses unchanged', () => {
    expect(normalizeP0BugStatus('red')).toBe('red');
    expect(normalizeP0BugStatus('yellow')).toBe('yellow');
    expect(normalizeP0BugStatus('green')).toBe('green');
    expect(normalizeP0BugStatus('completed')).toBe('completed');
  });

  it('maps legacy "done"/"closed" to completed', () => {
    expect(normalizeP0BugStatus('done')).toBe('completed');
    expect(normalizeP0BugStatus('closed')).toBe('completed');
  });

  it('maps "approved" to green', () => {
    expect(normalizeP0BugStatus('approved')).toBe('green');
  });

  it('maps in-progress-ish legacy statuses to yellow', () => {
    expect(normalizeP0BugStatus('in_progress')).toBe('yellow');
    expect(normalizeP0BugStatus('file_uploaded')).toBe('yellow');
    expect(normalizeP0BugStatus('under_review')).toBe('yellow');
  });

  it('maps "open"/"changes_requested" to red', () => {
    expect(normalizeP0BugStatus('open')).toBe('red');
    expect(normalizeP0BugStatus('changes_requested')).toBe('red');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(normalizeP0BugStatus('  DONE  ')).toBe('completed');
    expect(normalizeP0BugStatus('Open')).toBe('red');
  });

  it('falls back to the default ("red") for an unrecognized value', () => {
    expect(normalizeP0BugStatus('some_unknown_status')).toBe('red');
    expect(normalizeP0BugStatus(null)).toBe('red');
  });

  it('honors an explicit fallback override', () => {
    expect(normalizeP0BugStatus('unknown', 'green')).toBe('green');
  });
});

describe('plannerTeamEnabled', () => {
  it('enables the known FRC team numbers', () => {
    expect(plannerTeamEnabled('971')).toBe(true);
    expect(plannerTeamEnabled('9584')).toBe(true);
  });

  it('disables any other team', () => {
    expect(plannerTeamEnabled('254')).toBe(false);
    expect(plannerTeamEnabled(undefined)).toBe(false);
  });
});

function legacyQuery(result) {
  return {
    select: () => legacyQuery(result),
    eq: () => legacyQuery(result),
    neq: () => legacyQuery(result),
    order: () => legacyQuery(result),
    then: (resolve) => Promise.resolve(result).then(resolve)
  };
}

describe('fetchPlannerSnapshot legacy schema fallback', () => {
  it('uses planner_item_owners when the modern item columns are not deployed', async () => {
    const database = {
      from(table) {
        if (table === 'planner_items') return legacyQuery(table === 'planner_items' ? { data: null, error: { code: '42703', message: 'column item_type does not exist' } } : {});
        const rows = {
          planner_dependencies: [], planner_calendar_rules: [], planner_item_owners: [{ planner_item_id: 'item-1', user_id: 'owner-1', owner_type: 'owner' }], planner_item_p0_bugs: [], planner_calendar_rule_recipients: []
        };
        return legacyQuery({ data: rows[table] || [], error: null });
      }
    };
    // The legacy item request is the second planner_items call.
    let itemCalls = 0;
    database.from = (table) => {
      if (table === 'planner_items') {
        itemCalls += 1;
        return legacyQuery(itemCalls === 1
          ? { data: null, error: { code: '42703', message: 'column item_type does not exist' } }
          : { data: [{ id: 'item-1', frc_team: '971', kind: 'task', title: 'Legacy task', category: 'cad', status: 'green' }], error: null });
      }
      const rows = { planner_dependencies: [], planner_calendar_rules: [], planner_item_owners: [{ planner_item_id: 'item-1', user_id: 'owner-1', owner_type: 'owner' }], planner_item_p0_bugs: [], planner_calendar_rule_recipients: [] };
      return legacyQuery({ data: rows[table] || [], error: null });
    };
    const snapshot = await fetchPlannerSnapshot(database, '971');
    expect(snapshot.items[0]).toMatchObject({ id: 'item-1', item_type: 'task', details: null });
    expect(snapshot.owner_rows).toEqual([expect.objectContaining({ user_id: 'owner-1', owner_type: 'owner' })]);
  });
});
