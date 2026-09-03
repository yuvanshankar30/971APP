/**
 * Tube stock G-code generator - indexed drilling for rectangular/square
 * tube (round holes only, straight through one wall at a time - see
 * extractTubeFeaturesFromMeshes in stepProfile.js for the geometry this
 * consumes: { walls: [{ angleDeg, holes: [{ position, lateralOffset,
 * diameter }, ...] }, ...] }).
 *
 * Targets a standard 3-axis CNC router - NOT a rotary/4th-axis machine.
 * There is no A axis: each face's holes get their own separately-runnable
 * program (see facePrograms below), and the operator manually flips the
 * tube stock over and re-zeros Z between faces, the same way an existing
 * router gets tube-stock capability without needing a dedicated tube
 * notcher or an added rotary axis. UNLIKE turning.js (a real Haas TL-1)
 * and routing.js (a real ShopSabre Pro 408), there is no specific real
 * machine this has been confirmed against - no such machine exists yet in
 * this app's cam_machines data. The axis convention here - X = along tube
 * length, Z = spindle plunge, Y = the hole's lateralOffset (signed
 * distance from the currently-loaded wall's own centerline, assuming the
 * tube's centerline sits on the spindle's Y=0 line once fixtured for that
 * face) - is a reasonable, common setup, not a verified one. Y matters,
 * not just a convenience default: a real AndyMark 2"x1" predrilled tube
 * fixture (am-5180) has multiple holes at the same length position but
 * different lateral offsets on its wide face - a real side-by-side hole
 * pair, not a duplicate; drilling all of them at Y0 would redrill one spot
 * instead of the real holes. CONFIRM the fixture's centerline offset and
 * Z=0 reference for each face before running on material.
 *
 * Reuses routing.js's linuxcnc/wincnc dialect conventions (comments,
 * spindle codes, tool-change pause) since this targets the same class of
 * machine (a router with an add-on axis), not the lathe - see routing.js's
 * own file header for the real, manual-confirmed differences between the
 * two dialects this switches between.
 */
import { HEADER_WARNING } from './turning.js';
import { normalizeGcodeComments } from './gcodeComments.js';
import { offsetPolygon } from './routing.js';
import { tubeCutoffPath, tubeCutoffPosition } from './tubeCutoff.js';

function fmt(n, decimals = 4) {
  return Number(n).toFixed(decimals);
}

function pauseLine(isWinCNC, promptText) {
  return isWinCNC ? `G4 (${promptText})` : `M00 (${promptText})`;
}

function dwellLine(isWinCNC, seconds, comment) {
  const word = isWinCNC ? 'X' : 'P';
  return `G04 ${word}${fmt(seconds, 1)} (${comment})`;
}

/** Normalize rotary angles so 0, 360, and -360 identify the same tube face. */
/**
 * How far past the wall's inner surface a hole is driven, so it actually
 * breaks through. Same figure and same reasoning as routing.js's
 * THROUGH_CUT_ALLOWANCE: enough to guarantee the hole clears the wall and to
 * absorb a tube that is not perfectly straight, without driving the cutter
 * deep into the cavity behind it.
 */
export const WALL_BREAKTHROUGH_ALLOWANCE = 0.02;

/**
 * Hole depth for a tube, derived from the stock rather than typed per job.
 *
 * Wall thickness is a property of the tube, not of the part: every hole in a
 * given tube passes through the same wall, so there is exactly one correct
 * depth per stock and nothing for an operator to decide. It used to be a
 * free number field, which meant a job could be queued with a depth that did
 * not match the tube actually loaded.
 *
 * @param {number} wallThickness inches, from the stock catalog entry
 * @returns {number|null} depth in inches, or null when the stock has no
 *   usable wall thickness recorded
 */
export function holeDepthForWall(wallThickness) {
  const wall = Number(wallThickness);
  if (!Number.isFinite(wall) || wall <= 0) return null;
  return Number((wall + WALL_BREAKTHROUGH_ALLOWANCE).toFixed(4));
}

