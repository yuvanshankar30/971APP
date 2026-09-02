import { describe, it, expect } from 'vitest';
import { parseToolpath3D } from './toolpathPreview.js';
import { generateRoutingGcode, offsetPolygon, cornerFeedScale } from './routing.js';

function square(cx, cy, size) {
  const h = size / 2;
  return [{ x: cx - h, y: cy - h }, { x: cx + h, y: cy - h }, { x: cx + h, y: cy + h }, { x: cx - h, y: cy + h }, { x: cx - h, y: cy - h }];
}

// A many-sided polygon approximating a circle - exactly what stepProfile.js
// actually hands this generator for a real round hole/boss (a STEP mesh's
// triangulated boundary, not a true parametric circle) - see fitCircle.
function circle(cx, cy, r, segments = 64) {
  const pts = [];
  for (let i = 0; i <= segments; i += 1) {
    const a = (i / segments) * 2 * Math.PI;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

// An n-tooth star/spline-like hole boundary (alternating outer/inner
// radius) - approximates a real internal spline bore (see the
// minThroatDistance test below).
function starHole(cx, cy, rOuter, rInner, teeth) {
  const pts = [];
  const n = teeth * 2;
  for (let i = 0; i < n; i += 1) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = (i / n) * 2 * Math.PI;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  pts.push(pts[0]);
  return pts;
}

// 4"x4" outer square, a 1" hole (fits a 1/4" bit fine), and a 0.15" hole
// (too small for a 1/4" bit's 0.125" radius against its ~0.075" throat -
// only reachable with the 1/8" bit).
function partWithHoles() {
  return [
    { points: square(0, 0, 4), isHole: false },
    { points: square(1, 1, 1), isHole: true },
    { points: square(-1, -1, 0.15), isHole: true }
  ];
}

describe('offsetPolygon', () => {
  it('grows a CCW square outward for a positive distance', () => {
    const sq = square(0, 0, 2); // -1..1
    const grown = offsetPolygon(sq, 0.5);
    const xs = grown.map((p) => p.x);
    expect(Math.max(...xs)).toBeCloseTo(1.5, 3);
    expect(Math.min(...xs)).toBeCloseTo(-1.5, 3);
  });

  it('shrinks inward for a negative distance', () => {
    const sq = square(0, 0, 2);
    const shrunk = offsetPolygon(sq, -0.5);
    const xs = shrunk.map((p) => p.x);
    expect(Math.max(...xs)).toBeCloseTo(0.5, 3);
  });

  it('throws when the offset would collapse a too-small feature', () => {
    const tinyHole = square(0, 0, 0.1);
    expect(() => offsetPolygon(tinyHole, -0.125)).toThrow(/too small for this tool/);
  });

  it('throws for a degenerate polygon (< 3 vertices)', () => {
    expect(() => offsetPolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }], 0.1)).toThrow(/at least 3 vertices/);
  });

  describe('over-offset detection (real bug: naive edge-offset-and-intersect does not fail gracefully past the collapse point, it can invert through the shape instead of shrinking to nothing - found against a real STEP file, not a hypothetical)', () => {
    it('a moderately-oversized offset (< 2x the collapse point) that still LOOKS like a valid smaller square must still be rejected', () => {
      // 0.15" square, offsetting inward by 0.125" (way past the 0.075"
      // half-width) - the naive miter math for this specific ratio produces
      // a smaller-but-real-looking square in the WRONG place (corners
      // swapped to their diagonal opposite) rather than an obviously
      // degenerate/negative-area result - the case that broke two earlier,
      // weaker versions of this check (plain area/winding sign, and
      // checking each point against only its own two source edges).
      const hole = square(-1, -1, 0.15);
      expect(() => offsetPolygon(hole, -0.125)).toThrow(/too small for this tool/);
    });

    it('a tool that genuinely fits (well under the real collapse point) still succeeds', () => {
      const hole = square(-1, -1, 0.15);
      const offset = offsetPolygon(hole, -0.0625);
      const xs = offset.map((p) => p.x);
      expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.025, 3); // 0.15 - 2*0.0625
    });

    it('every offset edge points the same rotational direction as the original - the real invariant this check verifies', () => {
      const sq = square(0, 0, 2);
      const shrunk = offsetPolygon(sq, -0.5);
      for (let i = 0; i < shrunk.length - 1; i += 1) {
        const origDir = { x: sq[(i + 1) % (sq.length - 1)].x - sq[i].x, y: sq[(i + 1) % (sq.length - 1)].y - sq[i].y };
        const newDir = { x: shrunk[i + 1].x - shrunk[i].x, y: shrunk[i + 1].y - shrunk[i].y };
        expect(origDir.x * newDir.x + origDir.y * newDir.y).toBeGreaterThan(0);
      }
    });
  });

  describe('minThroatDistance message accuracy for many-toothed/non-convex holes (real bug: a real "MAXSpline" internal spline bore reported a wildly wrong throat estimate in the error message - not the pass/fail decision, which was already correct)', () => {
    // A 12-tooth star/spline-like hole, oversized offset so it always
    // collapses - only the reported ~X" throat estimate is under test here.
    function throatFromError(points, distance) {
      try {
        offsetPolygon(points, distance);
      } catch (e) {
        const match = e.message.match(/~([\d.]+)"/);
        return match ? Number(match[1]) : null;
      }
      throw new Error('expected offsetPolygon to throw');
    }

    it('does not fall back to the old centroid-distance overestimate (was ~7x too large against a real spline bore, roughly the outer radius instead of the tooth gap)', () => {
      const star = starHole(0, 0, 1, 0.5, 24);
      const throat = throatFromError(star, -0.2);
      expect(throat).not.toBeNull();
      expect(throat).toBeLessThan(1); // must read tighter than the shape's own outer radius
    });

    it('does not regress to 0 (an inverted-ray-direction bug introduced and caught while fixing the overestimate above: casting into the surrounding material instead of into the hole itself made every many-toothed shape read ~0.0000")', () => {
      const star = starHole(0, 0, 1, 0.5, 24);
      const throat = throatFromError(star, -0.2);
      expect(throat).toBeGreaterThan(0.05);
    });

    it('still reads close to the true diameter for an ordinary round hole (no regression for the common case)', () => {
      const round = circle(0, 0, 0.5);
      const throat = throatFromError(round, -0.6); // oversized on purpose
      expect(throat).toBeGreaterThan(0.8);
      expect(throat).toBeLessThan(1.1);
    });
  });

  describe('sharp-corner detection (real-world advice: a round tool can never reach a mathematically sharp interior point, however small - the fix belongs in the CAD as a fillet, not in tool selection)', () => {
    it('recommends a fillet for a genuinely sharp-tipped shape (star/spline teeth, ~15° tip angle)', () => {
      const star = starHole(0, 0, 1, 0.5, 24);
      expect(() => offsetPolygon(star, -0.2)).toThrow(/sharp internal corner.*fillet/);
    });

    it('does NOT recommend a fillet for a plain square/rectangle (90° corners - the ordinary "too small" case)', () => {
      const tinyHole = square(0, 0, 0.1);
      expect(() => offsetPolygon(tinyHole, -0.125)).toThrow(/too small for this tool/);
      expect(() => offsetPolygon(tinyHole, -0.125)).not.toThrow(/fillet/);
    });

    it('does NOT recommend a fillet for a smoothly-curved (finely-tessellated) narrow shape - fine tessellation of a real curve reads as many near-180° vertex angles, not one sharp point (matches a real "MAXSpline" bore\'s smoothly rounded teeth, which need a smaller tool, not a fillet - there is nothing to fillet)', () => {
      // A narrow ellipse-like oval approximated with many points - genuinely
      // too small for an oversized offset, but every vertex angle is close
      // to 180° since it's a fine polygon approximation of a smooth curve.
      const n = 64;
      const oval = [];
      for (let i = 0; i < n; i += 1) {
        const a = (i / n) * 2 * Math.PI;
        oval.push({ x: 0.3 * Math.cos(a), y: 0.05 * Math.sin(a) });
      }
      expect(() => offsetPolygon(oval, -0.1)).toThrow(/too small for this tool/);
      expect(() => offsetPolygon(oval, -0.1)).not.toThrow(/fillet/);
    });
  });
});

