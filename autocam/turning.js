/**
 * Turning G-code generator - lathe roughing + finishing passes from a 2D
 * XZ profile. Targets a real Haas TL-1 (Fanuc-dialect lathe control):
 * diameter-mode X, G96/G97 constant surface speed, G95 feed-per-rev, G54
 * work offset, T0101-style T-word tool change - all standard Haas lathe
 * conventions, confirmed against Haas's own lathe programming
 * documentation, not just a generic Fanuc guess.
 *
 * UNITS MATTER FOR G96: this generator always runs in G20 (inch) mode -
 * there is no UI path that ever sets units='mm' for a turning job. On a
 * real Haas lathe, the G96 S-word's units follow whichever of G20/G21 is
 * active: in G20 (this generator's only mode in practice), S is SURFACE
 * FEET PER MINUTE (SFM), not m/min. surfaceSpeed below and the "Surface
 * speed" field in CamParamFields.svelte are SFM for that reason - do not
 * treat the default (150) as metric.
 *
 * NOT verified against real hardware or a simulator. Every generated file
 * carries a header warning to that effect - see HEADER_WARNING below.
 *
 * Roughing strategy: explicit step-down passes, each one tracing the entire
 * profile shape clamped to that pass's radius (an offset copy of the finish
 * profile, progressively closer to size), rather than a canned G71 cycle or
 * a single per-pass Z target. Tracing the whole profile every pass is what
 * makes this correct for any profile shape - an earlier version computed a
 * single Z depth per pass by intersecting the profile, which only produced
 * a correct cut for a profile that happened to be a simple monotonic taper
 * starting exactly at Z=0; real STEP-derived profiles aren't guaranteed to
 * look like that. Canned-cycle syntax also varies enough between controls
 * that explicit moves are safer to get right without hardware to test
 * against.
 *
 * NOSE RADIUS COMPENSATION: when cam_tools.nose_radius is set, the finishing
 * pass is offset outward (away from the true part profile, along each
 * segment's local normal) by that radius, so the insert's rounded tip stays
 * tangent to the programmed surface - see offsetTurningProfile below. This
 * is a hand-computed offset path (G01 moves), not G41/G42 cutter
 * compensation - deliberately: G41 vs G42 handedness depends on tool
 * orientation/machine setup in a way that can't be verified from here, and
 * getting it backwards would gouge the part. The hand-computed path uses a
 * mitered join at corners (same technique as routing.js's offsetPolygon),
 * which is safely conservative - a sharp convex corner may keep a hair of
 * extra material - rather than dangerous. Verify tight radii/chamfers in a
 * simulator before cutting.
 *
 * SETUP MODES (params.setupMode, default 'single' - completely unchanged
 * behavior from before this option existed):
 *   'single'    - one continuous cut, cantilevered from the chuck the whole
 *                 way. Fine for parts that are short/stout enough relative
 *                 to their length not to deflect.
 *   'tailstock' - identical G-code to 'single' - a tailstock center is a
 *                 physical support, not a toolpath change - but adds a loud
 *                 header note reminding the operator to bring it up before
 *                 starting, since this mode exists specifically for parts
 *                 too long/thin to safely cantilever unsupported.
 *   'flip'      - genuinely different: splits the part at params.flipAt
 *                 (inches from the face) into two setups, chucked from
 *                 opposite ends, with a real program pause (M00) between
 *                 them for the operator to physically flip the stock,
 *                 re-chuck gripping the just-finished section, and re-zero
 *                 Z0 at the new face. See generateFlipTurningGcode below.
 */

export const HEADER_WARNING = [
  '(===================================================================)',
  '(  AUTOCAM-GENERATED G-CODE - NOT VERIFIED ON REAL HARDWARE OR A   )',
  '(  SIMULATOR. Run this through a G-code simulator (e.g. ncviewer.com,)',
  '(  CAMotics) and do a supervised air-cut before running on material. )',
  '(===================================================================)'
];