/**
 * Only one wall ever gets a cutoff, never all four. This machine has no
 * rotary axis and reaches one wall per fixture setup, so the router can
 * never cut all the way around a tube's cross-section - the cutoff is a
 * single-wall reference cut the operator then finishes by hand with a
 * horizontal bandsaw, using the cut's two straight edges to align the
 * blade across the whole tube. One wall's reference is enough for that; a
 * second one would be redundant, not safer.
 *
 * WHICH wall is the physical face opposite the fixture's registration pin
 * - a fact about how this specific tube got loaded into the jaws, which
 * the STEP model has no way to know. angleDeg 0 (this app's own "Side 12")
 * is just whichever wall the extractor's own axis convention happens to
 * detect first; it carries no relationship to the fixture at all. Used to
 * be hardcoded to "the wall opposite Side 12" here, which was wrong - it
 * assumed a CAD-modeling convention that was never actually established.
 * See buildCutoffFeature: the operator states which face is against the
 * pin (params.fixturePinFace), and the cutoff goes on whichever wall is
 * opposite THAT.
 */
const CLOCK_TO_ANGLE_DEG = { 12: 0, 3: 90, 6: 180, 9: 270 };
const OPPOSITE_CLOCK = { 12: 6, 3: 9, 6: 12, 9: 3 };

/**
 * The cutoff obround's dimensions. Picked for what an operator does with it
 * afterward, not for any single existing job: a horizontal bandsaw needs a
 * clear straight run to track, and whatever is left of the semicircular
 * ends on each finished piece has to sand flush by hand. A narrow width
 * keeps that remnant small; a modest overall length gives the saw blade a
 * real straight edge to follow rather than a single point.
 */
export const DEFAULT_CUTOFF_WIDTH = 0.25;
export const DEFAULT_CUTOFF_LENGTH = 0.75;

/**
 * A typical metal-cutting horizontal bandsaw blade's kerf. The cutoff line
 * sits half a kerf past the finished length so the saw - which removes
 * material as it cuts - doesn't leave the finished piece short.
 */
export const DEFAULT_BANDSAW_KERF = 0.035;

export function normalizeTubestockFaceAngle(angleDeg) {
  const normalized = ((Number(angleDeg) || 0) % 360 + 360) % 360;
  return Number(normalized.toFixed(4));
}

/** Human-readable face name for standard rectangular tube orientations. */
/**
 * Which clock position a wall sits at, as the shop labels tube faces.
 *
 * The router manual numbers tube sides 3, 6, 9 and 12 going clockwise, and
 * the tube stock checklist has the operator write those numbers on the tube
 * itself - "All sides of the tube are labeled 3, 6, 9, 12 according to the
 * files". So the files have to use the same numbers, or the operator is
 * translating between two schemes while standing at the machine with a tube
 * clamped in the fixture.
 *
 * 12 is up, and the angles run the same way round as the clock does.
 *
 * @returns {number|null} 12, 3, 6 or 9, or null for a wall that is not on a
 *   cardinal face (a rectangular tube has no such wall, so this only guards
 *   against malformed input rather than describing a real case)
 */
export function tubestockFaceClock(angleDeg) {
  const angle = normalizeTubestockFaceAngle(angleDeg);
  const clockByAngle = { 0: 12, 90: 3, 180: 6, 270: 9 };
  return clockByAngle[angle] ?? null;
}

export function tubestockFaceLabel(angleDeg) {
  const clock = tubestockFaceClock(angleDeg);
  if (clock === null) return `Face A${normalizeTubestockFaceAngle(angleDeg)}`;
  return `Side ${clock}`;
}

/** Name a separately-runnable program for one rotary-indexed tube face. */
export function tubestockFaceFileName(gcodeFileName, angleDeg) {
  const source = String(gcodeFileName || 'tube-stock.ngc');
  const extensionMatch = source.match(/(\.[a-z0-9]+)$/i);
  const extension = extensionMatch?.[1] || '.ngc';
  const base = extensionMatch ? source.slice(0, -extension.length) : source;
  // Named for the clock position the operator writes on the tube, so the
  // file they pick and the face in front of them carry the same number.
  const clock = tubestockFaceClock(angleDeg);
  if (clock === null) {
    const angle = String(normalizeTubestockFaceAngle(angleDeg)).replace(/\./g, '_');
    return `${base}-face-a${angle}${extension}`;
  }
  return `${base}-side-${clock}${extension}`;
}

