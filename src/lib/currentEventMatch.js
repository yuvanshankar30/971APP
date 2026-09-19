const LEVEL_ORDER = { pm: 0, qm: 1, ef: 2, qf: 3, sf: 4, f: 5 };

export function compareEventMatches(left, right) {
  const level = (LEVEL_ORDER[left?.comp_level] ?? 99) - (LEVEL_ORDER[right?.comp_level] ?? 99);
  return level || (left?.set_number || 0) - (right?.set_number || 0)
    || (left?.match_number || 0) - (right?.match_number || 0);
}

export function matchDisplayName(match) {
  const level = String(match?.comp_level || '').toLowerCase();
  if (level === 'qm') return `Qualification ${match?.match_number || '?'}`;
  const names = { pm: 'Practice', ef: 'Eighthfinal', qf: 'Quarterfinal', sf: 'Semifinal', f: 'Final' };
  const name = names[level] || 'Match';
  if (level === 'pm') return `${name} ${match?.match_number || '?'}`;
  return `${name} ${match?.set_number || '?'}-${match?.match_number || '?'}`;
}

export function selectCurrentEventMatch(matches, nowSeconds = Date.now() / 1000) {
  const ordered = [...(matches || [])].filter(match => match?.key).sort(compareEventMatches);
  if (!ordered.length) return { match: null, state: 'unavailable' };

  const next = ordered.find(match => !match.actual_time && !match.post_result_time);
  if (next) {
    const estimate = Number(next.predicted_time || next.time || 0);
    return {
      match: next,
      // TBA posts actual_time/result after play. The first unplayed match is
      // the field's current match when its live estimate has arrived; before
      // that it is explicitly labeled Up next rather than pretending.
      state: estimate && estimate > nowSeconds + 5 * 60 ? 'upcoming' : 'current'
    };
  }

  return { match: ordered[ordered.length - 1], state: 'complete' };
}

export function displayTeamNumber(teamKey) {
  return String(teamKey || '').replace(/^frc/i, '') || '—';
}
