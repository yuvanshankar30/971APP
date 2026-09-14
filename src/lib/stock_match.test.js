import { describe, it, expect } from 'vitest';
import { matchStockInWorkflow, pickStockAndWorkflow } from './stock_match.js';

const M_PER_IN = 0.0254;

const stockData = {
  'laser-cut': [
    { material: 'Polycarbonate', description: '1/4" Polycarbonate Sheet', thickness: 0.25, dimensions: 'Sheet' }
  ],
  router: [
    { material: 'Aluminum', description: '1/4" Aluminum Sheet', thickness: 0.25, dimensions: 'Sheet' },
    { material: 'Aluminum', description: '1x2 Aluminum Tube', outer_width: 1.0, outer_height: 2.0, dimensions: 'Tube' }
  ],
  lathe: [
    { material: 'Aluminum', description: '1" Round Aluminum Bar', diameter: 1.0 },
    { material: 'ThunderHex', description: '1/2" ThunderHex', hex_size: 0.5, length_max: 24 }
  ],
  mill: [
    { material: 'Aluminum', description: '6061 Aluminum Block' }
  ]
};

describe('matchStockInWorkflow', () => {
  it('matches router sheet stock by thickness', () => {
    const match = matchStockInWorkflow(stockData, 'router', 'aluminum', 0.25, 5, 5, 5, 5);
    expect(match?.description).toBe('1/4" Aluminum Sheet');
  });

  it('matches router tube stock by outer width/height (either orientation)', () => {
    const match = matchStockInWorkflow(stockData, 'router', 'aluminum', 1, 1, 24, 1.0, 2.0);
    expect(match?.description).toBe('1x2 Aluminum Tube');
    const rotated = matchStockInWorkflow(stockData, 'router', 'aluminum', 1, 1, 24, 2.0, 1.0);
    expect(rotated?.description).toBe('1x2 Aluminum Tube');
  });

  it('matches lathe stock by diameter', () => {
    const match = matchStockInWorkflow(stockData, 'lathe', 'aluminum', 1.0, 1.0, 12, 1.0, 1.0);
    expect(match?.description).toBe('1" Round Aluminum Bar');
  });

  it('matches lathe hex stock by hex size and max length', () => {
    const match = matchStockInWorkflow(stockData, 'lathe', 'thunderhex', 0.5, 0.5, 12, 0.5, 0.5);
    expect(match?.description).toBe('1/2" ThunderHex');
  });

  it('falls back to a plain material match for mill', () => {
    const match = matchStockInWorkflow(stockData, 'mill', 'aluminum', 1, 1, 1, 1, 1);
    expect(match?.description).toBe('6061 Aluminum Block');
  });

  it('returns undefined when no stock matches the material at all', () => {
    expect(matchStockInWorkflow(stockData, 'router', 'titanium', 0.25, 5, 5, 5, 5)).toBeUndefined();
  });
});