/**
 * Builds the cutoff toolpath from job params, or returns null when no
 * cutoff was asked for.
 *
 * finishedLength does not come from the STEP model. The physical stock
 * loaded on the machine is whatever length that piece of extrusion happens
 * to be cut to, which the CAD model has no way to know and routinely
 * disagrees with - the model represents the finished part, not the raw
 * stock. So this is deliberately an operator-entered value, the same
 * "state a real number, not get a guessed default" posture holeDepth used
 * to have before it became derivable from the stock catalog - except this
 * one never becomes derivable, because nothing in this app's data models
 * the physical length of the specific piece of tube sitting in the
 * fixture right now.
 *
 * fixturePinFace is the same kind of fact, for the same reason: which
 * physical wall sits against the fixture's registration pin depends on how
 * THIS tube got loaded, which the STEP model cannot know either. The
 * operator states it (as a clock number - 3, 6, 9 or 12, the same numbers
 * already written on the tube) and the cutoff goes on the wall directly
 * opposite it.
 *
 * @param {Array} walls tubeFeatures.walls
 * @param {Object} params generateTubestockGcode's own params - reads
 *   finishedLength (required to build a feature at all), fixturePinFace
 *   and toolDiameter (both required once finishedLength is given)
 * @returns {{angleDeg: number, position: number, path: Array<{x,y}>}|null}
 */
function buildCutoffFeature(walls, params) {
  const finishedLength = Number(params.finishedLength);
  if (!Number.isFinite(finishedLength) || finishedLength <= 0) return null;

  const pinFace = Number(params.fixturePinFace);
  if (!OPPOSITE_CLOCK[pinFace]) {
    throw new Error(
      'Which face sits against the fixture pin is required for the cutoff line - the STEP model has no way to ' +
      'know how this tube is loaded, so pick Side 3, 6, 9 or 12 and the cutoff will go on the wall opposite it.'
    );
  }
  const cutoffClock = OPPOSITE_CLOCK[pinFace];
  const cutoffAngleDeg = CLOCK_TO_ANGLE_DEG[cutoffClock];

  const wall = walls.find((w) => normalizeTubestockFaceAngle(w.angleDeg) === cutoffAngleDeg);
  if (!wall) {
    throw new Error(
      `The cutoff goes on Side ${cutoffClock} (opposite the fixture pin face, Side ${pinFace}), but this tube has no wall there.`
    );
  }

  // Only needed for this feature - drilling never has to know the tool's
  // diameter, since a plunge doesn't need cutter compensation. A contour
  // cut does: the toolpath has to sit inside the drawn line by one tool
  // radius, or the finished slot comes out wider than asked for.
  const toolDiameter = Number(params.toolDiameter);
  if (!(toolDiameter > 0)) {
    throw new Error('toolDiameter is required to mill the cutoff line - select an end mill for this job.');
  }

  const position = tubeCutoffPosition({ partEnd: finishedLength, kerf: DEFAULT_BANDSAW_KERF });
  const outerPath = tubeCutoffPath({ position, width: DEFAULT_CUTOFF_WIDTH, length: DEFAULT_CUTOFF_LENGTH });
  // offsetPolygon itself refuses a tool too large for the shape ("Feature
  // is too small for this tool") - that check is reused here rather than
  // duplicated, so cutter fit is one rule, not two that could disagree.
  const path = offsetPolygon(outerPath, -toolDiameter / 2);

  return { angleDeg: wall.angleDeg, position, toolDiameter, path };
}

/**
 * Groups every hole across every wall by drill diameter (largest first,
 * matching routing.js's multi-tool convention: primary/most-common tool
 * first, detail tools after), keeping each diameter's holes ordered by
 * wall angle then position - so the program indexes A once per wall per
 * tool rather than bouncing back and forth.
 */
function groupHolesByDiameter(walls) {
  const byDiameter = new Map(); // diameter (rounded) -> [{ angleDeg, position, lateralOffset, diameter }, ...]
  for (const wall of walls) {
    for (const hole of wall.holes) {
      const key = Math.round(hole.diameter * 10000) / 10000;
      if (!byDiameter.has(key)) byDiameter.set(key, []);
      byDiameter.get(key).push({
        angleDeg: wall.angleDeg,
        position: hole.position,
        // Wide faces can have more than one hole at the same position but
        // different lateral offsets across the wall's width (a real
        // side-by-side hole pair, not a duplicate) - see
        // extractTubeFeaturesFromMeshes' own comment on lateralOffset.
        // Defaults to 0 for hand-built tubeFeatures that predate this field.
        lateralOffset: hole.lateralOffset ?? 0,
        diameter: hole.diameter
      });
    }
  }
  return [...byDiameter.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([diameter, holes]) => ({
      diameter,
      holes: [...holes].sort((a, b) => (a.angleDeg - b.angleDeg) || (a.position - b.position) || (a.lateralOffset - b.lateralOffset))
    }));
}