function fmt(n, decimals = 4) {
  return Number(n).toFixed(decimals);
}

function requireFiniteNumber(value, name, { positive = false, nonNegative = false, integer = false } = {}) {
  if (!Number.isFinite(value) || (positive && value <= 0) || (nonNegative && value < 0) || (integer && !Number.isInteger(value))) {
    const constraint = integer ? 'a positive integer' : positive ? '> 0' : nonNegative ? '>= 0' : 'finite';
    throw new Error(`${name} must be ${constraint}`);
  }
}

// Length-to-diameter ratio above which an unsupported (no tailstock/steady
// rest) cantilevered cut is a real deflection/whip/chatter risk, checked
// against the part's SMALLEST working diameter (the most vulnerable point
// along the profile - a shaft that necks down partway through is only as
// rigid as its thinnest section, not its average). 8:1 is a conservative
// shop-floor rule of thumb, not this generator's own invention - real bug
// this guards against: setupMode defaults to 'single' with zero automatic
// detection of "this part probably needs support," found on a real fixture
// (lead-screw.step: ~15" long, necking down to ~0.34" diameter, an
// unsupported ratio over 40:1) that generated a full cantilevered program
// with no warning at all. This doesn't block generation or silently switch
// setupMode - the operator may have a good reason (rigid material, light
// cuts) - it just makes the risk impossible to miss in the header, the same
// way 'tailstock' mode's own note already does for a part built that way on
// purpose.
const UNSUPPORTED_LENGTH_TO_DIAMETER_WARNING_RATIO = 8;

function warnIfUnsupportedLengthToDiameter(lines, profile) {
  const length = Math.abs(profile[profile.length - 1].z - profile[0].z);
  const minDiameter = Math.min(...profile.map((p) => p.x)) * 2;
  if (minDiameter <= 0) return; // degenerate profile (touches the centerline) - not this check's problem to diagnose
  const ratio = length / minDiameter;
  if (ratio < UNSUPPORTED_LENGTH_TO_DIAMETER_WARNING_RATIO) return;
  lines.push('(*** WARNING: LONG/THIN PART, UNSUPPORTED - CONSIDER TAILSTOCK OR FLIP SETUP ***)');
  lines.push(`(This part is ${fmt(length, 3)}" long and necks down to ${fmt(minDiameter, 3)}" diameter - an unsupported)`);
  lines.push(`(length-to-diameter ratio of ${fmt(ratio, 1)}:1, cantilevered from the chuck alone (setupMode: 'single').)`);
  lines.push('(Real risk of deflection, chatter, or the part whipping/bending during the cut.)');
  lines.push("(Consider setupMode: 'tailstock' (adds a supporting live center) or 'flip' (splits)");
  lines.push('(into two shorter, re-chucked setups) instead, if this was not a deliberate choice.)');
}

// Line-line intersection of two infinite lines in the Z-X plane, each
// defined by a point + direction [dz, dx]. Mirrors routing.js's
// intersectLines (kept local/duplicated rather than shared - different
// point shape, {z,x} vs {x,y} - not worth a cross-file abstraction for one
// tiny function).
function intersectLinesZX(p1, d1, p2, d2) {
  const denom = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(denom) < 1e-9) return null; // parallel
  const t = ((p2.z - p1.z) * d2[1] - (p2.x - p1.x) * d2[0]) / denom;
  return { z: p1.z + d1[0] * t, x: p1.x + d1[1] * t };
}