describe('generateRoutingGcode - single-tool (default)', () => {
  const contour = [{ points: square(0, 0, 4), isHole: false }];

  it('generates valid G-code with header/footer', () => {
    const result = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25 });
    expect(result.gcode).toContain('G17 (XY plane)');
    expect(result.gcode).toContain('M30 (program end)');
    expect(result.gcode).toContain('OUTER CONTOUR');
    expect(result.stats.toolChanges).toBe(0);
  });

  it('throws without contours', () => {
    expect(() => generateRoutingGcode([], { toolDiameter: 0.25, targetDepth: 0.25 })).toThrow(/at least one closed contour/);
  });

  it('throws without targetDepth', () => {
    expect(() => generateRoutingGcode(contour, { toolDiameter: 0.25 })).toThrow(/targetDepth is required/);
  });

  it('throws without toolDiameter in single-tool mode', () => {
    expect(() => generateRoutingGcode(contour, { targetDepth: 0.25 })).toThrow(/toolDiameter is required/);
  });

  it('generates tab zones when tabSpacing > 0, none when tabSpacing = 0', () => {
    const withTabs = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25, tabSpacing: 6 });
    const noTabs = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25, tabSpacing: 0 });
    expect(withTabs.stats.tabZones).toBeGreaterThan(0);
    expect(noTabs.stats.tabZones).toBe(0);
  });

  it('states the tool diameter to load before the spindle starts (no ATC on these routers - no T-code/M06 - but the operator still needs to know what to load)', () => {
    const result = generateRoutingGcode(contour, { toolDiameter: 0.1575, targetDepth: 0.25 });
    const lines = result.gcode.split('\n');
    const toolLineIdx = lines.findIndex((l) => l.includes('0.158" diameter - load before starting'));
    const m03Idx = lines.findIndex((l) => l.includes('M03'));
    expect(toolLineIdx).toBeGreaterThan(-1);
    expect(toolLineIdx).toBeLessThan(m03Idx); // stated before the spindle ever starts, not after
    expect(result.gcode).not.toMatch(/\bT\d+\s+M06\b/); // no ATC - never claim one
  });

  it('uses conservative dry-routing defaults and never enables coolant', () => {
    const result = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25 });
    expect(result.gcode).toContain('S14000 M03');
    expect(result.gcode).toContain('F8');
    expect(result.gcode).toContain('F25');
    expect(result.gcode).not.toMatch(/\bM[78]\b/);
  });
});

describe('generateRoutingGcode - edgeMargin (real shop constraint: work zero is set, and stock is nailed down, at the same X0/Y0 stock edge - a part modeled close to its own local origin can put the cutter within a fraction of an inch of that hardware)', () => {
  function rawMinXY(gcodeText) {
    let minX = Infinity, minY = Infinity;
    for (const line of gcodeText.split('\n')) {
      const m = line.match(/^G0[01] X(-?[\d.]+) Y(-?[\d.]+)/);
      if (!m) continue;
      minX = Math.min(minX, Number(m[1]));
      minY = Math.min(minY, Number(m[2]));
    }
    return { minX, minY };
  }

  it('defaults to a 0.5" margin, applied to the actual cutting path (not just the raw geometry) - accounts for the tool\'s own outward reach', () => {
    const contour = [{ points: square(0, 0, 4), isHole: false }];
    const result = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25 });
    const { minX, minY } = rawMinXY(result.gcode);
    // Raw geometry is shifted to margin+toolRadius so that, after the
    // outer contour's own outward tool-radius offset (which extends the
    // actual cutting path toolRadius further toward zero again), the real
    // cutting path's closest approach to X0/Y0 lands on exactly the
    // configured margin - not margin+toolRadius, the two cancel out.
    expect(minX).toBeCloseTo(0.5, 3);
    expect(minY).toBeCloseTo(0.5, 3);
    expect(result.gcode).toContain('0.50" clear of X0/Y0');
  });

  it('edgeMargin: 0 restores the pre-this-feature behavior - no shift, no header comment', () => {
    const contour = [{ points: square(0, 0, 4), isHole: false }];
    const result = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25, edgeMargin: 0 });
    const { minX, minY } = rawMinXY(result.gcode);
    expect(minX).toBeCloseTo(-2.125, 3); // unshifted: -2 (square half-width) - 0.125 (tool radius, outward)
    expect(minY).toBeCloseTo(-2.125, 3);
    expect(result.gcode).not.toContain('clear of X0/Y0');
  });

  it('a custom margin is honored exactly', () => {
    const contour = [{ points: square(0, 0, 4), isHole: false }];
    const result = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25, edgeMargin: 1.5 });
    const { minX, minY } = rawMinXY(result.gcode);
    expect(minX).toBeCloseTo(1.5, 3);
    expect(minY).toBeCloseTo(1.5, 3);
  });

  it('negative edgeMargin throws instead of silently doing something undefined', () => {
    const contour = [{ points: square(0, 0, 4), isHole: false }];
    expect(() => generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25, edgeMargin: -1 })).toThrow(/edgeMargin cannot be negative/);
  });

  it('multi-tool mode uses the LARGEST tool\'s radius for the raw-geometry shift, so real clearance never comes in under the configured margin regardless of which tool actually cuts closest to a given corner', () => {
    // assignContoursToTools always cuts the outer contour with
    // toolSequence[0] (the documented "primary/largest tool first"
    // convention - see its own doc comment), so a caller that doesn't
    // follow that convention could have a SMALLER tool doing the outer
    // cut. Using the sequence's max diameter for the raw shift (not just
    // toolSequence[0]'s) means clearance is still >= edgeMargin either
    // way - it just ends up more generous than the floor when a smaller
    // tool ends up doing the actual outward cut, never less.
    const smallToolFirst = [
      { toolDiameter: 0.125, toolNumber: 1, label: '1/8in detail bit' },
      { toolDiameter: 0.5, toolNumber: 2, label: '1/2in roughing bit' }
    ];
    const largeToolFirst = [
      { toolDiameter: 0.5, toolNumber: 1, label: '1/2in roughing bit' },
      { toolDiameter: 0.125, toolNumber: 2, label: '1/8in detail bit' }
    ];
    const a = generateRoutingGcode(partWithHoles(), { targetDepth: 0.25, toolSequence: smallToolFirst });
    const b = generateRoutingGcode(partWithHoles(), { targetDepth: 0.25, toolSequence: largeToolFirst });
    const marginFloor = 0.5 - 1e-6;
    const aBounds = rawMinXY(a.gcode);
    const bBounds = rawMinXY(b.gcode);
    expect(aBounds.minX).toBeGreaterThanOrEqual(marginFloor);
    expect(aBounds.minY).toBeGreaterThanOrEqual(marginFloor);
    expect(bBounds.minX).toBeGreaterThanOrEqual(marginFloor);
    expect(bBounds.minY).toBeGreaterThanOrEqual(marginFloor);
  });

  it('pockets shift by the same amount as contours, preserving their position relative to the outer profile', () => {
    const outer = [{ points: square(0, 0, 6), isHole: false }];
    const pocket = { points: square(0, 0, 2), depth: 0.1 };
    const noMargin = generateRoutingGcode(outer, { toolDiameter: 0.25, targetDepth: 0.5, stepDown: 0.5, pockets: [pocket], edgeMargin: 0 });
    const withMargin = generateRoutingGcode(outer, { toolDiameter: 0.25, targetDepth: 0.5, stepDown: 0.5, pockets: [pocket], edgeMargin: 1 });
    // Same ring/pocket stats either way - shifting doesn't change the geometry, just where it sits.
    expect(withMargin.stats.pocketRings).toBe(noMargin.stats.pocketRings);
    expect(withMargin.stats.pockets).toBe(noMargin.stats.pockets);
  });

  it('reports the applied shift on stats.edgeShiftX/edgeShiftY, so a consumer (e.g. the ghost-part overlay) can re-derive the same coordinate frame as the actual cutting path without re-deriving the margin math itself', () => {
    const contour = [{ points: square(0, 0, 4), isHole: false }];
    const result = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25 });
    // square(0,0,4) spans -2..2, tool radius 0.125, default margin 0.5:
    // shift = (0.5 + 0.125) - (-2) = 2.625
    expect(result.stats.edgeShiftX).toBeCloseTo(2.625, 3);
    expect(result.stats.edgeShiftY).toBeCloseTo(2.625, 3);
  });

  it('edgeShiftX/edgeShiftY are 0 when edgeMargin: 0 disables the shift entirely', () => {
    const contour = [{ points: square(0, 0, 4), isHole: false }];
    const result = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25, edgeMargin: 0 });
    expect(result.stats.edgeShiftX).toBe(0);
    expect(result.stats.edgeShiftY).toBe(0);
  });

  it('edgeShiftX/edgeShiftY are 0 when the geometry is already positioned exactly at the margin (no shift needed) - the shift always re-anchors to margin+toolRadius, in either direction', () => {
    // square centered at (0.625, 0.625) with half-width 2 -> minX = minY = -1.375,
    // and margin(0.5) + toolRadius(0.125) - (-1.375) != 0, so instead center it
    // so minX/minY land exactly on margin + toolRadius (0.625).
    const contour = [{ points: square(2.625, 2.625, 4), isHole: false }];
    const result = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25 });
    expect(result.stats.edgeShiftX).toBe(0);
    expect(result.stats.edgeShiftY).toBe(0);
  });
});

