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
