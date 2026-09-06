import { describe, it, expect } from 'vitest';
import {
  buildStockMaterialIndex,
  matchMaterialId,
  materialNameFromStockText,
  materialIdForStockAssignment,
  stockCatalogIdForStockAssignment
} from './stockMaterial.js';
import stockData from '../src/lib/stock.json';

// The real cam_materials rows, as they exist in the database.
const MATERIALS = [
  { id: 'al', name: 'Aluminum 6061' },
  { id: 'birch', name: 'Baltic Birch Plywood' },
  { id: 'delrin', name: 'Delrin (Acetal)' },
  { id: 'pc', name: 'Polycarbonate (Lexan)' },
  { id: 'steel', name: 'Steel' },
  { id: 'srpp', name: 'SRPP' },
  { id: 'wood', name: 'Wood' },
  { id: 'pla', name: 'PLA' },
  { id: 'petg', name: 'PETG' }
];

const index = buildStockMaterialIndex(stockData);
const resolve = (stock) => materialIdForStockAssignment(index, MATERIALS, stock, stockData);

describe('matchMaterialId', () => {
  it('matches an exact material name', () => {
    expect(matchMaterialId(MATERIALS, 'SRPP')).toBe('srpp');
    expect(matchMaterialId(MATERIALS, 'Steel')).toBe('steel');
  });

  it('matches the specific grade by prefix when the catalogs name it differently', () => {
    expect(matchMaterialId(MATERIALS, 'Aluminum')).toBe('al');
    expect(matchMaterialId(MATERIALS, 'Polycarbonate')).toBe('pc');
    expect(matchMaterialId(MATERIALS, 'Delrin')).toBe('delrin');
  });

  it('matches a whole word in the middle of a longer name', () => {
    // 'Birch' -> 'Baltic Birch Plywood' - neither exact nor a prefix.
    expect(matchMaterialId(MATERIALS, 'Birch')).toBe('birch');
  });

  it('prefers an exact match over a prefix match', () => {
    const materials = [{ id: 'long', name: 'Steel Alloy 4140' }, { id: 'plain', name: 'Steel' }];
    expect(matchMaterialId(materials, 'Steel')).toBe('plain');
  });

  it('does not match a short acronym inside an unrelated longer name', () => {
    // A bare substring test would be tempted by 'Plywood' here.
    expect(matchMaterialId([{ id: 'birch', name: 'Baltic Birch Plywood' }], 'PLA')).toBe('');
  });

  it('returns empty for an unknown material rather than guessing', () => {
    expect(matchMaterialId(MATERIALS, 'Unobtanium')).toBe('');
    expect(matchMaterialId(MATERIALS, '')).toBe('');
    expect(matchMaterialId(MATERIALS, null)).toBe('');
  });

  it('is case and whitespace insensitive', () => {
    expect(matchMaterialId(MATERIALS, '  aLuMiNuM  ')).toBe('al');
  });
});

describe('materialNameFromStockText', () => {
  it('reads the material out of hand-typed stock text', () => {
    expect(materialNameFromStockText(stockData, MATERIALS, '1/4" SRPP')).toBe('SRPP');
    expect(materialNameFromStockText(stockData, MATERIALS, 'Birch 0.75"')).toBe('Birch');
    expect(materialNameFromStockText(stockData, MATERIALS, '3/32 aluminum')).toBe('Aluminum');
  });

  it('resolves the shorthands that actually appear in the data', () => {
    expect(materialNameFromStockText(stockData, MATERIALS, '1.25" Polycarb')).toBe('Polycarbonate');
    expect(materialNameFromStockText(stockData, MATERIALS, 'Lexan 1.25"')).toBe('Polycarbonate');
    expect(materialNameFromStockText(stockData, MATERIALS, '.09" Alu')).toBe('Aluminum');
  });

  it('prefers the longest match, so a full name beats a shorthand', () => {
    // 'Aluminum' must win over the 'alu' alias, not be read as a fragment.
    expect(materialNameFromStockText(stockData, MATERIALS, '1/16 Aluminum 5052')).toBe('Aluminum');
  });

  it('reads nothing out of stock text that names no material', () => {
    for (const vague of ['Tube', 'lead screw', '0.313 stock', 'Hubbington', 'A3', '']) {
      expect(materialNameFromStockText(stockData, MATERIALS, vague), vague).toBe('');
    }
  });
});

