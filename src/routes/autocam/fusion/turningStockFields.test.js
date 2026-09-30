import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import TurningStockFields from './TurningStockFields.svelte';
import { TURNING_CAM_TYPES } from '$lib/fusionCam.js';

const html = (camType) => render(TurningStockFields, { props: { camType, values: {}, idPrefix: 't' } }).body;

describe('turning stock form fields', () => {
  it('shows round/tube stock fields for a spacer', () => {
    const body = html('spacer');
    for (const label of ['Stock OD', 'Stock ID', 'Stock length', 'Tailstock length']) expect(body).toContain(label);
    expect(body).not.toContain('Bar across flats');
    expect(body).toContain('id="t-odIn"');
    expect(body).toContain('id="t-idIn"');
  });

  it.each(['hexShaft', 'internalShaft'])('shows hex bar fields for %s', (camType) => {
    const body = html(camType);
    for (const label of ['Bar across flats', 'Bar length', 'Tailstock length']) expect(body).toContain(label);
    expect(body).not.toContain('Stock OD');
    expect(body).not.toContain('Stock ID');
  });

  it('asks for a CAM type before showing any field', () => {
    const body = html('');
    expect(body).toContain('Choose a CAM type');
    expect(body).not.toContain('<input');
  });

  it('has a form for every CAM type the queue offers', () => {
    for (const { value } of TURNING_CAM_TYPES) {
      expect(html(value)).toContain('Tailstock length');
    }
  });

  it('makes every field optional with an auto placeholder', () => {
    for (const { value } of TURNING_CAM_TYPES) {
      const body = html(value);
      expect(body).not.toContain('required');
      expect(body).toMatch(/placeholder="Auto/);
    }
  });
});
