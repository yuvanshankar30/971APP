import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateFusionNcFiles } from './fusion_nc_artifacts.js';

describe('Fusion NC artifact validation', () => {
  it('preserves every byte and computes its exact digest', () => {
    const bytes = Buffer.from([0x25, 0x0d, 0x0a, 0x47, 0x31, 0x20, 0x58, 0x31, 0x0d, 0x0a, 0xff, 0x00]);
    const contentBase64 = bytes.toString('base64');
    const [file] = validateFusionNcFiles([{ name: 'setup-1/output.tap', contentBase64 }]);
    expect(Buffer.from(file.contentBase64, 'base64')).toEqual(bytes);
    expect(file.size).toBe(bytes.length);
    expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('keeps multiple Fusion programs separate', () => {
    const files = validateFusionNcFiles([
      { name: 'G54.tap', contentBase64: Buffer.from('%\nG54\nM30\n%').toString('base64') },
      { name: 'G55.tap', contentBase64: Buffer.from('%\nG55\nM30\n%').toString('base64') }
    ]);
    expect(files.map((file) => file.name)).toEqual(['G54.tap', 'G55.tap']);
    expect(files).toHaveLength(2);
  });

  it.each([
    [{ name: '../output.tap', contentBase64: '' }],
    [{ name: 'output.tap', contentBase64: 'not base64' }],
    [{ name: 'output.tap', contentBase64: 'RzAw', sha256: 'wrong' }],
    [{ name: 'output.tap', contentBase64: 'RzAw', size: 999 }],
    [
      { name: 'same.tap', contentBase64: 'RzAw' },
      { name: 'same.tap', contentBase64: 'RzAx' }
    ]
  ])('rejects unsafe or unverifiable artifacts', (files) => {
    expect(() => validateFusionNcFiles(files)).toThrow();
  });
});