/**
 * Offsets an open Z-X turning profile outward by `distance` (a tool nose
 * radius) - the open-polyline analog of routing.js's offsetPolygon (same
 * edge-normal + mitered-join approach, same MAX_MITER spike clamp), adapted
 * for a path with two free ends instead of a closed loop.
 *
 * For a segment with normalized tangent (dz,dx) (walking face-to-chuck along
 * the profile, in that segment's direction of travel), the outward normal -
 * away from the solid part, the direction the tool's rounded tip needs to
 * sit at to stay tangent to the true surface - is (dx,-dz). Verified against
 * a pure-OD segment (dz=-1,dx=0 -> N=(0,1): +X, away from the axis - grows
 * the radius, correct) and a pure-facing segment (dz=0,dx=1 -> N=(1,0): +Z,
 * away from the chuck - correct).
 *
 * Interior points take the mitered intersection of their two adjacent
 * offset edges (falling back to the midpoint if the spike would exceed
 * MAX_MITER, exactly as offsetPolygon does); the two path endpoints just
 * take their single adjacent edge's offset, applied to that endpoint itself
 * (not the edge's other end), since there's no second edge to miter
 * against. Radius is clamped at 0 - a negative programmed radius would be
 * physically nonsensical (crossing the spindle centerline).
 */
export function offsetTurningProfile(profile, distance) {
  if (!distance) return profile;
  const n = profile.length;
  if (n < 2) return profile;

  const edges = [];
  for (let i = 0; i < n - 1; i += 1) {
    const a = profile[i], b = profile[i + 1];
    const len = Math.hypot(b.z - a.z, b.x - a.x) || 1;
    const dz = (b.z - a.z) / len, dx = (b.x - a.x) / len;
    const nz = dx, nx = -dz; // outward normal, see doc comment above
    edges.push({ nz, nx, dir: [dz, dx], a: { z: a.z + nz * distance, x: a.x + nx * distance } });
  }

  const MAX_MITER = Math.abs(distance) * 8;
  const offset = [];
  for (let i = 0; i < n; i += 1) {
    const prev = i > 0 ? edges[i - 1] : null;
    const cur = i < n - 1 ? edges[i] : null;
    let candidate;
    if (prev && cur) {
      const hit = intersectLinesZX(prev.a, prev.dir, cur.a, cur.dir);
      const fallback = { z: (prev.a.z + cur.a.z) / 2, x: (prev.a.x + cur.a.x) / 2 };
      candidate = hit || fallback;
      const dFromOriginal = Math.hypot(candidate.z - profile[i].z, candidate.x - profile[i].x);
      if (dFromOriginal > MAX_MITER) candidate = fallback;
    } else if (cur) {
      candidate = cur.a; // first point: offset of this segment's own start
    } else {
      candidate = { z: profile[i].z + prev.nz * distance, x: profile[i].x + prev.nx * distance }; // last point: offset of this segment's own end
    }
    offset.push({ z: candidate.z, x: Math.max(0, candidate.x) });
  }
  return offset;
}

/**
 * Appends roughing passes + a finishing pass for one already Z-normalized
 * profile (Z=0 at its own face, increasingly negative toward its own far
 * end) to `lines`. This is the exact body every setup mode shares - pulled
 * out unchanged from the single-setup path that already existed, so
 * 'single' mode's output is untouched by anything below, and 'flip' mode
 * can call it twice (once per chucking) without duplicating the logic.
 *
 * MULTI-TOOL: pass `finishTool` ({ toolNumber, label, noseRadius }) to cut
 * roughing with the tool already loaded (the outer T-word emitted by the
 * caller before this function runs, understood as "the rough tool" once
 * finishTool is set) and finishing with a separate insert. By default this
 * is a real M00 program pause between them, same no-tool-setter/
 * re-touch-off-Z0 assumption routing.js's tool changes make. Pass
 * `automaticToolChanger: true` (from the machine profile - our real 971
 * Lathe is a Haas TL-1 with a turret tool changer and bar/chip mover) to
 * skip the pause: the T-word alone indexes tool + offset unattended, so no
 * human re-touch-off is needed. Omit finishTool (default) for the original
 * single-tool behavior, completely unchanged either way.
 *
 * Returns { passCount, toolChanged }.
 */
