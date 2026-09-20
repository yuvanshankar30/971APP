function clean(value, fallback = null) {
  const text = String(value || '').trim();
  return text || fallback;
}

export function scoutObservation({ report, scoutId, scoutName, reportedAt = new Date().toISOString() }) {
  return {
    created_by: clean(scoutId),
    scout_name: clean(scoutName, 'Match Scout'),
    summary: clean(report?.summary, 'Mechanical issue flagged after match'),
    detail: clean(report?.detail),
    severity: report?.severity === 'urgent' ? 'urgent' : 'watch',
    reported_at: reportedAt
  };
}

export function mergeScoutObservation(existing, incoming) {
  const observations = Array.isArray(existing) ? existing.filter((item) => item && typeof item === 'object') : [];
  const identity = incoming?.created_by || incoming?.scout_name;
  const index = observations.findIndex((item) => (item.created_by || item.scout_name) === identity);
  if (index === -1) return [...observations, incoming];
  return observations.map((item, itemIndex) => itemIndex === index ? incoming : item);
}

export function combinedPitProblemFields(observations) {
  const reports = Array.isArray(observations) ? observations : [];
  if (!reports.length) return { summary: 'Mechanical issue flagged after match', detail: null, severity: 'watch' };
  const detail = reports.map((report) => {
    const label = clean(report.scout_name, 'Match Scout');
    const summary = clean(report.summary, 'Mechanical issue flagged after match');
    const extra = clean(report.detail);
    return `${label}: ${summary}${extra ? ` — ${extra}` : ''}`;
  }).join('\n');
  return {
    summary: reports.length === 1 ? reports[0].summary : `${reports.length} scouts reported issues for this robot`,
    detail,
    severity: reports.some((report) => report.severity === 'urgent') ? 'urgent' : 'watch'
  };
}
