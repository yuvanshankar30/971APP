// Stock an operator can choose when queueing a lathe (Fusion AutoCAM) job.
// Every field is optional and in inches; a blank means "derive it from the
// STEP file", which the Runner does (StockMath.py). What each field means
// depends on the CAM type, so the form and the validation share this table.

export const TURNING_STOCK_FIELDS = {
  spacer: [
    { key: 'odIn', label: 'Stock OD', hint: 'Bar diameter. Auto: the part OD rounded up to the next 1/16in.' },
    { key: 'idIn', label: 'Stock ID', hint: 'Tube stock only. Blank means solid bar, drilled to the part bore.' },
    { key: 'lengthIn', label: 'Stock length', hint: 'Total bar length modeled. Auto: the part plus a facing allowance and the tailstock length.' }
  ],
  hexShaft: [
    { key: 'acrossFlatsIn', label: 'Bar across flats', hint: 'Must match the part - the flats are the bar and are not machined. Blank uses the part.' },
    { key: 'lengthIn', label: 'Bar length', hint: 'Total bar length. Sets how much is left behind the part to grip.' }
  ]
};
// An internal shaft is cut from hex bar, exactly like a hex shaft.
TURNING_STOCK_FIELDS.internalShaft = TURNING_STOCK_FIELDS.hexShaft;

const LIMITS = { lengthIn: 240, odIn: 12, idIn: 12, acrossFlatsIn: 12, tailstockLengthIn: 240 };
const LABELS = {
  lengthIn: 'Stock length', odIn: 'Stock OD', idIn: 'Stock ID',
  acrossFlatsIn: 'Bar across flats', tailstockLengthIn: 'Tailstock length'
};

function optionalPositive(key, value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${LABELS[key]} must be a positive number of inches`);
  if (number > LIMITS[key]) throw new Error(`${LABELS[key]} of ${number}in is larger than ${LIMITS[key]}in`);
  return Math.round(number * 10000) / 10000;
}

/**
 * Validates and normalizes queue-time stock input for one CAM type. Fields
 * that do not apply to the type are dropped (null), so a stale hex value
 * cannot leak into a spacer job. Throws a readable Error on a bad number.
 */
export function normalizeTurningStock(camType, input = {}) {
  const wanted = new Set((TURNING_STOCK_FIELDS[camType] || []).map((field) => field.key));
  const result = { lengthIn: null, odIn: null, idIn: null, acrossFlatsIn: null, tailstockLengthIn: null };
  for (const key of [...wanted, 'tailstockLengthIn']) result[key] = optionalPositive(key, input?.[key]);
  if (result.odIn !== null && result.idIn !== null && result.idIn >= result.odIn) {
    throw new Error('Stock ID must be smaller than the stock OD');
  }
  return result;
}

/** The Runner-facing shape (snake_case, matches camTurning.py's payload["stock"]). */
export function turningStockPayload(stock) {
  return {
    length_in: stock.lengthIn,
    od_in: stock.odIn,
    id_in: stock.idIn,
    across_flats_in: stock.acrossFlatsIn
  };
}