function appendSetupBody(lines, profile, { stockDiameter, stepDown, finishAllowance, feedRough, feedFinish, noseRadius, finishTool, surfaceSpeed, maxRpm, spindleDwellSeconds, automaticToolChanger }, finalLine = '(back to start clearance)') {
  const safeDiameter = stockDiameter + 0.1;
  const startZ = profile[0].z + 0.1; // 0.1" of clearance in front of this setup's face
  lines.push(`G00 X${fmt(safeDiameter)} Z${fmt(startZ)} (rapid to start clearance)`);

  const minTargetRadius = Math.min(...profile.map((p) => p.x)) + finishAllowance;
  let currentRadius = stockDiameter / 2;
  let passCount = 0;

  lines.push('(--- ROUGHING PASSES ---)');
  while (currentRadius > minTargetRadius) {
    currentRadius = Math.max(currentRadius - stepDown, minTargetRadius);
    passCount += 1;
    if (passCount > 2000) throw new Error('Roughing pass count exceeded safety limit (2000) - check stepDown/profile');

    lines.push(`(-- roughing pass ${passCount}, radius ${fmt(currentRadius)}" --)`);
    lines.push(`G00 X${fmt(currentRadius * 2)} Z${fmt(startZ)}`);
    for (const pt of profile) {
      const cutRadius = Math.min(pt.x, currentRadius);
      lines.push(`G01 X${fmt(cutRadius * 2)} Z${fmt(pt.z)} F${fmt(feedRough, 5)}`);
    }
    lines.push(`G00 X${fmt(safeDiameter)} (retract clear of stock)`);
    lines.push(`G00 Z${fmt(startZ)} (back to start clearance)`);
  }

  let toolChanged = false;
  if (finishTool) {
    toolChanged = true;
    lines.push(`G00 X${fmt(safeDiameter)} (retract clear of stock before tool change)`);
    lines.push(`G00 Z${fmt(startZ)} (back to start clearance)`);
    lines.push('M05 (spindle off for tool change)');
    if (automaticToolChanger) {
      // Haas TL-1 turret: the T-word indexes tool + offset together, so
      // there's no manual re-touch-off step - unlike the no-ATC path below,
      // this is a real unattended tool change, not a request for a human.
      lines.push(
        `(TOOL CHANGE: automatic - load ${finishTool.label || 'finish tool'}${finishTool.toolNumber ? ` - T${finishTool.toolNumber}` : ''})`
      );
      if (finishTool.toolNumber) lines.push(`T0${finishTool.toolNumber}0${finishTool.toolNumber} (finish tool - turret index)`);
      lines.push('G04 P1.0 (allow turret index to complete before resuming motion)');
    } else {
      lines.push(
        `M00 (TOOL CHANGE: load ${finishTool.label || 'finish tool'}${finishTool.toolNumber ? ` - T${finishTool.toolNumber}` : ''}, ` +
        'then RE-TOUCH OFF Z0 before resuming - no automatic tool length compensation assumed)'
      );
      if (finishTool.toolNumber) lines.push(`T0${finishTool.toolNumber}0${finishTool.toolNumber} (finish tool - verify tool/offset number)`);
    }
    lines.push(`G50 S${maxRpm} (clamp max spindle RPM for constant surface speed)`);
    lines.push(`G96 S${surfaceSpeed} M03 (constant surface speed, SFM, spindle back on)`);
    if (spindleDwellSeconds > 0) lines.push(`G04 P${fmt(spindleDwellSeconds, 1)} (wait for spindle to reach speed)`);
    lines.push('G95 (feed per revolution)');
  }

  const effectiveNoseRadius = finishTool && finishTool.noseRadius !== undefined ? finishTool.noseRadius : noseRadius;

  lines.push('(--- FINISHING PASS ---)');
  let finishProfile = profile;
  if (effectiveNoseRadius) {
    finishProfile = offsetTurningProfile(profile, effectiveNoseRadius);
    lines.push(`(Tool nose radius ${fmt(effectiveNoseRadius, 3)}" IS compensated below - path offset outward from)`);
    lines.push('(the true part profile so the rounded insert tip stays tangent to it. Corners use a)');
    lines.push('(mitered join (see offsetTurningProfile in turning.js) - safely conservative, may leave)');
    lines.push('(a hair of extra material at a sharp convex corner. Verify tight radii/chamfers in a)');
    lines.push('(simulator before cutting.)');
  }
  lines.push(`G00 X0.0 Z${fmt(startZ)}`);
  for (const pt of finishProfile) {
    lines.push(`G01 X${fmt(pt.x * 2)} Z${fmt(pt.z)} F${fmt(feedFinish, 5)}`);
  }

  lines.push(`G00 X${fmt(safeDiameter)} (retract clear of stock)`);
  lines.push(`G00 Z${fmt(startZ)} ${finalLine}`);

  return { passCount, toolChanged };
}