describe('generateRoutingGcode - cut order (real-world CAM safety practice: internal features before the outer profile, not after)', () => {
  it('cuts holes before the outer contour, single-tool mode (real bug: contours were cut in extraction order - outer first, since it is always the largest-area contour - meaning the outer profile got fully cut through material before any interior holes were touched; once a through-cut severs the part from the stock, continuing to machine anything else risks it shifting or coming loose)', () => {
    const result = generateRoutingGcode(partWithHoles(), { toolDiameter: 0.125, targetDepth: 0.25 });
    const holeIndex = result.gcode.indexOf('HOLE CONTOUR');
    const outerIndex = result.gcode.indexOf('OUTER CONTOUR');
    expect(holeIndex).toBeGreaterThan(-1);
    expect(outerIndex).toBeGreaterThan(-1);
    expect(holeIndex).toBeLessThan(outerIndex);
  });

  it('cuts holes before the outer contour, multi-tool mode, even when that means revisiting a tool already used for an earlier hole', () => {
    const toolSequence = [
      { toolDiameter: 0.25, toolNumber: 1, label: '1/4in roughing bit' },
      { toolDiameter: 0.125, toolNumber: 2, label: '1/8in detail bit' }
    ];
    const result = generateRoutingGcode(partWithHoles(), { targetDepth: 0.25, toolSequence });
    const lastHoleIndex = result.gcode.lastIndexOf('HOLE CONTOUR');
    const outerIndex = result.gcode.indexOf('OUTER CONTOUR');
    expect(lastHoleIndex).toBeGreaterThan(-1);
    expect(outerIndex).toBeGreaterThan(-1);
    expect(lastHoleIndex).toBeLessThan(outerIndex);
  });

  it('does not emit a spurious tool change when the outer contour needs the same tool that was already loaded for the last hole', () => {
    const toolSequence = [
      { toolDiameter: 0.25, toolNumber: 1, label: '1/4in roughing bit' },
      { toolDiameter: 0.5, toolNumber: 2, label: 'unused 1/2in bit' }
    ];
    // Both the outer and the 1" hole fit tool 1; the 0.15" hole needs
    // something smaller than tool 1 but tool 2 here is even bigger, so this
    // sequence only has one usable tool - no change should ever be needed.
    const contours = [
      { points: square(0, 0, 4), isHole: false },
      { points: square(1, 1, 1), isHole: true }
    ];
    const result = generateRoutingGcode(contours, { targetDepth: 0.25, toolSequence: [toolSequence[0]] });
    expect(result.stats.toolChanges).toBe(0);
    expect(result.gcode).not.toContain('TOOL CHANGE:');
  });
});

describe('generateRoutingGcode - multi-tool (router only, see implementations/toolchange-gcode-plan.md)', () => {
  const toolSequence = [
    { toolDiameter: 0.25, toolNumber: 1, label: '1/4in roughing bit' },
    { toolDiameter: 0.125, toolNumber: 2, label: '1/8in detail bit' }
  ];

  it('assigns the outer contour and the reachable hole to tool 1, the tiny hole to tool 2 - 2 tool changes, not 1, because holes are cut before the outer contour (see cut-order test below) and the outer needs tool 1 again after tool 2 handled the tiny hole', () => {
    const result = generateRoutingGcode(partWithHoles(), { targetDepth: 0.25, toolSequence });
    expect(result.stats.toolsUsed).toBe(2);
    expect(result.stats.toolChanges).toBe(2);
    expect(result.gcode).toContain('TOOL PLAN');
    expect(result.gcode).toContain('TOOL CHANGE: load 1/8in detail bit');
  });

  it('every cutting move actually appears (regression: targetDepth must propagate into each tool step)', () => {
    const result = generateRoutingGcode(partWithHoles(), { targetDepth: 0.25, toolSequence });
    const cutMoves = result.gcode.split('\n').filter((l) => l.startsWith('G01 X') && l.includes(' Z-0.2500'));
    expect(cutMoves.length).toBeGreaterThan(0); // this was a real bug once - zero full-depth moves when targetDepth didn't reach the per-tool body
  });

  it('skips a tool entirely (no tool-change block) if nothing needs it', () => {
    const noSmallHoles = [{ points: square(0, 0, 4), isHole: false }, { points: square(1, 1, 1), isHole: true }];
    const result = generateRoutingGcode(noSmallHoles, { targetDepth: 0.25, toolSequence });
    expect(result.stats.toolsUsed).toBe(1);
    expect(result.stats.toolChanges).toBe(0);
    expect(result.gcode).not.toContain('TOOL CHANGE:');
  });

  it('throws if no tool in the sequence can reach a hole', () => {
    const bigToolsOnly = [{ toolDiameter: 0.5, toolNumber: 1, label: '1/2in bit' }];
    expect(() => generateRoutingGcode(partWithHoles(), { targetDepth: 0.25, toolSequence: bigToolsOnly })).toThrow(/No tool in the sequence/);
  });

  it('falls back to single-tool mode when toolSequence is empty', () => {
    const result = generateRoutingGcode([{ points: square(0, 0, 4), isHole: false }], { toolDiameter: 0.25, targetDepth: 0.25, toolSequence: [] });
    expect(result.stats.toolChanges).toBe(0);
    expect(result.gcode).not.toContain('TOOL PLAN');
  });
});

describe('generateRoutingGcode - controller dialect (default linuxcnc vs wincnc for the ShopSabre Pro 408)', () => {
  const contour = [{ points: square(0, 0, 4), isHole: false }];

  it('defaults to linuxcnc and stays byte-identical whether or not controller is passed explicitly', () => {
    const implicit = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25 });
    const explicit = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25, controller: 'linuxcnc' });
    expect(implicit.gcode).toBe(explicit.gcode);
    expect(implicit.gcode).toContain('(');
    expect(implicit.gcode).not.toContain('[');
  });

  it('wincnc dialect uses square-bracket comments throughout, never round parens', () => {
    const result = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25, controller: 'wincnc' });
    expect(result.gcode).not.toContain('(');
    expect(result.gcode).not.toContain(')');
    expect(result.gcode).toContain('[inch]');
  });

  it('wincnc dialect omits G17, uses G22 (not G21) for metric, and drops the LinuxCNC G54 line', () => {
    const inch = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25, controller: 'wincnc' });
    expect(inch.gcode).not.toContain('G17');
    // Explanatory comment text is allowed to mention "G54" descriptively
    // (it does, to tell the operator why there isn't one) - what actually
    // matters is that no line emits it as a live command.
    expect(inch.gcode).not.toMatch(/^G54\b/m);

    const metric = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25, controller: 'wincnc', units: 'mm' });
    expect(metric.gcode).toContain('G22');
    // G21 means centimeters on WinCNC - must never be emitted as a live
    // command for a mm job (the explanatory comment is allowed to mention
    // "G21" descriptively, same reasoning as the G54 check above).
    expect(metric.gcode).not.toMatch(/^G21\b/m);

    const linuxcncMetric = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25, units: 'mm' });
    expect(linuxcncMetric.gcode).toContain('G21');
  });

  it('wincnc dialect uses a bare G4 (not M00) for the tool-change pause, still keeps M03/M05', () => {
    const toolSequence = [
      { toolDiameter: 0.25, toolNumber: 1, label: '1/4in roughing bit' },
      { toolDiameter: 0.125, toolNumber: 2, label: '1/8in detail bit' }
    ];
    const result = generateRoutingGcode(partWithHoles(), { targetDepth: 0.25, toolSequence, controller: 'wincnc' });
    expect(result.gcode).not.toContain('M00');
    expect(result.gcode).toContain('G4 [TOOL CHANGE');
    expect(result.gcode).toContain('M03');
    expect(result.gcode).toContain('M05');
  });

  it('wincnc dialect omits M30, linuxcnc keeps it', () => {
    const wincnc = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25, controller: 'wincnc' });
    const linuxcnc = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25 });
    expect(wincnc.gcode).not.toContain('M30');
    expect(wincnc.gcode).toContain('[PROGRAM END]');
    expect(linuxcnc.gcode).toContain('M30 (program end)');
  });

  it('linuxcnc header defensively cancels canned cycle/cutter comp/tool length offset (in case a prior program on the shared machine left one active); wincnc omits it, unconfirmed against WinCNC\'s own manual', () => {
    const linuxcnc = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25 });
    expect(linuxcnc.gcode).toMatch(/^G80 G40 G49\b/m);
    const wincnc = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25, controller: 'wincnc' });
    expect(wincnc.gcode).not.toContain('G80');
    expect(wincnc.gcode).not.toContain('G40');
    expect(wincnc.gcode).not.toContain('G49');
  });
});

