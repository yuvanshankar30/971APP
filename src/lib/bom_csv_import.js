// Manual BOM import - lets a build get created from an uploaded CSV export
// (OnShape's own BOM table export, or any sheet with the right columns)
// instead of a live OnShape API call, for when OnShape is unreachable or a
// subsystem isn't linked to a document at all.

// Minimal RFC 4180 CSV parser - handles quoted fields (commas/newlines/
// escaped "" inside quotes), which a naive text.split(',') would mangle.
// OnShape's own BOM CSV export quotes fields like Description freely.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  }
  return rows;
}

// Matches this app's own BOM columns loosely against whatever header wording
// a team's OnShape BOM table export happens to use.
export const BOM_CSV_HEADER_ALIASES = {
  part_name: ['name', 'item name', 'part name', 'item'],
  part_number: ['part number', 'partnumber', 'part no', 'pn'],
  quantity: ['quantity', 'qty'],
  material: ['material'],
  vendor: ['vendor', 'supplier'],
  description: ['description', 'desc']
};

export function matchCsvColumn(headers, aliases) {
  const normalized = headers.map((h) => h.trim().toLowerCase());
  for (const alias of aliases) {
    const index = normalized.indexOf(alias);
    if (index !== -1) return index;
  }
  return -1;
}

// Parses raw CSV text into BOM row objects (part_name/part_number/quantity/
// material/vendor/description) - does not classify COTS vs manufactured,
// that's the caller's job (it needs partClassificationService, a $lib module
// this one deliberately stays independent of so it can be unit tested with
// plain strings in/objects out).
export function parseBomCsvRows(text) {
  const table = parseCsv(text);
  if (table.length < 2) {
    throw new Error('CSV has no data rows below the header');
  }

  const headers = table[0];
  const columnIndex = {};
  for (const [field, aliases] of Object.entries(BOM_CSV_HEADER_ALIASES)) {
    columnIndex[field] = matchCsvColumn(headers, aliases);
  }
  if (columnIndex.part_name === -1) {
    throw new Error(
      `Could not find a name column in the CSV header (saw: ${headers.join(', ')}). ` +
      `Expected one of: ${BOM_CSV_HEADER_ALIASES.part_name.join(', ')}`
    );
  }

  const rows = table.slice(1).map((cells) => ({
    part_name: columnIndex.part_name !== -1 ? (cells[columnIndex.part_name] || '').trim() : '',
    part_number: columnIndex.part_number !== -1 ? (cells[columnIndex.part_number] || '').trim() : '',
    quantity: columnIndex.quantity !== -1 ? parseInt(cells[columnIndex.quantity], 10) || 1 : 1,
    material: columnIndex.material !== -1 ? (cells[columnIndex.material] || '').trim() : '',
    vendor: columnIndex.vendor !== -1 ? (cells[columnIndex.vendor] || '').trim() : '',
    description: columnIndex.description !== -1 ? (cells[columnIndex.description] || '').trim() : ''
  })).filter((row) => row.part_name);

  if (rows.length === 0) {
    throw new Error('No usable rows found in the CSV (every row was missing a name)');
  }

  return rows;
}
