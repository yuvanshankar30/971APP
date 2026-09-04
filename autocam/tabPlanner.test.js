import { describe, it, expect } from 'vitest';
import { recommendTabCount, MIN_TABS, MAX_TABS, DEFAULT_SPACING, findStraightRuns, planTabPositions } from './tabPlanner.js';

describe('recommendTabCount - minimum floor (real bug: a single tab is a pivot point, not real holding)', () => {
  it('a perimeter that would naively give 1 tab (or 0) is bumped up to the minimum of 2', () => {
    // Matches the real case that surfaced this: perimeter ~10.5" (a ~3"x2.2"
    // plate), default 6" spacing -> old floor(10.5/6)=1.
    expect(recommendTabCount(10.5, { spacing: 6 })).toBe(MIN_TABS);
    // Even smaller relative to spacing (would floor to 0 under the old formula).
    expect(recommendTabCount(2, { spacing: 6 })).toBe(MIN_TABS);
  });

  it('minTabs is itself overridable, for callers that genuinely want fewer', () => {
    expect(recommendTabCount(6, { spacing: 6, minTabs: 1 })).toBe(1);
  });
});

describe('recommendTabCount - maximum cap (real requirement: "should not be too many tabs" - each one is manual cleanup)', () => {
  it('a very large perimeter relative to spacing is capped at the maximum, not left unbounded', () => {
    expect(recommendTabCount(1000, { spacing: 6 })).toBe(MAX_TABS);
  });

  it('maxTabs is itself overridable', () => {
    expect(recommendTabCount(1000, { spacing: 6, maxTabs: 10 })).toBe(10);
  });
});

describe('recommendTabCount - normal range is unaffected by the bounds', () => {
  it('a perimeter that lands comfortably between the min and max floor uses the real rounded count', () => {
    // perimeter 24" / spacing 6" = 4 - inside [2, 6], should pass through unchanged.
    expect(recommendTabCount(24, { spacing: 6 })).toBe(4);
  });

  it('defaults to a 6" spacing when none is given', () => {
    expect(recommendTabCount(24)).toBe(Math.round(24 / DEFAULT_SPACING));
  });
});

describe('recommendTabCount - thickness nudges spacing (coarse heuristic, not precise physics - see file header)', () => {
  it('thin stock (< 0.1") tightens spacing, producing more tabs than the same perimeter with no thickness given', () => {
    const withoutThickness = recommendTabCount(30, { spacing: 6 });
    const thin = recommendTabCount(30, { spacing: 6, thickness: 0.063 });
    expect(thin).toBeGreaterThanOrEqual(withoutThickness);
  });

  it('thick stock (> 0.375") loosens spacing, producing fewer or equal tabs vs. no thickness given', () => {
    const withoutThickness = recommendTabCount(30, { spacing: 6 });
    const thick = recommendTabCount(30, { spacing: 6, thickness: 0.5 });
    expect(thick).toBeLessThanOrEqual(withoutThickness);
  });

  it('mid-range thickness (between the two thresholds) leaves spacing unchanged', () => {
    const withoutThickness = recommendTabCount(30, { spacing: 6 });
    const midRange = recommendTabCount(30, { spacing: 6, thickness: 0.25 });
    expect(midRange).toBe(withoutThickness);
  });

  it('a thickness of 0 or null is ignored, not treated as "infinitely thin"', () => {
    const withoutThickness = recommendTabCount(30, { spacing: 6 });
    expect(recommendTabCount(30, { spacing: 6, thickness: 0 })).toBe(withoutThickness);
    expect(recommendTabCount(30, { spacing: 6, thickness: null })).toBe(withoutThickness);
  });
});

describe('recommendTabCount - invalid input', () => {
  it('returns 0 for a non-positive perimeter or spacing, instead of throwing or returning a bogus count', () => {
    expect(recommendTabCount(0)).toBe(0);
    expect(recommendTabCount(-5)).toBe(0);
    expect(recommendTabCount(10, { spacing: 0 })).toBe(0);
    expect(recommendTabCount(10, { spacing: -1 })).toBe(0);
  });
});

