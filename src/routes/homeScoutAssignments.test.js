import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('Home scouting assignment history', () => {
  it('keeps completed assignments visible while excluding them from upcoming work', () => {
    expect(source).toContain('incompleteScoutAssignments = myScoutAssignments.filter');
    expect(source).toContain('{#each myScoutAssignments as assignment}');
    expect(source).not.toContain('myScoutAssignments.slice(');
    expect(source).toContain('class:completed={!!assignment.completed_at}');
    expect(source).toContain("Done{assignment.scouting_type === 'data' ? ' — tap to edit' : ''}");
  });

  it('routes data assignments back to the event-scoped Match Scouting report', () => {
    expect(source).toContain("if (scoutingType === 'data') return 'matchscout'");
    expect(source).toContain('event_key: assignmentEventKey(assignment?.match_key)');
    expect(source).toContain('return `/matchscout?${params.toString()}`');
  });

  it('shows the active TBA match and both alliances', () => {
    expect(source).toContain('selectCurrentEventMatch(payload.data || [])');
    expect(source).toContain("currentMatchState === 'current' ? 'Current match'");
    expect(source).toContain('currentEventMatch.alliances?.red?.team_keys');
    expect(source).toContain('currentEventMatch.alliances?.blue?.team_keys');
    expect(source).toContain('setInterval(() => { if (user) loadMatchAlliances(); }, 60_000)');
  });
});
