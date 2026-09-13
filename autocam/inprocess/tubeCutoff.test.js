import { describe, it, expect } from 'vitest';
import { tubeCutoffPath, tubeCutoffPosition } from './tubeCutoff.js';

const extent = (points, axis) => {
  const values = points.map((p) => p[axis]);
  return { min: Math.min(...values), max: Math.max(...values) };
};

describe('tubeCutoffPath', () => {
  const path = tubeCutoffPath({ position: 10, width: 0.5, length: 1.5 });

  it('is the length it was asked for, measured end to end', () => {
    // Length is the overall size of the shape, not the rectangle hidden
    // inside it - that is what someone measures against the tube.
    const { min, max } = extent(path, 'x');
    expect(max - min).toBeCloseTo(1.5, 6);
  });

  it('is the width it was asked for', () => {
    const { min, max } = extent(path, 'y');
    expect(max - min).toBeCloseTo(0.5, 6);
  });

  it('is centred on the position given', () => {
    const { min, max } = extent(path, 'x');
    expect((min + max) / 2).toBeCloseTo(10, 6);
  });

  it('straddles the face centreline', () => {
    const { min, max } = extent(path, 'y');
    expect(min).toBeCloseTo(-max, 6);
  });

  it('closes on itself', () => {
    expect(path[0]).toEqual(path[path.length - 1]);
  });

  it('has no repeated interior point that would emit a zero-length move', () => {
    for (let i = 1; i < path.length - 1; i += 1) {
      const step = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
      expect(step).toBeGreaterThan(1e-9);
    }
  });

  it('rounds the ends rather than squaring them', () => {
    // Every point must sit inside the obround, so the corners the caps
    // replace are genuinely gone.
    const radius = 0.25;
    const straightHalf = (1.5 - 0.5) / 2;
    for (const point of path) {
      const overhang = Math.abs(point.x - 10) - straightHalf;
      if (overhang > 1e-9) {
        expect(Math.hypot(overhang, point.y)).toBeLessThanOrEqual(radius + 1e-9);
      }
    }
  });

  it('degenerates to a circle when length equals width', () => {
    const circle = tubeCutoffPath({ position: 4, width: 0.5, length: 0.5 });
    for (const point of circle) {
      expect(Math.hypot(point.x - 4, point.y)).toBeCloseTo(0.25, 6);
    }
  });

  it('refuses a length shorter than its own end caps', () => {
    expect(() => tubeCutoffPath({ position: 4, width: 0.5, length: 0.4 })).toThrow(/at least its width/);
  });

  it('refuses nonsense dimensions rather than emitting a path', () => {
    expect(() => tubeCutoffPath({ position: 4, width: 0, length: 1 })).toThrow(/width must be > 0/);
    expect(() => tubeCutoffPath({ position: 4, width: 0.5, length: 0 })).toThrow(/length must be > 0/);
    expect(() => tubeCutoffPath({ position: 'end', width: 0.5, length: 1 })).toThrow(/position must be/);
  });
});

describe('tubeCutoffPosition', () => {
  it('puts the line on the part end when the saw takes nothing', () => {
    expect(tubeCutoffPosition({ partEnd: 10 })).toBe(10);
  });

  it('offsets by half the kerf so the part is not left short', () => {
    // Cut on the line with a real blade and the part loses half the kerf
    // from its own side.
    expect(tubeCutoffPosition({ partEnd: 10, kerf: 0.0625 })).toBeCloseTo(10.03125, 9);
  });

  it('refuses a negative kerf', () => {
    expect(() => tubeCutoffPosition({ partEnd: 10, kerf: -0.05 })).toThrow(/kerf cannot be negative/);
  });
});