function wallsWithHolesByFace(walls, forceIncludeAngleDeg = null) {
  const forced = forceIncludeAngleDeg === null ? null : normalizeTubestockFaceAngle(forceIncludeAngleDeg);
  const faces = new Map();
  for (const wall of walls) {
    const angleDeg = normalizeTubestockFaceAngle(wall.angleDeg);
    // A wall with no holes normally gets no separately-runnable file - there
    // is nothing to drill on it. The cutoff wall is the one exception: it
    // can carry a cutoff line and nothing else, and that still needs its
    // own file.
    if (!wall.holes?.length && angleDeg !== forced) continue;
    if (!faces.has(angleDeg)) faces.set(angleDeg, { holes: [], skippedFeatures: [] });
    const bucket = faces.get(angleDeg);
    bucket.holes.push(...wall.holes);
    bucket.skippedFeatures.push(...(wall.skippedFeatures || []));
  }
  return [...faces.entries()]
    .sort(([a], [b]) => a - b)
    .map(([angleDeg, { holes, skippedFeatures }]) => ({ angleDeg, holes, skippedFeatures }));
}

function generateProgram(walls, params, { faceAngleDeg = null, faceLabel = null, programNumber, cutoffFeature = null }) {
  const {
    holeDepth,
    safeZ = 0.25,
    feedRate = 8,
    spindleSpeed = 8000,
    spindleDwellSeconds = 2,
    controller = 'linuxcnc',
    units = 'in'
  } = params;
  const isWinCNC = controller === 'wincnc';
  const groups = groupHolesByDiameter(walls);
  const totalHoles = walls.reduce((sum, wall) => sum + wall.holes.length, 0);

  const lines = [...HEADER_WARNING, ''];
  // No parentheses in here: this goes inside a comment, and a comment ends
  // at the first ")" - see gcodeComments.js. The clock number is what the
  // operator has written on the tube, so it is what the face is called;
  // stating the angle as well only invites the two to disagree.
  const faceDescription = faceAngleDeg === null
    ? null
    : `${faceLabel || tubestockFaceLabel(faceAngleDeg)} - turn this face up`;
  lines.push(faceDescription === null
    ? '(*** TUBE STOCK: standard 3-axis router, NOT rotary - manual flip between faces ***)'
    : `(** TUBE STOCK ${faceDescription}: standard 3-axis router - fixture this face, verify Z=0, then run **)`);
  lines.push('(Verify the fixture centerline offset and Z=0 reference against the real machine)');
  lines.push('(before running - see tubestock.js file header. Round holes only, each)');
  lines.push('(drilled straight in from whichever wall it is on.)');
  lines.push('%');
  lines.push(`O${programNumber} (AUTOCAM TUBE STOCK${faceDescription === null ? '' : ` ${faceDescription}`})`);
  if (isWinCNC) {
    lines.push(units === 'mm' ? 'G22 (metric - mm; NOTE: G21 means cm on WinCNC, G22 is used for mm here)' : 'G20 (inch)');
  } else {
    lines.push(units === 'mm' ? 'G21 (metric)' : 'G20 (inch)');
  }
  lines.push('G90 (absolute)');
  lines.push('G94 (feed per minute)');
  if (isWinCNC) {
    lines.push('(*** VERIFY MACHINE ZERO BEFORE RUNNING ***)');
    lines.push('(Jog to the tube face/rotary-center origin and zero the controller (G92) BEFORE)');
    lines.push('(running this file - WinCNC has no G54-style stored work offset this program)');
    lines.push('(can select for you; it has to be set interactively, right before.)');
  } else {
    // G55, not G54. The tube stock fixture has its own work offset on this
    // machine: the router manual has the operator type g55 into the MDI
    // "before doing anything else", and repeats it in the tube stock
    // checklist as something to redo for every cut. A file that selects it
    // itself cannot be run in the sheet-setup coordinate system because
    // somebody forgot that step, which would put the whole program in the
    // wrong place on a fixture the tube is clamped into.
    lines.push('G55 (tube stock fixture work offset - the tube fixture lives here, not in G54)');
    lines.push('G80 G40 G49 (cancel canned cycle / cutter comp / tool length offset - defensive, in case a prior program on this machine left one active)');
  }

  lines.push('(--- TOOL PLAN - stage these before starting ---)');
  groups.forEach((group, index) => {
    lines.push(`(  ${index + 1}. ${fmt(group.diameter, 3)}" drill (T${index + 1}) - ${group.holes.length} hole${group.holes.length === 1 ? '' : 's'} )`);
  });
  if (cutoffFeature) {
    lines.push(`(  ${groups.length + 1}. ${fmt(cutoffFeature.toolDiameter, 3)}" end mill - cutoff line, one pass through this wall )`);
  }

  // A feature that wasn't round was skipped rather than drilled - see
  // extractTubeFeaturesFromMeshes' skippedFeatures. Surfaced here, in the
  // program itself, because the person running this file is not
  // necessarily the person who queued it - same reasoning as the
  // materialFeedsUnverified notice elsewhere in this app.
  const skipped = walls.flatMap((wall) => (wall.skippedFeatures || []).map((feature) => ({ ...feature, angleDeg: wall.angleDeg })));
  if (skipped.length > 0) {
    lines.push(`(*** ${skipped.length} feature${skipped.length === 1 ? '' : 's'} on this tube ${skipped.length === 1 ? 'was' : 'were'} not round and NOT machined - check the CAD model before running ***)`);
    for (const feature of skipped) {
      lines.push(`(  SKIPPED: ${tubestockFaceLabel(feature.angleDeg)} near X${fmt(feature.position)} Y${fmt(feature.lateralOffset)}, roughly ${fmt(feature.meanRadius * 2, 2)}" across )`);
    }
  }

  let toolChanges = 0;
  groups.forEach((group, toolIndex) => {
    if (toolIndex === 0) {
      lines.push(`(--- TOOL 1: ${fmt(group.diameter, 3)}" drill (T1) - load before starting ---)`);
      lines.push(`S${spindleSpeed} M03 (spindle on)`);
      if (spindleDwellSeconds > 0) lines.push(dwellLine(isWinCNC, spindleDwellSeconds, 'wait for spindle to reach speed'));
    } else {
      toolChanges += 1;
      lines.push('G00 Z' + fmt(safeZ) + ' (retract clear before tool change)');
      lines.push('M05 (spindle off)');
      lines.push(pauseLine(isWinCNC, `TOOL CHANGE: load ${fmt(group.diameter, 3)}" drill - T${toolIndex + 1}, then RE-TOUCH OFF Z0 before resuming - no automatic tool length compensation assumed`));
      lines.push(`S${spindleSpeed} M03 (spindle back on)`);
      if (spindleDwellSeconds > 0) lines.push(dwellLine(isWinCNC, spindleDwellSeconds, 'wait for spindle to reach speed'));
    }

    let currentAngle = null;
    for (const hole of group.holes) {
      if (hole.angleDeg !== currentAngle) {
        // No rotary axis on this machine - a face change is a manual
        // re-fixture, not a G-code move. Only the combined all-faces
        // program (faceAngleDeg === null) can span more than one face
        // within a single run, so only it needs to stop and prompt for
        // one; a per-face program (see facePrograms below) only ever
        // covers a single already-fixtured face and drills straight
        // through with no pause here.
        if (faceAngleDeg === null) {
          lines.push(`G00 Z${fmt(safeZ)} (retract clear before flipping tube)`);
          // (FACE A...) is a comment tag, not a live G-code word - there is
          // no rotary axis on this machine, so nothing here commands motion.
          // It exists only so the 3D toolpath preview (toolpathPreview.js's
          // parseToolpath3D, which reads this combined multi-face program -
          // see gcode={job.gcode} in ToolpathSimulator's callers) can still
          // tell which physical face each subsequent move belongs to.
          lines.push(`(FACE A${fmt(hole.angleDeg, 1)} - FLIP TUBE so ${tubestockFaceLabel(hole.angleDeg)} faces up, then RE-ZERO Z before resuming - the operator turns the tube by hand, there is no rotary axis on this machine)`);
          lines.push(pauseLine(isWinCNC, `FLIP TUBE to ${tubestockFaceLabel(hole.angleDeg)} face (${fmt(hole.angleDeg, 1)} deg from Top) and RE-ZERO Z before resuming - no rotary axis on this machine`));
        }
        currentAngle = hole.angleDeg;
      }
      lines.push(`G00 X${fmt(hole.position)} Y${fmt(hole.lateralOffset)} (rapid to hole position)`);
      lines.push(`G00 Z${fmt(safeZ)} (rapid to clearance above wall)`);
      lines.push(`G01 Z${fmt(-holeDepth)} F${fmt(feedRate, 2)} (drill)`);
      lines.push(`G00 Z${fmt(safeZ)} (retract)`);
    }
  });

  // The cutoff is its own pass, after every hole, rather than woven into
  // groups.forEach above: it uses whatever end mill was chosen for it,
  // never one of the drill diameters, and it belongs on exactly one wall
  // regardless of how many tool groups touched that wall while drilling.
  if (cutoffFeature && (faceAngleDeg === null || normalizeTubestockFaceAngle(faceAngleDeg) === normalizeTubestockFaceAngle(cutoffFeature.angleDeg))) {
    const cutoffToolLabel = `${fmt(cutoffFeature.toolDiameter, 3)}" end mill`;
    if (groups.length === 0) {
      lines.push(`(--- TOOL: ${cutoffToolLabel} (cutoff line) - load before starting ---)`);
      lines.push(`S${spindleSpeed} M03 (spindle on)`);
      if (spindleDwellSeconds > 0) lines.push(dwellLine(isWinCNC, spindleDwellSeconds, 'wait for spindle to reach speed'));
    } else {
      toolChanges += 1;
      lines.push(`G00 Z${fmt(safeZ)} (retract clear before tool change)`);
      lines.push('M05 (spindle off)');
      lines.push(pauseLine(isWinCNC, `TOOL CHANGE: load ${cutoffToolLabel} for the cutoff line, then RE-TOUCH OFF Z0 before resuming - no automatic tool length compensation assumed`));
      lines.push(`S${spindleSpeed} M03 (spindle back on)`);
      if (spindleDwellSeconds > 0) lines.push(dwellLine(isWinCNC, spindleDwellSeconds, 'wait for spindle to reach speed'));
    }
    // Only the combined program can arrive here on a different face than
    // the cutoff's own - a per-face program is by definition already
    // fixtured on its one face, so it never needs this prompt.
    if (faceAngleDeg === null) {
      lines.push(`G00 Z${fmt(safeZ)} (retract clear before flipping tube)`);
      lines.push(`(FACE A${fmt(cutoffFeature.angleDeg, 1)} - FLIP TUBE so ${tubestockFaceLabel(cutoffFeature.angleDeg)} faces up, then RE-ZERO Z before resuming - the operator turns the tube by hand, there is no rotary axis on this machine)`);
      lines.push(pauseLine(isWinCNC, `FLIP TUBE to ${tubestockFaceLabel(cutoffFeature.angleDeg)} face for the cutoff line, and RE-ZERO Z before resuming - no rotary axis on this machine`));
    }
    // One pass, straight in, same depth as a drilled hole through this same
    // wall - through the near wall only, never reaching for the far one.
    // Not a full separation: the tube is only ever fixtured on one wall at
    // a time on this machine, so nothing here can reach all the way around
    // the tube's cross-section. What this cuts is a reference the operator
    // finishes with a horizontal bandsaw, tracking the straight edges of
    // the two long sides across the whole tube.
    lines.push(`(--- CUTOFF LINE at X${fmt(cutoffFeature.position)} - one pass through this wall, not a full separation - band-saw the tube to length along its straight edges ---)`);
    const [start, ...rest] = cutoffFeature.path;
    lines.push(`G00 X${fmt(start.x)} Y${fmt(start.y)} (rapid to cutoff start)`);
    lines.push(`G00 Z${fmt(safeZ)} (rapid to clearance above wall)`);
    lines.push(`G01 Z${fmt(-holeDepth)} F${fmt(feedRate, 2)} (plunge)`);
    for (const point of rest) {
      lines.push(`G01 X${fmt(point.x)} Y${fmt(point.y)} F${fmt(feedRate, 2)} (cutoff contour)`);
    }
    lines.push(`G00 Z${fmt(safeZ)} (retract)`);
  }

  lines.push(`G00 Z${fmt(safeZ)} (final retract)`);
  lines.push('M05 (spindle off)');
  lines.push(isWinCNC ? '(PROGRAM END)' : 'M30 (program end)');
  if (!isWinCNC) lines.push('%');

  // Comments in the controller's own syntax, and well-formed - a comment
  // whose own text contains a parenthesis used to close early and leave the
  // rest of its line as live code. See autocam/gcodeComments.js.
  const gcode = normalizeGcodeComments(lines.join('\n'), { dialect: isWinCNC ? 'wincnc' : 'linuxcnc' });
  return { gcode, totalHoles, toolsUsed: groups.length + (cutoffFeature ? 1 : 0), toolChanges };
}

