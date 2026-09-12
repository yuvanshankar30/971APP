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
  description: ['description', 'desc'],
  // Optional - a manual CSV has no 3D bounding box, so without a thickness
  // column stock_match.js's router sheet-goods matcher has nothing to match
  // on and silently falls back to "first stock of the right material"
  // (same wrong pick for every part regardless of actual thickness).
  thickness: ['thickness', 'depth', 'material thickness']
};

// Parses a thickness cell into inches. Accepts a plain decimal ("0.0625"),
// a simple fraction ("1/16"), or either with a trailing unit/quote mark
// ("0.0625 in", "1/16\""). Returns null for anything unparseable so a bad
// cell just skips depth-based stock matching instead of poisoning it with NaN.
export function parseThicknessInches(raw) {
  const text = String(raw || '').trim().replace(/["”]$/, '').replace(/\s*(in|inch|inches)$/i, '').trim();
  if (!text) return null;
  const fractionMatch = text.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (fractionMatch) {
    const numerator = Number(fractionMatch[1]);
    const denominator = Number(fractionMatch[2]);
    return denominator ? numerator / denominator : null;
  }
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : null;
}

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
    description: columnIndex.description !== -1 ? (cells[columnIndex.description] || '').trim() : '',
    thickness: columnIndex.thickness !== -1 ? parseThicknessInches(cells[columnIndex.thickness]) : null
  }))
    .filter((row) => row.part_name)
    // OnShape's placeholder name for an unnamed body ("SOLID", "COMPOUND",
    // or "SOLID_1"/"COMPOUND_2"... with more than one) - a modeling
    // artifact, not a real part, whether it came in live from the API
    // (see onshape.js's analyzeBOM) or through a CSV export of the same BOM.
    .filter((row) => !/^(SOLID|COMPOUND)(_\d+)?$/i.test(row.part_name));

  if (rows.length === 0) {
    throw new Error('No usable rows found in the CSV (every row was missing a name)');
  }

  return rows;
}

// Classifies a manually-imported BOM row as COTS vs manufactured (+
// workflow), by direct instruction. Deliberately independent of
// bom_classify.js's OnShape-oriented manualClassification(): that one only
// applies its material/name heuristics when the part number starts with
// "P" (OnShape's own auto-numbering for modeled parts), and force-classifies
// everything else as COTS - a manually-typed CSV has no such convention
// (part numbers are often vendor SKUs like "WCP-0781", or blank), so that
// gate would wrongly mark every real manufactured part (plates, spacers,
// etc.) as COTS just because it lacks a "P" part number.
export function classifyManualBomRow(row) {
  const name = (row.part_name || '').toLowerCase();
  const material = (row.material || '').toLowerCase();
  const vendor = (row.vendor || '').trim();

  // COTS items stocked in the kitting bins by default, not requested
  // through purchasing - SDS-branded parts, fasteners, motors, gears,
  // electrical/control-system COTS (roboRIO, Pigeon, CANivore, breaker,
  // battery, PDP/PDH), PCBs, and compression/extension springs.
  // \bgears?\b (not "gear") so "gearbox" (a real router-cut plate part,
  // "Gearbox Plate") isn't swept in by "gear" as a substring.
  const isKitItem =
    name.includes('sds') ||
    name.includes('screw') || name.includes('bolt') || name.includes('nut') ||
    name.includes('socket head cap') ||
    name.includes('motor') || /\bgears?\b/.test(name) ||
    name.includes('roborio') || name.includes('pigeon') || name.includes('canivore') || name.includes('canivor') ||
    name.includes('breaker') || name.includes('battery') || name.includes('batteries') ||
    name.includes('pdp') || name.includes('pdh') ||
    name.includes('spring') || name.includes('pcb');

  const isCOTS =
    isKitItem ||
    vendor !== '' ||
    material.includes('belt') || material.includes('acetal') || material.includes('delrin') ||
    name.includes('wcp');

  if (isCOTS) {
    return { part_type: 'COTS', workflow: isKitItem ? 'kit' : 'purchase' };
  }

  let workflow;
  if (name.includes('foam') || material.includes('foam')) {
    workflow = 'router';
  } else if (material.includes('nylon') || material.includes('pla') || material.includes('abs') || material.includes('petg') || material.includes('onyx')) {
    workflow = '3d-print';
  } else if (name.includes('spacer')) {
    workflow = '3d-print';
  } else if (name.includes('shaft') || name.includes('standoff')) {
    workflow = 'lathe';
  } else if (material.includes('birch') || material.includes('polycarbonate') || name.includes('plate') || name.includes('tube')) {
    workflow = 'router';
  } else {
    workflow = 'mill';
  }

  return { part_type: 'manufactured', workflow };
}

export function classifyManualBomRows(rows) {
  return rows.map((row) => ({ ...row, ...classifyManualBomRow(row) }));
}
