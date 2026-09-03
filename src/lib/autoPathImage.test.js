import { describe, expect, it } from 'vitest';
import { autoPathImageFileName, renderAutoPathImage } from './autoPathImage.js';

describe('saved autonomous path image', () => {
  it('renders a field image with the route and safe metadata', () => {
    const image = renderAutoPathImage({
      eventKey: '2026test',
      teamKey: 'frc971',
      name: 'Center <four>',
      alliance: 'blue',
      path: [[10, 20], [42, 55], [70, 80]]
    });

    expect(image).toContain('<svg');
    expect(image).toContain('Center &lt;four&gt;');
    expect(image).toContain('<polyline points="100.00,97.40 420.00,267.85 700.00,389.60"');
    expect(image).toContain('stroke="#2468c7"');
    expect(image).toContain('Route points: 3');
  });

  it('uses a stable, Drive-safe filename', () => {
    expect(autoPathImageFileName({
      eventKey: '2026 Test',
      teamKey: 'frc971',
      name: 'Center four-piece!',
      createdAt: '2026-09-02T19:11:12.123Z'
    })).toBe('2026-Test_frc971_Center-four-piece_2026-09-02T19-11-12-123Z.svg');
  });
});