/**
 * @param {{ tubeLength: number, walls: Array<{angleDeg, holes: Array<{position, lateralOffset, diameter}>, skippedFeatures?: Array}> }} tubeFeatures
 *   Shape matches extractTubeFeaturesFromMeshes' return value directly -
 *   tubeLength isn't actually used for toolpath generation (every hole
 *   already carries its own absolute position), only echoed into stats.
 * @param {Object} params
 *   holeDepth (required, inches) - how deep to plunge past the wall's
 *     outer surface. No auto-detection from geometry (this generator has
 *     no wall-thickness measurement) - same "the operator must state a
 *     real number, not get a guessed default" posture as routing.js's
 *     targetDepth. Too shallow won't clear the wall; too deep on a
 *     through-both-walls hole risks the far wall or a fixture behind it -
 *     verify against the real tube gauge before running. The cutoff line
 *     (below) plunges to this same depth - through the wall it's on, not
 *     both walls of the tube.
 *   safeZ (default 0.25) - retract height above the wall's outer surface.
 *   feedRate (in/min, default 8) - conservative default for drilling
 *     (much slower than routing.js's contour-following feedRate default of
 *     40; a straight plunge into solid material, not a light profile pass).
 *     Also used for the cutoff line's contour pass - see buildCutoffFeature.
 *   spindleSpeed (rpm, default 8000), spindleDwellSeconds (default 2).
 *   controller: 'linuxcnc' (default) | 'wincnc', units: 'in' | 'mm' (default 'in')
 *   programNumber (default 1002 - 1000/1001 already used by turning.js/
 *     routing.js's own conventions elsewhere in this app, kept distinct)
 *   finishedLength (inches, optional) - cuts a bandsaw reference line once
 *     the tube has been drilled to this length, so a stock piece longer
 *     than the finished part can be sawn to size. See buildCutoffFeature
 *     for why this is an operator-entered value rather than read from the
 *     CAD model. Leave unset to skip the cutoff entirely - not every job
 *     needs one.
 *   fixturePinFace (12, 3, 6 or 9) - which physical wall sits against the
 *     fixture's registration pin for this specific tube. Required only
 *     when finishedLength is set; the cutoff goes on the wall opposite it.
 *   toolDiameter (inches) - required only when finishedLength is set; the
 *     end mill that cuts the cutoff line.
 */