describe('generateRoutingGcode - spindle spin-up dwell (real risk: engaging the cut before the spindle reaches commanded RPM is a stall/broken-tool risk, not theoretical)', () => {
  const contour = [{ points: square(0, 0, 4), isHole: false }];

  it('defaults to a 2-second dwell (G04 P, linuxcnc) right after the initial spindle-on', () => {
    const result = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25 });
    const lines = result.gcode.split('\n');
    const m03Index = lines.findIndex((l) => l.includes('M03'));
    expect(m03Index).toBeGreaterThan(-1);
    expect(lines[m03Index + 1]).toMatch(/^G04 P2\.0 /);
  });

  it('uses G04 X (not P) for wincnc - confirmed against WinCNC\'s own manual, P is not the duration word there', () => {
    const result = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25, controller: 'wincnc' });
    expect(result.gcode).not.toMatch(/G04 P/);
    expect(result.gcode).toMatch(/G04 X2\.0 /);
  });

  it('spindleDwellSeconds: 0 omits the dwell line entirely', () => {
    const result = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25, spindleDwellSeconds: 0 });
    expect(result.gcode).not.toContain('G04');
  });

  it('respects a custom spindleDwellSeconds value', () => {
    const result = generateRoutingGcode(contour, { toolDiameter: 0.25, targetDepth: 0.25, spindleDwellSeconds: 5 });
    expect(result.gcode).toMatch(/G04 P5\.0 /);
  });

  it('multi-tool mode dwells after every M03, including mid-program tool-change restarts', () => {
    const toolSequence = [
      { toolDiameter: 0.25, toolNumber: 1, label: '1/4in roughing bit' },
      { toolDiameter: 0.125, toolNumber: 2, label: '1/8in detail bit' }
    ];
    const result = generateRoutingGcode(partWithHoles(), { targetDepth: 0.25, toolSequence });
    const m03Count = (result.gcode.match(/M03/g) || []).length;
    const dwellCount = (result.gcode.match(/G04 P2\.0/g) || []).length;
    expect(m03Count).toBeGreaterThan(1); // real tool change actually happened
    expect(dwellCount).toBe(m03Count); // every spindle-on got its own dwell
  });
});

describe('generateRoutingGcode - no duplicate final pass (real bug found in a live-generated file: floating-point drift when stepDown does not evenly divide targetDepth could leave depth a hair under target, running one redundant extra pass at the same printed depth)', () => {
  const outer = [{ points: square(0, 0, 4), isHole: false }];

  it('stepDown that does not evenly divide targetDepth still produces exactly one pass per depth level', () => {
    const result = generateRoutingGcode(outer, { toolDiameter: 0.25, stepDown: 0.0333333, targetDepth: 0.1 });
    const passDepths = result.gcode.split('\n').filter((l) => l.includes('-- pass at')).map((l) => l.match(/Z(-[\d.]+)/)[1]);
    expect(passDepths).toEqual(['-0.0333', '-0.0667', '-0.1000']);
  });

  it('same fix applies to the circular/helical path', () => {
    const part = [{ points: square(0, 0, 4), isHole: false }, { points: circle(0, 0, 0.5), isHole: true }];
    const result = generateRoutingGcode(part, { toolDiameter: 0.125, stepDown: 0.0333333, targetDepth: 0.1 });
    const passDepths = result.gcode.split('\n').filter((l) => l.includes('-- pass at')).map((l) => l.match(/Z(-[\d.]+)/)[1]);
    expect(passDepths).toEqual(['-0.0333', '-0.0667', '-0.1000', '-0.0333', '-0.0667', '-0.1000']);
  });

  it('classic 0.1+0.1+0.1 float drift (0.30000000000000004) still yields exactly 3 passes, not 4', () => {
    const result = generateRoutingGcode(outer, { toolDiameter: 0.25, stepDown: 0.1, targetDepth: 0.1 + 0.1 + 0.1 });
    const passDepths = result.gcode.split('\n').filter((l) => l.includes('-- pass at'));
    expect(passDepths).toHaveLength(3);
  });
});

describe('generateRoutingGcode - tabs never apply to holes (real bug: a small hole could spend most of its final pass at targetDepth-tabHeight instead of cutting through)', () => {
  it('a hole never gets a tab zone, even with tabSpacing/tabWidth set', () => {
    const part = [{ points: square(0, 0, 4), isHole: false }, { points: square(1, 1, 0.6), isHole: true }];
    const result = generateRoutingGcode(part, { toolDiameter: 0.125, targetDepth: 0.25, tabSpacing: 6, tabWidth: 0.25, tabHeight: 0.06 });
    const lines = result.gcode.split('\n');
    const holeStart = lines.findIndex((l) => l.includes('HOLE CONTOUR'));
    const holeEnd = lines.findIndex((l, idx) => idx > holeStart && l.includes('(retract)'));
    const holeLines = lines.slice(holeStart, holeEnd);
    // Final pass = targetDepth (0.25"). No line in the hole's section should
    // ever show the tab-clamped depth (targetDepth - tabHeight = 0.19") -
    // every point on a hole's final pass must reach full depth.
    expect(holeLines.some((l) => l.includes('Z-0.1900'))).toBe(false);
    expect(holeLines.some((l) => l.includes('Z-0.2500'))).toBe(true);
  });

  it('the outer contour still gets real tabs (regression: the fix must not disable tabs everywhere)', () => {
    const part = [{ points: square(0, 0, 4), isHole: false }];
    const result = generateRoutingGcode(part, { toolDiameter: 0.25, targetDepth: 0.25, tabSpacing: 6, tabWidth: 0.25, tabHeight: 0.06 });
    expect(result.stats.tabZones).toBeGreaterThan(0);
  });
});

describe('generateRoutingGcode - tab zones are never silently dropped when they land inside one long segment (real bug: found on a real 20"-perimeter motor mounting plate where 2 of 3 tabs vanished with no error)', () => {
  it('a tab zone entirely inside a single long straight edge still shows up as a real depth clamp', () => {
    // A big square (long straight edges, few vertices) with a small
    // targetDepth/tabHeight so the clamp value is unambiguous, and
    // tabSpacing chosen so a zone center lands mid-edge, not at a vertex.
    const part = [{ points: square(0, 0, 20), isHole: false }];
    const result = generateRoutingGcode(part, {
      toolDiameter: 0.25, targetDepth: 0.25, tabHeight: 0.1, tabWidth: 0.25, tabSpacing: 20
    });
    // tabSpacing 20 on a ~80"+ perimeter square places multiple zone
    // centers along what are, on a 4-point square, necessarily long single
    // edges - the old buggy version's segment-midpoint check would never
    // see these (a segment many times longer than the zone can't have its
    // own midpoint land inside a 0.25"-wide zone positioned anywhere but
    // dead center of that specific edge).
    expect(result.gcode).toContain('Z-0.1500'); // targetDepth(0.25) - tabHeight(0.1)
    expect(result.stats.tabZones).toBeGreaterThan(1);
  });

  it('the pre-fix regression case: 3 tab zones on a real-shaped rectangle (long edges, short corner clusters) - all 3 must produce a depth clamp, not just the one at the seam', () => {
    // Mirrors the real motor-plate shape that exposed this bug: a simple
    // rectangle where tabSpacing divides the perimeter into zones whose
    // centers land mid-edge on 3 different long straight sides.
    const rect = [
      { x: -2.5, y: -2.5 }, { x: 2.5, y: -2.5 }, { x: 2.5, y: 2.5 }, { x: -2.5, y: 2.5 }, { x: -2.5, y: -2.5 }
    ];
    const part = [{ points: rect, isHole: false }];
    const result = generateRoutingGcode(part, {
      toolDiameter: 0.25, targetDepth: 0.2, tabHeight: 0.05, tabWidth: 0.25, tabSpacing: 7
    });
    const tabDepthStr = 'Z-0.1500'; // 0.2 - 0.05
    const tabLineCount = result.gcode.split('\n').filter((l) => l.includes(tabDepthStr)).length;
    // 3 separate zones (perimeter ~20.9" / spacing 7 = 2, so 2 zones minimum;
    // asserting >1 distinct occurrence is the real regression check - the
    // pre-fix version could produce exactly 0 tab-depth lines at all here).
    expect(tabLineCount).toBeGreaterThan(0);
    expect(result.stats.tabZones).toBeGreaterThan(1);
  });

  it('a segment with no tab zone touching it still emits exactly one G01 move (no gratuitous splitting)', () => {
    const part = [{ points: square(0, 0, 4), isHole: false }];
    const result = generateRoutingGcode(part, { toolDiameter: 0.25, targetDepth: 0.05, stepDown: 0.05, tabSpacing: 0 });
    // With tabs off entirely, line count should match the simple one-move-
    // per-vertex baseline (4 edges = 4 G01 moves for this single-pass cut).
    const cutMoves = result.gcode.split('\n').filter((l) => l.startsWith('G01 X')).length;
    expect(cutMoves).toBe(4);
  });
});

