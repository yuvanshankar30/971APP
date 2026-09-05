/**
 * Resolves a manufacturing request's recorded stock into an AutoCAM
 * material row.
 *
 * The two sides name materials differently and neither is wrong:
 * - A manufacturing request stores the real stock it gets cut from in
 *   parts.stock_assignment. Often that's stock.json's own `description`
 *   verbatim ('1/8" Aluminum Sheet'), but it's a free-text field and a
 *   lot of real rows are hand-typed ('1/4" SRPP', 'Birch 0.75"',
 *   '1.25" Polycarb', 'Lexan 1.25"', '3/32 aluminum').
 * - AutoCAM stores material as a cam_materials row, usually naming the
 *   specific grade ('Aluminum 6061', 'Polycarbonate (Lexan)') rather than
 *   the generic stock material ('Aluminum', 'Polycarbonate').
 *
 * Without this bridge a CAM job created from a linked part started with no
 * material at all - and therefore none of that material's feeds/speeds
 * defaults - even though the request that spawned it already recorded what
 * the part is made of.
 *
 * Everything here fails closed: anything that doesn't resolve returns ''
 * and the caller keeps whatever material it already had. Guessing wrong
 * would silently apply the wrong feeds and speeds.
 */

/**
 * Shorthands that appear in real stock_assignment text but aren't any
 * material's actual name. Deliberately tiny and only for spellings that
 * genuinely show up in the data - this is not a place to invent synonyms.
 */
const MATERIAL_ALIASES = [
  ['polycarb', 'Polycarbonate'],
  ['lexan', 'Polycarbonate'],
  ['acetal', 'Delrin'],
  ['alu', 'Aluminum'],
  ['plywood', 'Birch']
];

/** Builds description -> generic material name from the stock catalog. */
export function buildStockMaterialIndex(stockCatalog) {
  return new Map(
    Object.values(stockCatalog || {})
      .flat()
      .filter((s) => s?.description && s?.material)
      .map((s) => [s.description.trim().toLowerCase(), s.material])
  );
}

/** Every distinct generic material name the stock catalog uses. */
export function stockMaterialNames(stockCatalog) {
  return [...new Set(
    Object.values(stockCatalog || {})
      .flat()
      .map((s) => s?.material)
      .filter(Boolean)
  )];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wholeWord = (needle, haystack) => new RegExp(`\\b${escapeRe(needle)}\\b`, 'i').test(haystack || '');

/**
 * Finds the cam_materials row for a generic material name.
 *
 * Falls back exact -> prefix -> whole word rather than requiring the two
 * catalogs to use byte-identical strings, since cam_materials names the
 * grade and stock.json names the material:
 *   'Aluminum'      -> 'Aluminum 6061'          (prefix)
 *   'Polycarbonate' -> 'Polycarbonate (Lexan)'  (prefix)
 *   'Birch'         -> 'Baltic Birch Plywood'   (whole word, mid-string)
 *   'SRPP'          -> 'SRPP'                   (exact)
 *
 * The last step is deliberately a whole-word match, not a bare substring:
 * a substring test would let a short acronym match inside an unrelated
 * longer name.
 */
export function matchMaterialId(materials, materialName) {
  const needle = String(materialName || '').trim().toLowerCase();
  if (!needle) return '';
  const list = Array.isArray(materials) ? materials : [];

  const exact = list.find((m) => m?.name?.trim().toLowerCase() === needle);
  if (exact) return exact.id;

  const prefixed = list.find((m) => m?.name?.trim().toLowerCase().startsWith(needle));
  if (prefixed) return prefixed.id;

  const worded = list.find((m) => wholeWord(needle, m?.name));
  return worded ? worded.id : '';
}

/**
 * Reads a material name out of free-text stock like '1/4" SRPP' or
 * 'Lexan 1.25"'. Longest candidate first, so 'Aluminum' is preferred over
 * the 'alu' alias and never matched as a fragment of something else.
 */
export function materialNameFromStockText(stockCatalog, materials, stockAssignment) {
  const text = String(stockAssignment || '').trim();
  if (!text) return '';

  const candidates = [
    // A cam_materials name written out in full is the strongest signal.
    ...(Array.isArray(materials) ? materials : []).map((m) => [m?.name, m?.name]).filter(([n]) => n),
    ...stockMaterialNames(stockCatalog).map((n) => [n, n]),
    ...MATERIAL_ALIASES
  ].sort((a, b) => String(b[0]).length - String(a[0]).length);

  for (const [token, materialName] of candidates) {
    if (wholeWord(String(token), text)) return materialName;
  }
  return '';
}

/**
 * @param {Map<string,string>} stockMaterialIndex from buildStockMaterialIndex
 * @param {Array<{id: any, name: string}>} materials cam_materials rows
 * @param {string} stockAssignment parts.stock_assignment
 * @param {object} [stockCatalog] stock.json, enabling the free-text fallback
 * @returns {any} the cam_materials id, or '' when the stock can't be
 *   resolved confidently (the caller keeps whatever it already had)
 */
export function materialIdForStockAssignment(stockMaterialIndex, materials, stockAssignment, stockCatalog) {
  // An exact catalog description is authoritative - it's a real pick from
  // the stock list rather than something typed by hand.
  const catalogMaterial = stockMaterialIndex?.get(String(stockAssignment || '').trim().toLowerCase());
  if (catalogMaterial) {
    const id = matchMaterialId(materials, catalogMaterial);
    if (id) return id;
  }
  if (!stockCatalog) return '';
  return matchMaterialId(materials, materialNameFromStockText(stockCatalog, materials, stockAssignment));
}

/**
 * Finds the specific stock.json catalog row (not just the generic material)
 * a manufacturing request's stock_assignment names - the actual sheet, with
 * its real thickness, not just "this part is Aluminum".
 *
 * Exact match only, deliberately more conservative than
 * materialIdForStockAssignment's free-text fallback: a wrong MATERIAL guess
 * costs a feed/speed default, recoverable by eye before running anything - a
 * wrong STOCK guess costs the wrong THICKNESS, which is what
 * generateRoutingGcode's cut depth comes from. Guessing a plausible-looking
 * but wrong sheet is worse than finding none and leaving stock unspecified
 * (falls back to the STEP file's own measured thickness instead).
 *
 * @param {object} stockCatalog stock.json
 * @param {string} stockAssignment parts.stock_assignment
 * @param {'router'|'lathe'} [category] which stockCatalog section to search -
 *   router sheets/tubes for routing and tube-stock jobs
 * @returns {string} the matching stock row's id, or '' when nothing matches exactly
 */
export function stockCatalogIdForStockAssignment(stockCatalog, stockAssignment, category = 'router') {
  const needle = String(stockAssignment || '').trim().toLowerCase();
  if (!needle) return '';
  const rows = stockCatalog?.[category];
  if (!Array.isArray(rows)) return '';
  const exact = rows.find((row) => row?.description?.trim().toLowerCase() === needle);
  return exact ? exact.id : '';
}