export function generateTubestockGcode(tubeFeatures, params = {}) {
  const walls = tubeFeatures?.walls;
  if (!Array.isArray(walls) || walls.length === 0) {
    throw new Error('Tube stock needs at least one wall with hole data');
  }
  const totalHoles = walls.reduce((sum, w) => sum + w.holes.length, 0);
  const cutoffFeature = buildCutoffFeature(walls, params);
  if (totalHoles === 0 && !cutoffFeature) {
    throw new Error('No holes found across any wall, and no finished length was given for a cutoff - nothing to machine');
  }

  const {
    holeDepth,
    safeZ = 0.25,
    feedRate = 8,
    spindleSpeed = 8000,
    spindleDwellSeconds = 2,
    controller = 'linuxcnc',
    units = 'in',
    programNumber = 1002
  } = params;
  if (!holeDepth || holeDepth <= 0) throw new Error('holeDepth is required and must be > 0');
  if (safeZ <= 0) throw new Error('safeZ must be > 0');

  // Real tube/extrusion stock check: the caller resolves stockCatalogId (a
  // pick from this team's real stock catalog, see CamParamFields.svelte's
  // tube-stock "Stock" field) into the two dimensions it actually promises
  // and passes them here as expectedOuterA/expectedOuterB - not the id
  // itself, so this generator stays decoupled from stock.json as a data
  // source. The STEP file's own measured cross-section is still what
  // drives the actual G-code math (tubeFeatures.crossSection, unchanged) -
  // this only catches "the wrong tube is about to get loaded relative to
  // what the CAD model assumes," a real, otherwise-silent mistake, not a
  // math input. Order-independent (a 1x2 tube modeled with X/Y swapped
  // from the catalog's own width/height convention is still the same real
  // stock) and tolerant of real extrusion tolerance (+-0.02"), not exact.
  const { expectedOuterA, expectedOuterB } = params;
  if (expectedOuterA > 0 && expectedOuterB > 0 && tubeFeatures.crossSection) {
    const { a: measuredA, b: measuredB } = tubeFeatures.crossSection;
    const tolerance = 0.02;
    const matchesDirect = Math.abs(measuredA - expectedOuterA) <= tolerance && Math.abs(measuredB - expectedOuterB) <= tolerance;
    const matchesSwapped = Math.abs(measuredA - expectedOuterB) <= tolerance && Math.abs(measuredB - expectedOuterA) <= tolerance;
    if (!matchesDirect && !matchesSwapped) {
      throw new Error(
        `Selected stock is ${expectedOuterA}"x${expectedOuterB}" but the STEP file's measured cross-section is ` +
        `${measuredA.toFixed(3)}"x${measuredB.toFixed(3)}" - re-check the stock selection or the CAD model before running this on material.`
      );
    }
  }

  const combined = generateProgram(walls, params, { programNumber, cutoffFeature });
  const facePrograms = wallsWithHolesByFace(walls, cutoffFeature?.angleDeg).map((wall, index) => {
    const label = tubestockFaceLabel(wall.angleDeg);
    const isCutoffFace = cutoffFeature && normalizeTubestockFaceAngle(wall.angleDeg) === normalizeTubestockFaceAngle(cutoffFeature.angleDeg);
    const faceProgram = generateProgram([wall], params, {
      faceAngleDeg: wall.angleDeg,
      faceLabel: label,
      programNumber: Number(programNumber) + index,
      cutoffFeature: isCutoffFace ? cutoffFeature : null
    });
    return {
      angleDeg: wall.angleDeg,
      label,
      holeCount: faceProgram.totalHoles,
      hasCutoff: !!isCutoffFace,
      programNumber: Number(programNumber) + index,
      gcode: faceProgram.gcode
    };
  });

  // Flattened across every wall, with the wall attached to each entry, for
  // a consumer that wants "what got skipped" without re-walking
  // stats.walls itself. Empty rather than absent when nothing was skipped.
  const skippedFeatures = walls.flatMap((wall) =>
    (wall.skippedFeatures || []).map((feature) => ({ ...feature, angleDeg: wall.angleDeg }))
  );

  return {
    gcode: combined.gcode,
    gcodeFiles: facePrograms,
    stats: {
      tubeLength: tubeFeatures.tubeLength ?? null,
      // Echoed straight from extractTubeFeaturesFromMeshes so a client-side
      // consumer (the 3D toolpath simulator) can reconstruct the tube's
      // outer geometry and hole layout without re-parsing the STEP file -
      // same reasoning as routing.js's stats.edgeShiftX/edgeShiftY.
      crossSection: tubeFeatures.crossSection ?? null,
      walls,
      wallsUsed: facePrograms.length,
      totalHoles,
      toolsUsed: combined.toolsUsed,
      toolChanges: combined.toolChanges,
      skippedFeatures,
      cutoff: cutoffFeature
        ? { angleDeg: cutoffFeature.angleDeg, position: cutoffFeature.position, width: DEFAULT_CUTOFF_WIDTH, length: DEFAULT_CUTOFF_LENGTH }
        : null,
      facePrograms
    }
  };
}