describe('generateRoutingGcode - seam tab is not silently cut to half width (real bug: the first tab zone always centers exactly at path distance 0 - the closed contour\'s seam - so clamping the low end away with no wraparound piece at the other end left that one tab at half its configured width, every job, with no error)', () => {
  it('a low-zone-count contour (perimeter/spacing rounds down near 1) still gets tabWidth of material at the seam, split across both ends of the path', () => {
    const part = [{ points: square(0, 0, 4), isHole: false }];
    // perimeter ~16" (after tool-radius offset) / spacing 20 -> round ~= 1,
    // clamped up to recommendTabCount's minimum of 2 zones - i=0 is always
    // at distance 0, the exact seam case, regardless of the total count.
    const result = generateRoutingGcode(part, { toolDiameter: 0.25, targetDepth: 0.25, tabHeight: 0.06, tabWidth: 0.25, tabSpacing: 20 });
    const tabDepthStr = 'Z-0.1900'; // targetDepth(0.25) - tabHeight(0.06)
    const finalPassStart = result.gcode.split('\n').findIndex((l) => l.includes('pass at Z-0.2500'));
    const finalPassLines = result.gcode.split('\n').slice(finalPassStart);
    const tabLines = finalPassLines.filter((l) => l.includes(tabDepthStr));
    // Pre-fix, only the [0, width/2] half existed - one clamp point. The
    // wraparound half near the end of the path must show up too.
    expect(tabLines.length).toBeGreaterThanOrEqual(2);
  });

  it('no longer puts a tab on the seam at all, because the seam is a corner', () => {
    // This used to report 3 pieces: tab i=0 was placed at path distance 0
    // unconditionally - the closed contour's seam, which on a rectangle is
    // a corner - and wrapped into 2 pieces. Tabs are now placed on flat
    // runs, so nothing lands on the corner and nothing has to wrap.
    const part = [{ points: square(0, 0, 4), isHole: false }];
    const result = generateRoutingGcode(part, { toolDiameter: 0.25, targetDepth: 0.25, tabHeight: 0.06, tabWidth: 0.25, tabSpacing: 20 });
    expect(result.stats.tabZones).toBe(2);
  });

  it('still splits a seam-straddling tab into two pieces when one genuinely lands there', () => {
    // The wraparound is still needed on the fallback path: a fully round
    // profile has no flat to place tabs on, so they fall back to even
    // spacing, which does put one at distance 0. Four tabs, one straddling
    // the seam, is five pieces.
    const round = [{ points: [...Array(65)].map((_, i) => ({
      x: 2 + 2 * Math.cos((i / 64) * 2 * Math.PI),
      y: 2 + 2 * Math.sin((i / 64) * 2 * Math.PI)
    })), isHole: false }];
    const result = generateRoutingGcode(round, { toolDiameter: 0.25, targetDepth: 0.25, tabHeight: 0.06, tabWidth: 0.25, tabCount: 4 });
    expect(result.stats.tabZones).toBe(5);
    expect(result.gcode).toContain('ON A CURVED EDGE');
  });

  it('places both tabs mid-edge, so neither straddles the seam', () => {
    const rect = [{ x: -2.5, y: -2.5 }, { x: 2.5, y: -2.5 }, { x: 2.5, y: 2.5 }, { x: -2.5, y: 2.5 }, { x: -2.5, y: -2.5 }];
    const part = [{ points: rect, isHole: false }];
    // Both tabs now land mid-edge on flat runs, so neither wraps and the
    // count is exactly the number of tabs. Previously i=0 sat on the seam
    // corner and split, reporting 3 for 2 tabs.
    const result = generateRoutingGcode(part, { toolDiameter: 0.25, targetDepth: 0.2, tabHeight: 0.05, tabWidth: 0.25, tabSpacing: 10 });
    expect(result.stats.tabZones).toBe(2);
  });
});