describe('materialIdForStockAssignment (against the real stock catalog)', () => {
  it('resolves exact catalog descriptions', () => {
    expect(resolve('1/8" Aluminum Sheet')).toBe('al');
    expect(resolve('3/16" Aluminum Sheet')).toBe('al');
    expect(resolve('1/8" Polycarbonate Sheet')).toBe('pc');
    expect(resolve('1.25\" Polycarbonate Round Stock')).toBe('pc');
    expect(resolve('2\" Polycarbonate Round Stock')).toBe('pc');
    expect(resolve('Steel Block Stock')).toBe('steel');
    expect(resolve('PETG 3D Printing Filament')).toBe('petg');
  });

  it('resolves the hand-typed values real parts actually carry', () => {
    // Verbatim parts.stock_assignment values from the database - none of
    // these are an exact stock.json description.
    expect(resolve('1/4" SRPP')).toBe('srpp');
    expect(resolve('Birch 0.75"')).toBe('birch');
    expect(resolve('1.25" Polycarb')).toBe('pc');
    expect(resolve('Lexan 1.25"')).toBe('pc');
    expect(resolve('3/32 aluminum')).toBe('al');
    expect(resolve('.5 aluminum 6061')).toBe('al');
    expect(resolve('0.75 Wood')).toBe('wood');
  });

  it('resolves every router/mill/lathe stock entry the catalog defines', () => {
    // The workflows AutoCAM actually generates for - none of them should
    // fall through to "no material", which is what the bug looked like.
    for (const workflow of ['router', 'mill', 'lathe']) {
      for (const stock of stockData[workflow] || []) {
        const resolved = resolve(stock.description);
        expect(resolved, `${workflow}: ${stock.description} (${stock.material})`).not.toBe('');
      }
    }
  });

  it('fails closed on stock that names no material, rather than guessing', () => {
    // Guessing here would silently apply the wrong feeds and speeds.
    for (const vague of ['Tube', 'lead screw', '0.313 stock', 'BRONZE BUSHING', '', null]) {
      expect(resolve(vague), String(vague)).toBe('');
    }
  });
});

describe('stockCatalogIdForStockAssignment (against the real stock catalog)', () => {
  const routerSheet = (stockData.router || []).find((s) => !s.isTube && s.thickness > 0);

  it('resolves an exact catalog description to that real sheet, thickness and all', () => {
    expect(routerSheet).toBeTruthy();
    expect(stockCatalogIdForStockAssignment(stockData, routerSheet.description)).toBe(routerSheet.id);
  });

  it('is case and whitespace insensitive, same as an operator re-typing a real description', () => {
    expect(stockCatalogIdForStockAssignment(stockData, `  ${routerSheet.description.toUpperCase()}  `)).toBe(routerSheet.id);
  });

  it('fails closed on hand-typed free text, unlike the material bridge - a wrong sheet costs the wrong cut depth', () => {
    // These resolve a MATERIAL fine (see materialIdForStockAssignment above)
    // but must not resolve to any specific sheet - guessing a thickness is
    // the one thing this function is deliberately conservative about.
    for (const handTyped of ['1/4" SRPP', 'Birch 0.75"', '1.25" Polycarb', 'Lexan 1.25"', '3/32 aluminum']) {
      expect(stockCatalogIdForStockAssignment(stockData, handTyped), handTyped).toBe('');
    }
  });

  it('fails closed on empty/vague input', () => {
    for (const vague of ['', null, undefined, 'Tube', 'lead screw']) {
      expect(stockCatalogIdForStockAssignment(stockData, vague), String(vague)).toBe('');
    }
  });

  it('only searches the requested category', () => {
    // A router sheet description should not resolve against, say, a lathe
    // category search - the two catalogs are unrelated stock lists.
    expect(stockCatalogIdForStockAssignment(stockData, routerSheet.description, 'lathe')).toBe('');
  });
});
