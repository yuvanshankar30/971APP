import { describe, expect, it } from 'vitest';
import { TURNING_STOCK_FIELDS, normalizeTurningStock, turningStockPayload } from './turningStock.js';

describe('turning stock normalization', () => {
  it('treats blank input as auto for every field', () => {
    for (const camType of ['spacer', 'hexShaft']) {
      expect(normalizeTurningStock(camType, { lengthIn: '', odIn: null, idIn: undefined, acrossFlatsIn: '' })).toEqual({
        lengthIn: null, odIn: null, idIn: null, acrossFlatsIn: null, tailstockLengthIn: null
      });
    }
    expect(normalizeTurningStock('spacer')).toEqual({ lengthIn: null, odIn: null, idIn: null, acrossFlatsIn: null, tailstockLengthIn: null });
  });

  it('accepts numeric strings from form inputs and rounds to 4 decimals', () => {
    expect(normalizeTurningStock('spacer', { odIn: '0.5', idIn: '0.23', lengthIn: '3.123456', tailstockLengthIn: '1' })).toEqual({
      lengthIn: 3.1235, odIn: 0.5, idIn: 0.23, acrossFlatsIn: null, tailstockLengthIn: 1
    });
  });

  it('drops fields that do not apply to the CAM type', () => {
    expect(normalizeTurningStock('hexShaft', { odIn: 1, idIn: 0.5, acrossFlatsIn: 0.5, lengthIn: 7 })).toEqual({
      lengthIn: 7, odIn: null, idIn: null, acrossFlatsIn: 0.5, tailstockLengthIn: null
    });
    expect(normalizeTurningStock('spacer', { acrossFlatsIn: 0.5 }).acrossFlatsIn).toBeNull();
  });

  it.each([0, -1, 'abc', NaN, Infinity])('rejects %s as a stock dimension', (bad) => {
    expect(() => normalizeTurningStock('spacer', { odIn: bad })).toThrow(/Stock OD must be a positive number/);
    expect(() => normalizeTurningStock('hexShaft', { tailstockLengthIn: bad })).toThrow(/Tailstock length must be a positive number/);
  });

  it('rejects absurdly large dimensions', () => {
    expect(() => normalizeTurningStock('spacer', { odIn: 40 })).toThrow(/larger than 12in/);
    expect(() => normalizeTurningStock('hexShaft', { lengthIn: 1000 })).toThrow(/larger than 240in/);
  });

  it('requires a stock ID smaller than the stock OD', () => {
    expect(() => normalizeTurningStock('spacer', { odIn: 0.5, idIn: 0.5 })).toThrow(/smaller than the stock OD/);
    expect(() => normalizeTurningStock('spacer', { odIn: 0.5, idIn: 0.25 })).not.toThrow();
  });

  it('maps to the Runner payload shape', () => {
    expect(turningStockPayload(normalizeTurningStock('spacer', { odIn: 0.5, lengthIn: 3 }))).toEqual({
      length_in: 3, od_in: 0.5, id_in: null, across_flats_in: null
    });
  });

  it('treats an internal shaft as hex bar stock', () => {
    expect(TURNING_STOCK_FIELDS.internalShaft.map((f) => f.key)).toEqual(['acrossFlatsIn', 'lengthIn']);
    expect(normalizeTurningStock('internalShaft', { acrossFlatsIn: 0.5, lengthIn: 8, odIn: 2, idIn: 1 })).toEqual({
      lengthIn: 8, odIn: null, idIn: null, acrossFlatsIn: 0.5, tailstockLengthIn: null
    });
  });

  it('describes each CAM type\'s own fields for the form', () => {
    expect(TURNING_STOCK_FIELDS.spacer.map((f) => f.key)).toEqual(['odIn', 'idIn', 'lengthIn']);
    expect(TURNING_STOCK_FIELDS.hexShaft.map((f) => f.key)).toEqual(['acrossFlatsIn', 'lengthIn']);
  });
});
