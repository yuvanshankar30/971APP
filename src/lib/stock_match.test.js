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
});
