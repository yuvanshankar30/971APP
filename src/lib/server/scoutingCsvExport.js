const FORMULA_PREFIX = /^[=+\-@]/;

function scalarValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function csvCell(value) {
  let text = scalarValue(value);
  // CSVs are commonly opened in Excel/Sheets. Prevent user-entered notes
  // from becoming executable spreadsheet formulas on open.
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function scoutingDatasetsToCsv(datasets = []) {
  const rows = datasets.flatMap(({ name, rows: datasetRows = [] }) => (
    datasetRows.map((row) => ({ dataset: name, ...(row || {}) }))
  ));
  const discovered = new Set(rows.flatMap((row) => Object.keys(row)));
  const preferred = ['dataset', 'event_key', 'match_key', 'team_key'];
  const columns = [
    ...preferred.filter((column) => discovered.has(column) || column === 'dataset'),
    ...[...discovered].filter((column) => !preferred.includes(column)).sort()
  ];
  return `\uFEFF${[
    columns.map(csvCell).join(','),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))
  ].join('\r\n')}\r\n`;
}

// A single-table export (one specific day's match scouting submissions) has
// no "dataset" concept to distinguish rows by, so this skips the forced
// dataset column scoutingDatasetsToCsv always includes, rather than reusing
// that function with an artificial one-dataset wrapper just to get a
// meaningless empty column in every export.
export function matchScoutingRowsToCsv(rows = []) {
  const discovered = new Set(rows.flatMap((row) => Object.keys(row || {})));
  const preferred = ['event_key', 'match_key', 'team_key'];
  const columns = [
    ...preferred.filter((column) => discovered.has(column)),
    ...[...discovered].filter((column) => !preferred.includes(column)).sort()
  ];
  return `\uFEFF${[
    columns.map(csvCell).join(','),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))
  ].join('\r\n')}\r\n`;
}

// Turns a `YYYY-MM-DD` calendar day (as picked from a plain <input
// type="date">, always interpreted as a Pacific-local day - the timezone
// every other date-scoped feature in this app already uses) into the UTC
// instant range that day actually spans, for a created_at >= start AND
// created_at < end query. Computed from the ACTUAL Pacific UTC offset for
// that date (via Intl) rather than a hardcoded -7/-8, so it stays correct
// across the DST transition. That offset is sampled at UTC midnight of the
// given date rather than at the (unknown until computed) Pacific midnight
// itself, so it can land on the wrong side of the transition for the
// specific one or two days a year DST actually changes - acceptable here
// since a scouting export being off by an hour on those two days a year is
// low-stakes, and avoids pulling in a full timezone library for it.
export function pacificDayRangeUtc(dateStr) {
  const [year, month, day] = String(dateStr || '').split('-').map(Number);
  if (!year || !month || !day) throw new Error('date must be in YYYY-MM-DD format');
  const naiveUtcMidnight = Date.UTC(year, month - 1, day);
  const offsetParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'shortOffset'
  }).formatToParts(new Date(naiveUtcMidnight));
  const offsetLabel = offsetParts.find((part) => part.type === 'timeZoneName')?.value || 'GMT-8';
  const offsetHours = Number(offsetLabel.match(/GMT([+-]\d+)/)?.[1] ?? -8);
  const startUtcMs = naiveUtcMidnight - offsetHours * 60 * 60 * 1000;
  return {
    start: new Date(startUtcMs).toISOString(),
    end: new Date(startUtcMs + 24 * 60 * 60 * 1000).toISOString()
  };
}