// Linear-interpolated radius at an arbitrary Z along an ordered profile -
// used to find the exact cut point at a flip boundary that doesn't happen
// to land exactly on an existing profile vertex.
function radiusAtZ(profile, z) {
  for (let i = 0; i < profile.length - 1; i += 1) {
    const a = profile[i], b = profile[i + 1];
    const lo = Math.min(a.z, b.z), hi = Math.max(a.z, b.z);
    if (z >= lo && z <= hi) {
      if (b.z === a.z) return a.x;
      const t = (z - a.z) / (b.z - a.z);
      return a.x + t * (b.x - a.x);
    }
  }
  // z is outside the profile's range entirely - clamp to the nearest end.
  return z <= profile[profile.length - 1].z ? profile[profile.length - 1].x : profile[0].x;
}

/**
 * @param {Array<{z:number, x:number}>} profile - ordered face-to-chuck points, x = radius
 * @param {Object} params
 *   stockDiameter, stepDown, finishAllowance, feedRough, feedFinish (required, inches/rev)
 *   surfaceSpeed (SFM - surface feet per minute, Haas convention for G96 in G20/inch mode, default 150), maxRpm (default 2500)
 *   noseRadius (inches, optional), toolNumber (default 1), programNumber (default 1000)
 *   units: 'in' | 'mm' (default 'in')
 *   spindleDwellSeconds (default 2) - pause after every M03 (initial start,
 *     every finishTool mid-program restart, and both setups in flip mode)
 *     to let the spindle actually reach commanded RPM before the first
 *     cutting move - see the G04 P line this adds.
 *   setupMode: 'single' | 'tailstock' | 'flip' (default 'single')
 *   flipAt (required if setupMode='flip') - inches from the face where the
 *     part gets re-chucked; minGripLength (default 0.25") - safety floor,
 *     refuses to generate a flip plan that re-grips less material than this
 *   finishTool ({ toolNumber, label, noseRadius }, optional) - MULTI-TOOL:
 *     when set, roughing cuts with `toolNumber` (the rough insert) and the
 *     program pauses for a real tool change (M00, re-touch-off Z0 assumed)
 *     before finishing with this separate tool. finishTool.noseRadius (if
 *     given) is what actually gets nose-radius-compensated on the finishing
 *     pass - the top-level `noseRadius` is ignored once finishTool is set,
 *     since that param described the single tool's nose radius in the
 *     single-tool case. Applies inside each setup independently, so 'flip'
 *     mode with a finishTool does the rough->change->finish sequence twice
 *     (once per physical chucking) - see appendSetupBody.
 */