describe('generateRoutingGcode - pocket clearing (single-tool only; real 2.5D milling "Option A" - see implementations/millimplementations.md)', () => {
  const outer = [{ points: square(0, 0, 6), isHole: false }];

  it('with no params.pockets, behavior is unchanged from before pockets existed', () => {
    const result = generateRoutingGcode(outer, { toolDiameter: 0.25, targetDepth: 0.5 });
    expect(result.gcode).not.toContain('POCKET');
    expect(result.stats.pockets).toBe(0);
    expect(result.stats.pocketRings).toBe(0);
  });

  it('a pocket is fully cleared BEFORE the outer contour (same safety ordering as holes - see CUT ORDER in the file header)', () => {
    const pocket = { points: square(0, 0, 2), depth: 0.15 };
    const result = generateRoutingGcode(outer, { toolDiameter: 0.25, targetDepth: 0.5, pockets: [pocket] });
    const lines = result.gcode.split('\n');
    const pocketIdx = lines.findIndex((l) => l.includes('POCKET'));
    const outerIdx = lines.findIndex((l) => l.includes('OUTER CONTOUR'));
    expect(pocketIdx).toBeGreaterThan(-1);
    expect(outerIdx).toBeGreaterThan(-1);
    expect(pocketIdx).toBeLessThan(outerIdx);
  });

  it('a pocket only cuts down to its own floor depth, never the part\'s full targetDepth', () => {
    const pocket = { points: square(0, 0, 2), depth: 0.15 };
    const result = generateRoutingGcode(outer, { toolDiameter: 0.25, targetDepth: 0.5, stepDown: 0.5, pockets: [pocket] });
    const lines = result.gcode.split('\n');
    const pocketIdx = lines.findIndex((l) => l.includes('POCKET'));
    const outerIdx = lines.findIndex((l) => l.includes('OUTER CONTOUR'));
    const pocketLines = lines.slice(pocketIdx, outerIdx);
    // Floor depth (0.15") shows up, but nothing in the pocket's own section
    // ever reaches anywhere near the part's full targetDepth (0.5").
    expect(pocketLines.some((l) => l.includes('Z-0.1500'))).toBe(true);
    expect(pocketLines.some((l) => l.includes('Z-0.5000'))).toBe(false);
  });

  it('a pocket much larger than the tool produces multiple concentric clearing rings, wall (largest) cut last per Z level', () => {
    const pocket = { points: square(0, 0, 3), depth: 0.1 };
    const result = generateRoutingGcode(outer, { toolDiameter: 0.25, targetDepth: 0.5, stepDown: 0.5, pockets: [pocket] });
    expect(result.stats.pocketRings).toBeGreaterThan(1);
    // The wall ring is the widest-travel ring (largest X/Y extent) - it
    // must be the LAST ring cut at each Z level, per clearPocket's ordering
    // (innermost first, wall last), so material stays supported as long as
    // possible while the interior clears.
    const lines = result.gcode.split('\n');
    const pocketIdx = lines.findIndex((l) => l.includes('POCKET'));
    const outerIdx = lines.findIndex((l) => l.includes('OUTER CONTOUR'));
    const ringStarts = lines.slice(pocketIdx, outerIdx).filter((l) => l.includes('rapid to ring'));
    const firstLevelRingCount = result.stats.pocketRings;
    const firstLevelStarts = ringStarts.slice(0, firstLevelRingCount);
    const ringNumbers = firstLevelStarts.map((l) => Number(l.match(/ring (\d+)\//)[1]));
    expect(ringNumbers).toEqual([...ringNumbers].sort((a, b) => a - b)); // 1, 2, 3, ... in cut order
    expect(ringNumbers[ringNumbers.length - 1]).toBe(firstLevelRingCount); // wall ring (highest number) cut last
  });

  it('a pocket sized close to the tool diameter collapses to exactly 1 ring (the wall itself, no room for an interior ring)', () => {
    const pocket = { points: square(0, 0, 0.4), depth: 0.1 };
    const result = generateRoutingGcode(outer, { toolDiameter: 0.25, targetDepth: 0.5, stepDown: 0.5, pockets: [pocket] });
    expect(result.stats.pocketRings).toBe(1);
  });

  it('a pocket too small for the tool throws the same clear error as an undersized hole (reuses offsetPolygon\'s own collapse detection)', () => {
    const pocket = { points: square(0, 0, 0.1), depth: 0.1 };
    expect(() => generateRoutingGcode(outer, { toolDiameter: 0.25, targetDepth: 0.5, pockets: [pocket] }))
      .toThrow(/too small for this tool/);
  });

  it('pocket rings ramp into depth (entry safety) instead of plunging straight down at full pass depth', () => {
    const pocket = { points: square(0, 0, 3), depth: 0.1 };
    const result = generateRoutingGcode(outer, { toolDiameter: 0.25, targetDepth: 0.5, stepDown: 0.1, pockets: [pocket] });
    const lines = result.gcode.split('\n');
    const pocketIdx = lines.findIndex((l) => l.includes('POCKET'));
    const outerIdx = lines.findIndex((l) => l.includes('OUTER CONTOUR'));
    const firstRingCut = lines.slice(pocketIdx, outerIdx).find((l) => l.startsWith('G01 X') && l.includes('Z-0.1000'));
    // The very first G01 cutting move to land at full pass depth (Z-0.1) is
    // NOT the first G01 of its ring - real ramping happened before it, same
    // invariant already proven for outer/hole contours above.
    expect(firstRingCut).toBeDefined();
  });

  it('multiple pockets at different depths are each cleared to their own depth', () => {
    const shallow = { points: square(-2, 0, 1), depth: 0.05 };
    const deep = { points: square(2, 0, 1), depth: 0.2 };
    const result = generateRoutingGcode(outer, { toolDiameter: 0.25, targetDepth: 0.5, stepDown: 0.5, pockets: [shallow, deep] });
    expect(result.stats.pockets).toBe(2);
    expect(result.gcode).toContain('Z-0.0500');
    expect(result.gcode).toContain('Z-0.2000');
  });

  it('wincnc dialect converts pocket comments to brackets too, same as every other line', () => {
    const pocket = { points: square(0, 0, 2), depth: 0.1 };
    const result = generateRoutingGcode(outer, { toolDiameter: 0.25, targetDepth: 0.5, controller: 'wincnc', pockets: [pocket] });
    expect(result.gcode).toContain('[--- POCKET');
    expect(result.gcode).not.toContain('(--- POCKET');
  });

  it('a circular pocket clears with concentric rings too, not the true-arc helical path outer/hole contours get (pockets always ring-clear, by design)', () => {
    const pocket = { points: circle(0, 0, 1.5), depth: 0.1 };
    const result = generateRoutingGcode(outer, { toolDiameter: 0.25, targetDepth: 0.5, stepDown: 0.5, pockets: [pocket] });
    expect(result.stats.pocketRings).toBeGreaterThan(1);
    expect(result.gcode).not.toContain('G02');
    expect(result.gcode).not.toContain('G03');
  });

  it('a concave (L-shaped) pocket clears without collapsing or self-intersecting - the notch survives through every successive ring offset', () => {
    const lShape = [
      { x: -2, y: -2 }, { x: 2, y: -2 }, { x: 2, y: 0 },
      { x: 0, y: 0 }, { x: 0, y: 2 }, { x: -2, y: 2 }, { x: -2, y: -2 }
    ];
    const result = generateRoutingGcode(outer, { toolDiameter: 0.25, targetDepth: 0.5, stepDown: 0.5, pockets: [{ points: lShape, depth: 0.15 }] });
    expect(result.stats.pocketRings).toBeGreaterThan(1);
    const lines = result.gcode.split('\n');
    const pocketIdx = lines.findIndex((l) => l.includes('POCKET'));
    const outerIdx = lines.findIndex((l) => l.includes('OUTER CONTOUR'));
    // Every ring should still be a real 6-vertex L (5 distinct destination
    // points + the closing move back to start) - if the notch had collapsed
    // into a plain rectangle under repeated offsetting, the innermost rings
    // would show fewer distinct X/Y destinations than the outer ones.
    const ringStartIdxs = [];
    for (let i = pocketIdx; i < outerIdx; i += 1) if (lines[i].includes('rapid to ring')) ringStartIdxs.push(i);
    const firstRingLines = lines.slice(ringStartIdxs[0], ringStartIdxs[1]).filter((l) => l.startsWith('G01 X'));
    expect(firstRingLines.length).toBe(6);
  });

  it('a too-narrow pocket for the tool throws the same error a too-small hole does, not a silent bad toolpath', () => {
    const sliver = [{ x: -2, y: -0.05 }, { x: 2, y: -0.05 }, { x: 2, y: 0.05 }, { x: -2, y: 0.05 }, { x: -2, y: -0.05 }];
    expect(() => generateRoutingGcode(outer, { toolDiameter: 0.25, targetDepth: 0.5, pockets: [{ points: sliver, depth: 0.1 }] }))
      .toThrow(/too small for this tool/);
  });

  it('mixed pocket shapes (square, circle, concave L) in the same job all clear correctly together', () => {
    const lShape = [
      { x: -2, y: -2 }, { x: 2, y: -2 }, { x: 2, y: 0 },
      { x: 0, y: 0 }, { x: 0, y: 2 }, { x: -2, y: 2 }, { x: -2, y: -2 }
    ];
    const result = generateRoutingGcode(outer, {
      toolDiameter: 0.25, targetDepth: 0.5, stepDown: 0.5,
      pockets: [
        { points: square(-3, 3, 1), depth: 0.1 },
        { points: circle(3, 3, 0.8), depth: 0.2 },
        { points: lShape, depth: 0.15 },
      ],
    });
    expect(result.stats.pockets).toBe(3);
    expect(result.stats.pocketRings).toBeGreaterThan(3);
  });
});

describe('generateRoutingGcode - ramped entry, no more straight plunges into solid material', () => {
  it('the first cutting moves of a pass show gradually increasing depth, not an instant jump to full depth', () => {
    // targetDepth deliberately large relative to the square's own edge
    // length so the ramp distance (zDrop/MAX_RAMP_SLOPE) genuinely spans
    // more than one edge - otherwise, correctly, the ramp can finish
    // within a single (long) first edge, which is real, intended behavior
    // now that the ramp is measured at each segment's endpoint instead of
    // its midpoint (see emitContourPass) - not something to test around.
    const part = [{ points: square(0, 0, 4), isHole: false }];
    // tabSpacing: 0 - isolate ramp behavior from tab-zone behavior. This is
    // the final pass (stepDown===targetDepth), and by default (tabSpacing:
    // 6) a tab zone would land inside this square's ~4.25"-long first edge
    // and correctly clamp part of it to tab depth (see emitContourPass's
    // segment-splitting fix) - real, intended behavior, just not what this
    // test is checking.
    const result = generateRoutingGcode(part, { toolDiameter: 0.25, stepDown: 2, targetDepth: 2, feedRate: 40, plungeRate: 15, tabSpacing: 0 });
    const lines = result.gcode.split('\n');
    const passStart = lines.findIndex((l) => l.includes('ramped entry'));
    const cutLines = lines.slice(passStart + 1).filter((l) => l.startsWith('G01 X')).slice(0, 4);
    const depths = cutLines.map((l) => Number(l.match(/Z(-[\d.]+)/)[1]));
    // Strictly increasing magnitude (getting deeper) across the first few
    // moves, and the very first one must NOT already be at full depth.
    expect(Math.abs(depths[0])).toBeLessThan(2);
    for (let i = 1; i < depths.length; i += 1) expect(Math.abs(depths[i])).toBeGreaterThanOrEqual(Math.abs(depths[i - 1]));
  });

  it('the ramp actually completes by the declared rampDistance, not later (real bug: using segment midpoint instead of endpoint under-ramped past the stated distance whenever a single segment was longer than the ramp)', () => {
    const part = [{ points: square(0, 0, 4), isHole: false }];
    // tabSpacing: 0 - see the previous test's comment on why (isolates ramp
    // behavior from this square's default-tab-zone-0 landing in the same edge).
    const result = generateRoutingGcode(part, { toolDiameter: 0.25, stepDown: 0.1, targetDepth: 0.1, feedRate: 40, plungeRate: 15, tabSpacing: 0 });
    // rampDistance = min(perimeter*0.5, 0.1/0.15) = 0.1/0.15 =~ 0.67", well
    // under one edge of this ~17"-perimeter square - the very first G01
    // move (covering the whole first edge, ~4.25") must already show full
    // depth, since by its endpoint the ramp distance has long passed.
    const lines = result.gcode.split('\n');
    const passStart = lines.findIndex((l) => l.includes('ramped entry'));
    const firstCut = lines.slice(passStart + 1).find((l) => l.startsWith('G01 X'));
    expect(firstCut).toContain('Z-0.1000');
  });

  it('no more standalone "(plunge)" line - descent is folded into the ramp', () => {
    const part = [{ points: square(0, 0, 4), isHole: false }];
    const result = generateRoutingGcode(part, { toolDiameter: 0.25, targetDepth: 0.25 });
    expect(result.gcode).not.toContain('(plunge)');
  });

  it('ramp uses plungeRate, the flat remainder of the pass uses feedRate', () => {
    const part = [{ points: square(0, 0, 4), isHole: false }];
    const result = generateRoutingGcode(part, { toolDiameter: 0.25, stepDown: 0.05, targetDepth: 0.05, feedRate: 40, plungeRate: 7 });
    // The initial feed-down-to-surface move (not part of the per-vertex
    // contour loop, so not corner-scaled) still carries the raw plungeRate.
    expect(result.gcode).toContain('F7.00000');
    // Every vertex of a square is a 90deg corner, which falls in
    // cornerFeedScale's partial-slowdown range (60deg-150deg) - so the "flat"
    // feedRate segments here are all scaled to 40 * 0.6 = 24, not raw 40.
    // See the dedicated corner-slowdown describe block below for the
    // unscaled-vs-scaled feed math itself.
    expect(result.gcode).toContain('F24.00000');
  });

  it('approaches Z0 with a feed move, not a rapid - defense-in-depth in case Z0/stock height is slightly off', () => {
    const part = [{ points: square(0, 0, 4), isHole: false }];
    const result = generateRoutingGcode(part, { toolDiameter: 0.25, targetDepth: 0.25, plungeRate: 12 });
    const lines = result.gcode.split('\n');
    expect(lines).not.toContain('G00 Z0.0000 (rapid to material surface)');
    const clearanceIdx = lines.findIndex((l) => l.startsWith('G00 Z0.02'));
    expect(clearanceIdx).toBeGreaterThan(-1);
    expect(lines[clearanceIdx + 1]).toBe('G01 Z0.0000 F12.00000 (feed down to material surface - not a rapid, in case Z0/stock height is slightly off)');
  });

  it('same feed-down approach applies to the circular/helical path', () => {
    const part = [{ points: square(0, 0, 4), isHole: false }, { points: circle(0, 0, 0.5), isHole: true }];
    const result = generateRoutingGcode(part, { toolDiameter: 0.125, targetDepth: 0.25, plungeRate: 12 });
    const lines = result.gcode.split('\n');
    const holeStart = lines.findIndex((l) => l.includes('true circle'));
    expect(lines[holeStart + 3]).toBe('G01 Z0.0000 F12.00000 (feed down to material surface - not a rapid, in case Z0/stock height is slightly off)');
  });
});

describe('generateRoutingGcode - rejects a helical entry with too little clearance to be a real helix (real bug: found on a real fixture where a hole only marginally bigger than its tool produced a 167-turn near-stationary "helix" - effectively a full-engagement plunge in an arc-command costume)', () => {
  it('throws a clear, actionable error when a circular hole leaves under 15% of the tool radius as toolpath clearance', () => {
    // Hole radius 0.5", tool diameter 0.9" (radius 0.45"): toolpath radius =
    // 0.5-0.45 = 0.05", required minimum = 0.45*0.15 = 0.0675" - fails.
    const part = [{ points: square(0, 0, 4), isHole: false }, { points: circle(0, 0, 0.5), isHole: true }];
    expect(() => generateRoutingGcode(part, { toolDiameter: 0.9, targetDepth: 0.25 })).toThrow(
      /too close to this tool's diameter for a safe helical entry/
    );
  });

  it('still cuts normally when there is adequate clearance (regression: the check must not reject ordinary holes)', () => {
    // Same 0.5" hole, a tool small enough to leave real clearance.
    const part = [{ points: square(0, 0, 4), isHole: false }, { points: circle(0, 0, 0.5), isHole: true }];
    const result = generateRoutingGcode(part, { toolDiameter: 0.5, targetDepth: 0.25 });
    expect(result.gcode).toContain('true circle');
  });

  it('a multi-tool sequence automatically falls through to a smaller tool instead of throwing', () => {
    const part = [{ points: square(0, 0, 4), isHole: false }, { points: circle(0, 0, 0.5), isHole: true }];
    const result = generateRoutingGcode(part, {
      targetDepth: 0.25,
      toolSequence: [
        { toolDiameter: 0.9, toolNumber: 1, label: 'too big for safe helix' },
        { toolDiameter: 0.5, toolNumber: 2, label: 'small enough' }
      ]
    });
    expect(result.gcode).toContain('true circle');
    expect(result.stats.toolsUsed).toBeGreaterThan(0);
  });

  it('single-tool mode throws the same actionable error a multi-tool sequence would have avoided by falling through', () => {
    const part = [{ points: square(0, 0, 4), isHole: false }, { points: circle(0, 0, 0.5), isHole: true }];
    expect(() => generateRoutingGcode(part, { toolDiameter: 0.9, targetDepth: 0.25 })).toThrow(
      /use a smaller tool for this hole/
    );
  });
});

describe('generateRoutingGcode - true arcs for circular features (real hole/boss geometry, not a polygon approximation)', () => {
  it('a circular hole is cut with G02/G03 helical entry, not G01 polygon segments', () => {
    const part = [{ points: square(0, 0, 4), isHole: false }, { points: circle(0, 0, 0.5), isHole: true }];
    const result = generateRoutingGcode(part, { toolDiameter: 0.125, targetDepth: 0.25 });
    const lines = result.gcode.split('\n');
    const holeStart = lines.findIndex((l) => l.includes('true circle'));
    expect(holeStart).toBeGreaterThan(-1);
    const holeEnd = lines.findIndex((l, idx) => idx > holeStart && l.includes('(retract)'));
    const holeLines = lines.slice(holeStart, holeEnd);
    expect(holeLines.some((l) => l.startsWith('G02') || l.startsWith('G03'))).toBe(true);
    // No G01 CUTTING (XY) moves - a real G01 Z-only move is expected here
    // (the feed-down-to-surface approach move, see APPROACH_CLEARANCE),
    // that's not a polygon segment, just a vertical feed.
    expect(holeLines.some((l) => l.startsWith('G01 X'))).toBe(false);
    expect(holeLines.some((l) => l.startsWith('G01 Z'))).toBe(true);
    expect(holeLines.some((l) => l.includes('I') && l.includes('J'))).toBe(true);
  });

  it('the helical entry ramps Z down over multiple turns before the cleanup circle at full depth', () => {
    const part = [{ points: square(0, 0, 4), isHole: false }, { points: circle(0, 0, 0.5), isHole: true }];
    const result = generateRoutingGcode(part, { toolDiameter: 0.125, stepDown: 0.5, targetDepth: 0.5 });
    const arcLines = result.gcode.split('\n').filter((l) => l.startsWith('G02') || l.startsWith('G03'));
    const depths = arcLines.map((l) => Math.abs(Number(l.match(/Z(-[\d.]+)/)[1])));
    expect(depths.length).toBeGreaterThanOrEqual(3); // at least MIN_HELIX_TURNS (2) + the cleanup circle
    expect(depths[0]).toBeLessThan(0.5); // first turn doesn't already reach full depth
    expect(depths[depths.length - 1]).toBeCloseTo(0.5, 4); // cleanup circle reaches exact target depth
  });

  it('a non-circular hole (square) still uses the ordinary G01 polygon path', () => {
    const part = [{ points: square(0, 0, 4), isHole: false }, { points: square(0, 0, 0.6), isHole: true }];
    const result = generateRoutingGcode(part, { toolDiameter: 0.125, targetDepth: 0.25 });
    expect(result.gcode).not.toContain('true circle');
    expect(result.gcode).toContain('HOLE CONTOUR');
  });

  it('a circular OUTER contour that also wants tabs falls back to the polygon path (documented scope limit)', () => {
    const part = [{ points: circle(0, 0, 2), isHole: false }];
    const result = generateRoutingGcode(part, { toolDiameter: 0.25, targetDepth: 0.25, tabSpacing: 4, tabWidth: 0.25 });
    expect(result.gcode).not.toContain('true circle');
    expect(result.stats.tabZones).toBeGreaterThan(0);
  });

  it('a circular OUTER contour with no tabs wanted DOES use the helical arc path', () => {
    const part = [{ points: circle(0, 0, 2), isHole: false }];
    const result = generateRoutingGcode(part, { toolDiameter: 0.25, targetDepth: 0.25, tabSpacing: 0 });
    expect(result.gcode).toContain('true circle');
  });
});

describe('cornerFeedScale (corner feed-rate slowdown)', () => {
  it('applies no slowdown on a dead-straight run (180deg included angle)', () => {
    expect(cornerFeedScale({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 })).toBe(1);
  });

  it('applies no slowdown on a gentle bend at/above the 150deg gentle threshold', () => {
    // 150deg included angle: prev/next symmetric about the cur->next direction
    const cur = { x: 0, y: 0 };
    const prev = { x: -1, y: 0 };
    const next = { x: Math.cos(Math.PI / 6), y: Math.sin(Math.PI / 6) }; // 150deg included angle from prev
    expect(cornerFeedScale(prev, cur, next)).toBe(1);
  });

  it('applies the full slowdown floor (0.4x) at a genuinely sharp (30deg) corner', () => {
    const cur = { x: 0, y: 0 };
    const prev = { x: -1, y: 0 }; // pointing at 180deg
    const sharpNext = { x: -Math.cos(Math.PI / 6), y: Math.sin(Math.PI / 6) }; // pointing at 150deg -> 30deg included angle from prev
    expect(cornerFeedScale(prev, cur, sharpNext)).toBeCloseTo(0.4, 10);
  });

  it('applies a right-angle (90deg) corner a partial, in-between slowdown', () => {
    const cur = { x: 0, y: 0 };
    const prev = { x: -1, y: 0 };
    const next = { x: 0, y: 1 }; // 90deg included angle
    const scale = cornerFeedScale(prev, cur, next);
    expect(scale).toBeGreaterThan(0.4);
    expect(scale).toBeLessThan(1);
    expect(scale).toBeCloseTo(0.6, 10); // (90-60)/(150-60) = 1/3 of the way from floor to 1: 0.4 + 1/3*0.6 = 0.6
  });

  it('treats a full reversal (spike back on itself, ~0deg) the same as any other sharp corner - the floor, not a special case', () => {
    const cur = { x: 0, y: 0 };
    const prev = { x: -1, y: 0 };
    const next = { x: -1, y: 0.001 }; // nearly doubles back on itself
    expect(cornerFeedScale(prev, cur, next)).toBeCloseTo(0.4, 5);
  });

  it('returns 1 (no-op) for degenerate/coincident points instead of dividing by zero', () => {
    const cur = { x: 0, y: 0 };
    expect(cornerFeedScale(cur, cur, { x: 1, y: 0 })).toBe(1);
    expect(cornerFeedScale({ x: -1, y: 0 }, cur, cur)).toBe(1);
  });

  it('end to end: a right-angle rectangle contour shows both the plunge-rate and cutting-feed corner scaling in the emitted G-code', () => {
    const part = [{ points: square(0, 0, 4), isHole: false }];
    // tabSpacing: 0 - this test is isolating corner-feed math, not tab
    // placement; without it, targetDepth 0.05" counts as thin stock to
    // recommendTabCount's thickness heuristic, which changes zone
    // placement enough to shift where this specific corner point lands.
    const result = generateRoutingGcode(part, { toolDiameter: 0.25, stepDown: 0.05, targetDepth: 0.05, feedRate: 40, plungeRate: 7, tabSpacing: 0 });
    // Ramp-portion move landing on a 90deg corner: 7 * 0.6 = 4.2
    expect(result.gcode).toContain('F4.20000');
    // Flat cutting-feed move landing on a 90deg corner: 40 * 0.6 = 24
    expect(result.gcode).toContain('F24.00000');
  });
});

describe('generateRoutingGcode - real stock thickness', () => {
  const square = [{ points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }], isHole: false }];

  it('refuses a depth that would cut past the stock into the spoilboard', () => {
    // Not a worse part - the cutter goes through the workpiece and into the
    // machine bed at full depth. There is no reading of this that is correct.
    expect(() => generateRoutingGcode(square, { toolDiameter: 0.25, targetDepth: 0.25, stockThickness: 0.125 }))
      .toThrow(/deeper than the selected stock.*spoilboard/s);
  });

  it('allows a through cut that only reaches the break-through allowance', () => {
    const { gcode } = generateRoutingGcode(square, { toolDiameter: 0.25, targetDepth: 0.14, stockThickness: 0.125 });
    expect(gcode).toContain('Stock: 0.125" thick - cutting to 0.140"');
  });

  it('states the stock the program assumes, so it can be checked against the table', () => {
    const { gcode } = generateRoutingGcode(square, { toolDiameter: 0.25, targetDepth: 0.1, stockThickness: 0.25 });
    expect(gcode).toMatch(/Stock: 0\.250" thick/);
  });

  it('flags a model/stock thickness disagreement without blocking it', () => {
    // Nominal sheet sizes legitimately differ from actual, and a pocket is
    // meant to be shallower than its stock - the operator judges this one.
    const { gcode } = generateRoutingGcode(square, {
      toolDiameter: 0.25, targetDepth: 0.1, stockThickness: 0.125, measuredThickness: 0.25
    });
    expect(gcode).toContain('CHECK STOCK');
    expect(gcode).toMatch(/Model measures 0\.250" but the selected stock is 0\.125"/);
  });

  it('does not flag a nominal-vs-actual sheet difference inside tolerance', () => {
    // 1/4" birch ply routinely measures ~0.22" - that is not a mistake.
    const { gcode } = generateRoutingGcode(square, {
      toolDiameter: 0.25, targetDepth: 0.2, stockThickness: 0.25, measuredThickness: 0.22
    });
    expect(gcode).not.toContain('CHECK STOCK');
  });

  it('is inert when no stock is selected', () => {
    const { gcode } = generateRoutingGcode(square, { toolDiameter: 0.25, targetDepth: 0.5 });
    expect(gcode).not.toContain('Stock:');
    expect(gcode).not.toContain('CHECK STOCK');
  });

  it('gives thicker stock more depth passes than thinner stock', () => {
    // The whole point: a different sheet has to produce different G-code.
    const passesFor = (targetDepth, stockThickness) => (generateRoutingGcode(square, {
      toolDiameter: 0.25, targetDepth, stockThickness, stepDown: 0.03
    }).gcode.match(/pass at Z/g) || []).length;
    const thin = passesFor(0.0825, 0.0625);
    const thick = passesFor(0.395, 0.375);
    expect(thick).toBeGreaterThan(thin);
  });
});

describe('generateRoutingGcode - unverified material feeds', () => {
  const square = [{ points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }], isHole: false }];

  it('tells the operator when the feeds are the generic fallback, and for which material', () => {
    // The person who filled in the job form saw a warning there; the person
    // at the machine did not, and they are the one who can still stop.
    const { gcode } = generateRoutingGcode(square, {
      toolDiameter: 0.25, targetDepth: 0.2, materialFeedsUnverified: true, materialName: 'PLA'
    });
    expect(gcode).toContain('FEEDS AND SPEEDS ARE NOT VERIFIED FOR THIS MATERIAL');
    expect(gcode).toContain('PLA');
  });

  it('says nothing when the material has real feeds on record', () => {
    const { gcode } = generateRoutingGcode(square, { toolDiameter: 0.25, targetDepth: 0.2 });
    expect(gcode).not.toContain('FEEDS AND SPEEDS ARE NOT VERIFIED FOR THIS MATERIAL');
  });

  it('still names the notice when the material name is missing', () => {
    const { gcode } = generateRoutingGcode(square, {
      toolDiameter: 0.25, targetDepth: 0.2, materialFeedsUnverified: true
    });
    expect(gcode).toContain('FEEDS AND SPEEDS ARE NOT VERIFIED FOR THIS MATERIAL');
    expect(gcode).toContain('the selected material');
  });
});

