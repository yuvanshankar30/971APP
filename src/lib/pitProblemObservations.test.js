import { describe, expect, it } from 'vitest';
import { combinedPitProblemFields, mergeScoutObservation, scoutObservation } from './pitProblemObservations.js';

describe('shared ACE pit observations', () => {
  it('combines different scouts without losing either report', () => {
    const first = scoutObservation({ report: { summary: 'Hopper fell off', severity: 'watch' }, scoutId: 'alex', scoutName: 'Alex', reportedAt: 'one' });
    const second = scoutObservation({ report: { summary: 'Front panel broke', detail: 'After a collision', severity: 'urgent' }, scoutId: 'mason', scoutName: 'Mason', reportedAt: 'two' });
    const observations = mergeScoutObservation(mergeScoutObservation([], first), second);
    expect(observations).toHaveLength(2);
    expect(combinedPitProblemFields(observations)).toEqual({
      summary: '2 scouts reported issues for this robot',
      detail: 'Alex: Hopper fell off\nMason: Front panel broke — After a collision',
      severity: 'urgent'
    });
  });

  it('replaces only the same scout observation when they edit', () => {
    const observations = [
      { created_by: 'alex', scout_name: 'Alex', summary: 'Old' },
      { created_by: 'mason', scout_name: 'Mason', summary: 'Keep me' }
    ];
    expect(mergeScoutObservation(observations, { created_by: 'alex', scout_name: 'Alex', summary: 'Corrected' }))
      .toEqual([
        { created_by: 'alex', scout_name: 'Alex', summary: 'Corrected' },
        { created_by: 'mason', scout_name: 'Mason', summary: 'Keep me' }
      ]);
  });
});