export function generateTurningGcode(profile, params = {}) {
  if (!Array.isArray(profile) || profile.length < 2) {
    throw new Error('Turning profile needs at least 2 points');
  }
  const {
    stockDiameter,
    stepDown = 0.05,
    finishAllowance = 0.02,
    feedRough = 0.008,
    feedFinish = 0.004,
    surfaceSpeed = 150,
    maxRpm = 2500,
    noseRadius = 0,
    toolNumber = 1,
    programNumber = 1000,
    units = 'in',
    setupMode = 'single',
    finishTool = null,
    spindleDwellSeconds = 2,
    automaticToolChanger = false
  } = params;

  requireFiniteNumber(stockDiameter, 'stockDiameter', { positive: true });
  requireFiniteNumber(stepDown, 'stepDown', { positive: true });
  requireFiniteNumber(finishAllowance, 'finishAllowance', { nonNegative: true });
  requireFiniteNumber(feedRough, 'feedRough', { positive: true });
  requireFiniteNumber(feedFinish, 'feedFinish', { positive: true });
  requireFiniteNumber(surfaceSpeed, 'surfaceSpeed', { positive: true });
  requireFiniteNumber(maxRpm, 'maxRpm', { positive: true });
  requireFiniteNumber(noseRadius, 'noseRadius', { nonNegative: true });
  requireFiniteNumber(toolNumber, 'toolNumber', { positive: true, integer: true });
  requireFiniteNumber(programNumber, 'programNumber', { positive: true, integer: true });
  requireFiniteNumber(spindleDwellSeconds, 'spindleDwellSeconds', { nonNegative: true });
  if (!['single', 'tailstock', 'flip'].includes(setupMode)) {
    throw new Error('setupMode must be one of single, tailstock, or flip');
  }
  if (!['in', 'mm'].includes(units)) throw new Error('units must be in or mm');

  const maxProfileRadius = Math.max(...profile.map((p) => p.x));
  if (stockDiameter / 2 < maxProfileRadius) {
    throw new Error(`Stock radius (${stockDiameter / 2}) is smaller than the profile's max radius (${maxProfileRadius}) - stock too small`);
  }

  // Everything below assumes lathe convention: Z=0 at the face (where the
  // tool starts, at a bit of clearance) and increasingly negative Z toward
  // the chuck. The profile as extracted from the STEP file is in the file's
  // own native coordinates instead (whatever origin the CAD model happened
  // to use), which are not guaranteed to start anywhere near 0 - shift so
  // the profile's first point (whichever end that is) sits at Z=0. Which
  // physical end that actually is (vs. which end goes in the chuck) can't be
  // determined from geometry alone - verify against the real part before
  // cutting.
  const zOrigin = profile[0].z;
  profile = profile.map((p) => ({ x: p.x, z: zOrigin - p.z }));

  if (setupMode === 'flip') {
    return generateFlipTurningGcode(profile, { stockDiameter, stepDown, finishAllowance, feedRough, feedFinish, surfaceSpeed, maxRpm, noseRadius, toolNumber, programNumber, units, finishTool, spindleDwellSeconds, automaticToolChanger, flipAt: params.flipAt, minGripLength: params.minGripLength ?? 0.25 });
  }

  const lines = [...HEADER_WARNING, ''];
  lines.push('%');
  lines.push(`O${programNumber} (AUTOCAM TURNING)`);
  lines.push(units === 'mm' ? 'G21 (metric)' : 'G20 (inch)');
  lines.push('G90 (absolute)');
  lines.push('G54 (work offset - verify before running)');
  lines.push(`T0${toolNumber}0${toolNumber} (tool change - ${finishTool ? 'rough tool - ' : ''}verify tool/offset number)`);
  lines.push(`G50 S${maxRpm} (clamp max spindle RPM for constant surface speed)`);
  lines.push(`G96 S${surfaceSpeed} M03 (constant surface speed, SFM, spindle on)`);
  if (spindleDwellSeconds > 0) lines.push(`G04 P${fmt(spindleDwellSeconds, 1)} (wait for spindle to reach speed)`);
  lines.push('G95 (feed per revolution)');

  if (setupMode === 'tailstock') {
    const length = Math.abs(profile[profile.length - 1].z - profile[0].z);
    lines.push('(*** TAILSTOCK REQUIRED ***)');
    lines.push(`(This part is ${fmt(length, 3)}" long with a max diameter of ${fmt(maxProfileRadius * 2, 3)}" - too long/thin to safely)`);
    lines.push('(cantilever from the chuck alone. Bring up a live center in the tailstock to)');
    lines.push('(support the far end BEFORE starting the cut below.)');
  } else if (setupMode === 'single') {
    warnIfUnsupportedLengthToDiameter(lines, profile);
  }

  const { passCount, toolChanged } = appendSetupBody(
    lines, profile,
    { stockDiameter, stepDown, finishAllowance, feedRough, feedFinish, noseRadius, finishTool, surfaceSpeed, maxRpm, spindleDwellSeconds, automaticToolChanger },
    'M05 (back to start clearance, spindle off)'
  );

  lines.push('M09 (coolant off)');
  lines.push('M30 (program end)');
  lines.push('%');

  return {
    gcode: lines.join('\n'),
    stats: { roughingPasses: passCount, profilePoints: profile.length, maxRadius: maxProfileRadius, setupMode, toolChanges: toolChanged ? 1 : 0 }
  };
}