describe('pickStockAndWorkflow', () => {
  function part({ workflow, material, x, y, z }) {
    return { workflow, material, bounding_box_x: x * M_PER_IN, bounding_box_y: y * M_PER_IN, bounding_box_z: z * M_PER_IN };
  }

  it('keeps the guessed workflow when a stock match exists there', () => {
    const result = pickStockAndWorkflow(stockData, part({ workflow: 'lathe', material: 'Aluminum', x: 1, y: 1, z: 12 }));
    expect(result.workflow).toBe('lathe');
    expect(result.stock?.description).toBe('1" Round Aluminum Bar');
  });

  it('reassigns to router when the guessed workflow has no match but router sheet stock does', () => {
    // Guessed "mill" by the name/material heuristic, but this is really a
    // 1/4" aluminum sheet - exactly what should be caught and reassigned.
    const result = pickStockAndWorkflow(stockData, part({ workflow: 'mill', material: 'Aluminum', x: 12, y: 12, z: 0.25 }));
    expect(result.workflow).toBe('router');
    expect(result.stock?.description).toBe('1/4" Aluminum Sheet');
  });

  it('reassigns to router when the guessed workflow has no match but router tube stock does', () => {
    const result = pickStockAndWorkflow(stockData, part({ workflow: 'mill', material: 'Aluminum', x: 1.0, y: 2.0, z: 24 }));
    expect(result.workflow).toBe('router');
    expect(result.stock?.description).toBe('1x2 Aluminum Tube');
  });

  it('does not reassign when the part is already guessed as router', () => {
    const result = pickStockAndWorkflow(stockData, part({ workflow: 'router', material: 'Titanium', x: 5, y: 5, z: 5 }));
    expect(result.workflow).toBe('router');
    expect(result.stock).toBeUndefined();
  });

  it('leaves the workflow unchanged when nothing matches anywhere', () => {
    const result = pickStockAndWorkflow(stockData, part({ workflow: 'mill', material: 'Titanium', x: 5, y: 5, z: 5 }));
    expect(result.workflow).toBe('mill');
    expect(result.stock).toBeUndefined();
  });

  it('matches router sheet stock by an explicit thickness when there is no bounding box at all (manual CSV import)', () => {
    // No bounding_box_x/y/z on this part - only a thickness value parsed
    // from an optional CSV column.
    const result = pickStockAndWorkflow(stockData, { workflow: 'router', material: 'Aluminum', thickness: 0.25 });
    expect(result.workflow).toBe('router');
    expect(result.stock?.description).toBe('1/4" Aluminum Sheet');
  });

  it('falls back to the 1/4" aluminum sheet default when a bare thickness matches neither sheet nor tube stock', () => {
    // thickness=1.0 matches neither the 0.25" sheet nor (since dimX/dimY are
    // still NaN with no bounding box) the tube's outer_width/outer_height -
    // an aluminum router part with no confirmed depth defaults to 1/4"
    // sheet by direct instruction, same as the no-thickness-at-all case.
    const result = pickStockAndWorkflow(stockData, { workflow: 'router', material: 'Aluminum', thickness: 1.0 });
    expect(result.stock?.description).toBe('1/4" Aluminum Sheet');
  });

  it('does not default a non-aluminum bare-thickness mismatch to any stock', () => {
    const result = pickStockAndWorkflow(stockData, { workflow: 'router', material: 'Titanium', thickness: 1.0 });
    expect(result.stock).toBeUndefined();
  });

  it('reassigns a bare-thickness mill guess to router, same as the bounding-box case', () => {
    const result = pickStockAndWorkflow(stockData, { workflow: 'mill', material: 'Aluminum', thickness: 0.25 });
    expect(result.workflow).toBe('router');
    expect(result.stock?.description).toBe('1/4" Aluminum Sheet');
  });

  it('picks a tube stock by name alone when a router part named "tube" has no dimension data', () => {
    const result = pickStockAndWorkflow(stockData, { workflow: 'router', material: 'Aluminum', part_name: 'Left Cross Tube' });
    expect(result.stock?.description).toBe('1x2 Aluminum Tube');
  });

  it('never picks sheet stock for a "tube"-named part even though sheet stock exists for the same material', () => {
    const result = pickStockAndWorkflow(stockData, { workflow: 'router', material: 'Aluminum', part_name: 'Bottom Tube' });
    expect(result.stock?.dimensions).toBe('Tube');
  });

  it('picks tube stock by name even when the part\'s own dimensions coincidentally match a sheet thickness', () => {
    // Real, confirmed live bug: a real tube-named CAD part's own bounding
    // box (e.g. a 0.3in wall/flange dimension) can land within
    // matchStockInWorkflow's own 0.1in tolerance of an unrelated sheet
    // stock's thickness (0.25in here) - the sheet-thickness match used to
    // run BEFORE the name-based tube check, so six real tube-named parts
    // ("Bottom Tube", "Left Tube", ...) all silently defaulted to
    // "1/16in Aluminum Sheet" instead of any tube stock. The name check
    // must win regardless of what the generic shape matcher would have
    // found.
    const result = pickStockAndWorkflow(stockData, {
      workflow: 'router',
      material: 'Aluminum',
      part_name: 'Bottom Tube',
      bounding_box_x: 0.3 * M_PER_IN,
      bounding_box_y: 2 * M_PER_IN,
      bounding_box_z: 24 * M_PER_IN
    });
    expect(result.stock?.dimensions).toBe('Tube');
  });

  it('still picks some tube stock by name when the part has no material at all', () => {
    const result = pickStockAndWorkflow(stockData, { workflow: 'router', part_name: 'Left Tube' });
    expect(result.stock?.description).toBe('1x2 Aluminum Tube');
  });

  it('does not apply the tube-by-name fallback to a part with no "tube" in its name - defaults to 1/4" aluminum sheet instead', () => {
    const result = pickStockAndWorkflow(stockData, { workflow: 'router', material: 'Aluminum', part_name: 'Gearbox Plate' });
    expect(result.stock?.description).toBe('1/4" Aluminum Sheet');
  });

  it('reassigns a mill-guessed part named "tube" to router via the name fallback too', () => {
    const result = pickStockAndWorkflow(stockData, { workflow: 'mill', material: 'Aluminum', part_name: 'crossmember tube' });
    expect(result.workflow).toBe('router');
    expect(result.stock?.description).toBe('1x2 Aluminum Tube');
  });

  it('picks tube stock for a mill-guessed "tube"-named part even when its dimensions coincidentally match router sheet stock', () => {
    const result = pickStockAndWorkflow(stockData, {
      workflow: 'mill',
      material: 'Aluminum',
      part_name: 'crossmember tube',
      bounding_box_x: 0.3 * M_PER_IN,
      bounding_box_y: 2 * M_PER_IN,
      bounding_box_z: 24 * M_PER_IN
    });
    expect(result.workflow).toBe('router');
    expect(result.stock?.dimensions).toBe('Tube');
  });

  it('defaults an aluminum router part with no detectable depth to 1/4" sheet', () => {
    const result = pickStockAndWorkflow(stockData, { workflow: 'router', material: 'Aluminum', part_name: 'Side Panel' });
    expect(result.stock?.description).toBe('1/4" Aluminum Sheet');
  });

  it('does not default to aluminum sheet for a non-aluminum router part with no depth', () => {
    const result = pickStockAndWorkflow(stockData, { workflow: 'router', material: 'Titanium', part_name: 'Side Panel' });
    expect(result.stock).toBeUndefined();
  });

  it('reassigns a mill-guessed aluminum part with no depth to router via the default-sheet fallback', () => {
    const result = pickStockAndWorkflow(stockData, { workflow: 'mill', material: 'Aluminum', part_name: 'Side Panel' });
    expect(result.workflow).toBe('router');
    expect(result.stock?.description).toBe('1/4" Aluminum Sheet');
  });
});
