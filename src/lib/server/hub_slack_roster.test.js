import { describe, expect, it } from 'vitest';
import { identifyRosterQuestion, loadHubRoster } from './hub_slack_roster.js';

const members = [
  { name: 'Alex Smith', teamRole: 'Mechanical Member', roles: ['Manufacturing Roles: Router Lead'] },
  { name: 'Casey Scout', teamRole: 'Competition Lead', roles: ['Scouting Roles: Match Scout'] },
  { name: 'Jordan Lee', teamRole: 'Mechanical Member', roles: ['Manufacturing Roles: Lead'] }
];

describe('Hub Slack roster lookup', () => {
  it('reads Admin roster membership and role assignments without private profile fields', async () => {
    const data = {
      user_profiles: [{ id: 'u1', full_name: 'Alex Smith', team_role: 'Mechanical Member', email: 'private@example.com' }],
      rosters: [{ id: 'r1', name: 'Manufacturing Roles' }],
      roster_entries: [{ user_id: 'u1', roster_id: 'r1', key: { key_name: 'Router Lead' } }]
    };
    const supa = { from: (table) => ({ select: async () => ({ data: data[table], error: null }) }) };
    const roster = await loadHubRoster(supa);
    expect(roster).toEqual([members[0]]);
    expect(JSON.stringify(roster)).not.toContain('private@example.com');
  });

  it('uses the roster for named and role questions and searches only after a miss', () => {
    expect(identifyRosterQuestion('What do you think of Alex Smith?', members).members).toEqual([members[0]]);
    expect(identifyRosterQuestion('Who is the router lead?', members).members).toEqual([members[0]]);
    expect(identifyRosterQuestion('Who is manufacturing lead?', members).members).toEqual([members[2]]);
    expect(identifyRosterQuestion('Who is Morgan Lee?', members)).toMatchObject({ aboutPerson: true, members: [], searchName: 'morgan lee' });
    expect(identifyRosterQuestion('Is Morgan Lee a good engineer?', members)).toMatchObject({ aboutPerson: true, members: [], searchName: 'Morgan Lee' });
    expect(identifyRosterQuestion('How does a Haas TL-1 work?', members).aboutPerson).toBe(false);
  });
});
