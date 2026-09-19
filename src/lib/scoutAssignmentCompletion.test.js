import { describe, expect, it } from 'vitest';
import { assignmentCompletionEvidence, canonicalScoutMatchSuffix } from './scoutAssignmentCompletion.js';

describe('scout assignment completion matching', () => {
  it.each([
    ['1', 'qm1'], ['qm01', 'qm1'], ['2026cc_qm14', 'qm14'],
    ['Qual 4', 'qm4'], ['Quals8', 'qm8'], ['Chezy quals - 7', 'qm7'],
    ['Qualification #22', 'qm22'], ['2026cc_qf1m2', 'qf1m2'],
    ['Quarterfinal 1 Match 2', 'qf1m2'], ['Finals 2', 'f1m2']
  ])('normalizes %s to %s', (input, expected) => {
    expect(canonicalScoutMatchSuffix(input)).toBe(expected);
  });

  it('derives completion from a same-event, same-team report while preserving the assignment', () => {
    const assignment = { id: 'assignment-1', match_key: '2026cc_qm1', team_key: 'frc971', completed_at: null };
    expect(assignmentCompletionEvidence([assignment], [{
      event_key: '2026cc', match_key: 'Quals 1', team_key: '971', updated_at: '2026-09-19T16:56:43Z'
    }])).toEqual([{ ...assignment, completed_at: '2026-09-19T16:56:43Z' }]);
  });

  it('does not complete an assignment from another event or team', () => {
    const assignment = { id: 'assignment-1', match_key: '2026cc_qm1', team_key: 'frc971', completed_at: null };
    const reports = [
      { event_key: '2026cc', match_key: 'Quals 1', team_key: 'frc254', updated_at: 'now' },
      { event_key: '2026cahal', match_key: 'Quals 1', team_key: 'frc971', updated_at: 'now' }
    ];
    expect(assignmentCompletionEvidence([assignment], reports)).toEqual([assignment]);
  });
});