/**
 * Two-setup ("flip-turning") program: cuts from the face to `flipAt`, pauses
 * for the operator to physically flip the stock and re-chuck gripping the
 * just-finished section, then cuts the remainder from the new face outward.
 *
 * Geometry: a lathe cuts a body of revolution, so a setup's toolpath only
 * depends on radius-as-a-function-of-distance-from-its-own-face - it doesn't
 * matter which way the stock physically points in the room. Setup 2's
 * profile is just the original profile's remainder, re-zeroed so the flip
 * point becomes its own Z=0 (a straight shift, z2 = originalZ + flipAt - no
 * reversal needed, since "distance from this setup's face" already
 * increases in the same direction the original profile array does).
 *
 * `profile` here is already the caller's Z-normalized profile (Z=0 at the
 * original face) - see generateTurningGcode above.
 */
function generateFlipTurningGcode(profile, params) {
  const { stockDiameter, stepDown, finishAllowance, feedRough, feedFinish, surfaceSpeed, maxRpm, noseRadius, toolNumber, programNumber, units, finishTool, spindleDwellSeconds, automaticToolChanger, flipAt, minGripLength } = params;

  if (!flipAt || flipAt <= 0) {
    throw new Error('flipAt (inches from the face, where the part gets re-chucked) is required for setupMode "flip"');
  }
  const totalLength = Math.abs(profile[profile.length - 1].z - profile[0].z);
  if (flipAt >= totalLength) {
    throw new Error(`flipAt (${flipAt}") must be less than the part's total length (${fmt(totalLength, 3)}")`);
  }
  if (flipAt < minGripLength) {
    throw new Error(`flipAt (${flipAt}") re-grips less material than minGripLength (${minGripLength}") - too short to safely re-chuck. Pick a later flip point or lower minGripLength if you've verified it's actually safe for this part/chuck.`);
  }
  const remainingLength = totalLength - flipAt;
  if (remainingLength < minGripLength) {
    throw new Error(`Only ${fmt(remainingLength, 3)}" would remain past the flip point (${flipAt}") - too little material left to safely finish. Pick an earlier flip point.`);
  }

  const flipZ = -flipAt;

  // Setup 1: everything from the face (z=0) to the flip point (z=flipZ),
  // with an interpolated point exactly at the boundary appended.
  const setup1Profile = profile.filter((p) => p.z > flipZ).concat([{ x: radiusAtZ(profile, flipZ), z: flipZ }]);
  if (setup1Profile.length < 2) throw new Error('Flip point leaves too few profile points for setup 1 - pick a different flipAt');

  // Setup 2: everything from the flip point to the far end, re-zeroed so
  // the flip point becomes Z=0 in this setup's own frame (z2 = originalZ -
  // flipZ = originalZ + flipAt). Boundary point included so both setups
  // agree exactly on the diameter at the flip line.
  const setup2Profile = [{ x: radiusAtZ(profile, flipZ), z: flipZ }]
    .concat(profile.filter((p) => p.z < flipZ))
    .map((p) => ({ x: p.x, z: p.z - flipZ }));
  if (setup2Profile.length < 2) throw new Error('Flip point leaves too few profile points for setup 2 - pick a different flipAt');

  const lines = [...HEADER_WARNING, ''];
  lines.push('(*** TWO-SETUP (FLIP-TURNING) PROGRAM ***)');
  lines.push(`(Setup 1 cuts the first ${fmt(flipAt, 3)}" from the face. Setup 2 cuts the remaining)`);
  lines.push(`(${fmt(remainingLength, 3)}" after a manual re-chuck - see the pause partway through.)`);
  lines.push('%');
  lines.push(`O${programNumber} (AUTOCAM TURNING - FLIP SETUP 1 OF 2)`);
  lines.push(units === 'mm' ? 'G21 (metric)' : 'G20 (inch)');
  lines.push('G90 (absolute)');
  lines.push('G54 (work offset - verify before running)');
  lines.push(`T0${toolNumber}0${toolNumber} (tool change - ${finishTool ? 'rough tool - ' : ''}verify tool/offset number)`);
  lines.push(`G50 S${maxRpm} (clamp max spindle RPM for constant surface speed)`);
  lines.push(`G96 S${surfaceSpeed} M03 (constant surface speed, SFM, spindle on)`);
  if (spindleDwellSeconds > 0) lines.push(`G04 P${fmt(spindleDwellSeconds, 1)} (wait for spindle to reach speed)`);
  lines.push('G95 (feed per revolution)');

  const bodyParams = { stockDiameter, stepDown, finishAllowance, feedRough, feedFinish, noseRadius, finishTool, surfaceSpeed, maxRpm, spindleDwellSeconds, automaticToolChanger };
  const { passCount: pass1, toolChanged: toolChanged1 } = appendSetupBody(lines, setup1Profile, bodyParams);

  lines.push('M05 (spindle off)');
  lines.push('M09 (coolant off)');
  lines.push('(*** RE-CHUCK REQUIRED - SETUP 2 OF 2 ***)');
  lines.push(`(1. Remove the part from the chuck.)`);
  lines.push('(2. Flip the part end-for-end.)');
  lines.push(`(3. Re-chuck, gripping the just-finished ${fmt(flipAt, 3)}" section - verify a secure, safe grip)`);
  lines.push('(   before proceeding. A partially-turned section may grip differently than raw stock.)');
  lines.push('(4. Re-zero the work offset (G54) so Z0 is at the NEW face - the flip line above.)');
  lines.push('(5. Only then press cycle start to resume.)');
  lines.push('M00 (program pause - do not resume until steps 1-4 above are complete)');
  lines.push('G54 (work offset - re-verify after re-chuck)');
  lines.push(`T0${toolNumber}0${toolNumber} (tool change - ${finishTool ? 'rough tool - ' : ''}verify tool/offset number)`);
  lines.push(`G50 S${maxRpm} (clamp max spindle RPM for constant surface speed)`);
  lines.push(`G96 S${surfaceSpeed} M03 (constant surface speed, SFM, spindle back on)`);
  if (spindleDwellSeconds > 0) lines.push(`G04 P${fmt(spindleDwellSeconds, 1)} (wait for spindle to reach speed)`);
  lines.push('G95 (feed per revolution)');

  const { passCount: pass2, toolChanged: toolChanged2 } = appendSetupBody(lines, setup2Profile, bodyParams, 'M05 (back to start clearance, spindle off)');

  lines.push('M09 (coolant off)');
  lines.push('M30 (program end)');
  lines.push('%');

  const maxProfileRadius = Math.max(...profile.map((p) => p.x));
  return {
    gcode: lines.join('\n'),
    stats: {
      roughingPasses: pass1 + pass2,
      profilePoints: profile.length,
      maxRadius: maxProfileRadius,
      setupMode: 'flip',
      flipAt,
      setup1Length: flipAt,
      setup2Length: remainingLength,
      toolChanges: (toolChanged1 ? 1 : 0) + (toolChanged2 ? 1 : 0)
    }
  };
}