describe('planTabPositions - tabs go on flats, not curves', () => {
  const rect = [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 4 }, { x: 0, y: 4 }, { x: 0, y: 0 }];
  const circle = (r, n) => [...Array(n + 1)].map((_, i) => ({ x: r * Math.cos((i / n) * 2 * Math.PI), y: r * Math.sin((i / n) * 2 * Math.PI) }));

  it('finds one run per edge on a rectangle', () => {
    expect(findStraightRuns(rect)).toHaveLength(4);
  });

  it('places every tab on a flat, on a rectangle', () => {
    expect(planTabPositions(rect, { count: 4, width: 0.25 })).toHaveLength(4);
  });

  it('refuses to place a tab anywhere on a circle', () => {
    // The discriminator has to be curvature, not per-segment turn: each
    // chord of a finely tessellated arc looks perfectly straight on its own.
    expect(planTabPositions(circle(2, 64), { count: 4, width: 0.25 })).toHaveLength(0);
  });

  it('gives the same answer however finely the arc is tessellated', () => {
    for (const segments of [32, 64, 256]) {
      expect(planTabPositions(circle(2, segments), { count: 4, width: 0.25 }), `${segments} chords`).toHaveLength(0);
    }
  });

  it('treats a very large radius as flat, because it is', () => {
    // A 30" radius is flatter than most stock. Refusing here would be
    // pedantry, not safety.
    expect(planTabPositions(circle(30, 256), { count: 4, width: 0.25 }).length).toBeGreaterThan(0);
  });

  it('keeps tabs off the fillets of a rounded rectangle', () => {
    const fillet = [];
    for (let i = 0; i <= 16; i += 1) {
      const a = Math.PI * 1.5 + (i / 16) * (Math.PI / 2);
      fillet.push({ x: 5 + Math.cos(a), y: 1 + Math.sin(a) });
    }
    const rounded = [{ x: 1, y: 0 }, { x: 5, y: 0 }, ...fillet, { x: 6, y: 3 }, { x: 0, y: 3 }, { x: 0, y: 1 }, { x: 1, y: 0 }];
    const width = 0.25;
    const flats = findStraightRuns(rounded).filter((r) => r.end - r.start >= width * 3);
    const tabs = planTabPositions(rounded, { count: 4, width });
    expect(tabs.length).toBeGreaterThan(0);
    for (const centre of tabs) {
      const held = flats.some((r) => centre - width / 2 >= r.start - 1e-6 && centre + width / 2 <= r.end + 1e-6);
      expect(held, `tab at ${centre.toFixed(2)} is wholly on a flat`).toBe(true);
    }
  });

  it('never stacks two tabs on the same spot', () => {
    const tabs = planTabPositions(rect, { count: 12, width: 0.25 });
    for (let i = 1; i < tabs.length; i += 1) expect(tabs[i] - tabs[i - 1]).toBeGreaterThanOrEqual(0.25);
  });

  it('never puts more than one tab on the same straight side, even when the requested count exceeds the number of sides', () => {
    // A rectangle only has 4 straight sides - asking for 12 tabs used to
    // stack several onto whichever side happened to catch multiple of the
    // 12 evenly-spaced ideal points (which is a function of that side's
    // length, not whether it needs extra holding). One tab per run is the
    // whole point of a hold-down tab layout - a real capped count, not the
    // requested one.
    const tabs = planTabPositions(rect, { count: 12, width: 0.25 });
    const runs = findStraightRuns(rect);
    expect(tabs.length).toBe(runs.length); // 4 sides, 4 tabs, no more
    for (const centre of tabs) {
      const hostingRuns = runs.filter((r) => centre >= r.start - 1e-6 && centre <= r.end + 1e-6);
      expect(hostingRuns).toHaveLength(1);
    }
  });

  it('never doubles up on one long side while a short side a few inches away gets none', () => {
    // A long, thin plate - one side (20") is far longer than the other
    // three (2" each). Perimeter/spacing would recommend several tabs, and
    // even spacing around the perimeter puts most of the "ideal" points
    // inside that one long side just because it is most of the perimeter -
    // exactly the case the old algorithm got wrong.
    const longPlate = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 2 }, { x: 0, y: 2 }, { x: 0, y: 0 }];
    const tabs = planTabPositions(longPlate, { count: 6, width: 0.25 });
    const runs = findStraightRuns(longPlate);
    // Still capped at one tab per run, even though most of the 6 evenly-
    // spaced ideal points land inside the 20" run's own span.
    expect(tabs.length).toBeLessThanOrEqual(runs.length);
    for (const run of runs) {
      const onThisRun = tabs.filter((centre) => centre >= run.start - 1e-6 && centre <= run.end + 1e-6);
      expect(onThisRun.length).toBeLessThanOrEqual(1);
    }
  });
});