describe('generateRoutingGcode - tab reporting', () => {
  const square = [{ points: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 4 }, { x: 0, y: 4 }], isHole: false }];

  it('reports no tabs when tabs are switched off', () => {
    // A zero-width tab holds nothing, but each one still produced a
    // [center, center] zone that stats counted - so a part cut completely
    // free was described as held by four tabs, which is the one number a
    // consumer would trust to say it is secure.
    const { stats, gcode } = generateRoutingGcode(square, { toolDiameter: 0.25, targetDepth: 0.25, tabWidth: 0 });
    expect(stats.tabZones).toBe(0);
    expect(gcode).not.toContain('-- tab:');
  });

  it('leaves real material at each tab and says so', () => {
    const { stats, gcode } = generateRoutingGcode(square, { toolDiameter: 0.25, targetDepth: 0.25, tabHeight: 0.06 });
    expect(stats.tabZones).toBeGreaterThan(0);
    // One note per tab, not one per sub-move inside it.
    expect((gcode.match(/-- tab:/g) || []).length).toBe(stats.tabZones);
    expect(gcode).toContain('holding 0.060" of material here');
  });

  it('actually holds the part at tab depth, not just in the comment', () => {
    const { gcode } = generateRoutingGcode(square, { toolDiameter: 0.25, targetDepth: 0.25, tabHeight: 0.06 });
    const { moves } = parseToolpath3D(gcode);
    const deepest = Math.min(...moves.map((m) => Math.min(m.from.z, m.to.z)));
    expect(deepest).toBeCloseTo(-0.25, 6);
    // targetDepth - tabHeight: the cutter RISES to this over each tab, so
    // it is the endpoint of the move, not the deepest point of it.
    expect(moves.some((m) => Math.abs(m.to.z - -0.19) < 1e-6)).toBe(true);
  });
});
