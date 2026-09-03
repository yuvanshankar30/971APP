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

export function normalizeTubestockFaceAngle(angleDeg) {
  const normalized = ((Number(angleDeg) || 0) % 360 + 360) % 360;
  return Number(normalized.toFixed(4));
}

/** Human-readable face name for standard rectangular tube orientations. */
export function tubestockFaceLabel(angleDeg) {
  const angle = normalizeTubestockFaceAngle(angleDeg);
  const cardinalLabels = {
    0: 'Top',
    90: 'Right side',
    180: 'Bottom',
    270: 'Left side'
  };
  return cardinalLabels[angle] || `Face A${angle}`;
}

/** Name a separately-runnable program for one rotary-indexed tube face. */
export function tubestockFaceFileName(gcodeFileName, angleDeg) {
  const source = String(gcodeFileName || 'tube-stock.ngc');
  const extensionMatch = source.match(/(\.[a-z0-9]+)$/i);
  const extension = extensionMatch?.[1] || '.ngc';
  const base = extensionMatch ? source.slice(0, -extension.length) : source;
  const angle = String(normalizeTubestockFaceAngle(angleDeg)).replace(/\./g, '_');
  const label = tubestockFaceLabel(angleDeg).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${base}-${label}-a${angle}${extension}`;
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

function wallsWithHolesByFace(walls) {
  const faces = new Map();
  for (const wall of walls) {
    if (!wall.holes?.length) continue;
    const angleDeg = normalizeTubestockFaceAngle(wall.angleDeg);
    if (!faces.has(angleDeg)) faces.set(angleDeg, []);
    faces.get(angleDeg).push(...wall.holes);
  }
  return [...faces.entries()]
    .sort(([a], [b]) => a - b)
    .map(([angleDeg, holes]) => ({ angleDeg, holes }));
}

function generateProgram(walls, params, { faceAngleDeg = null, faceLabel = null, programNumber }) {
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
  const faceDescription = faceAngleDeg === null ? null : `${faceLabel || tubestockFaceLabel(faceAngleDeg)} (${fmt(faceAngleDeg, 1)} deg from Top)`;
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
          lines.push(`(FACE A${fmt(hole.angleDeg, 1)} - FLIP TUBE to ${tubestockFaceLabel(hole.angleDeg)} face and RE-ZERO Z before resuming - no rotary axis on this machine)`);
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

  lines.push(`G00 Z${fmt(safeZ)} (final retract)`);
  lines.push('M05 (spindle off)');
  lines.push(isWinCNC ? '(PROGRAM END)' : 'M30 (program end)');
  if (!isWinCNC) lines.push('%');

  // Comments in the controller's own syntax, and well-formed - a comment
  // whose own text contains a parenthesis used to close early and leave the
  // rest of its line as live code. See autocam/gcodeComments.js.
  const gcode = normalizeGcodeComments(lines.join('\n'), { dialect: isWinCNC ? 'wincnc' : 'linuxcnc' });
  return { gcode, totalHoles, toolsUsed: groups.length, toolChanges };
}

/**
 * @param {{ tubeLength: number, walls: Array<{angleDeg, holes: Array<{position, lateralOffset, diameter}>}> }} tubeFeatures
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
 *     verify against the real tube gauge before running.
 *   safeZ (default 0.25) - retract height above the wall's outer surface.
 *   feedRate (in/min, default 8) - conservative default for drilling
 *     (much slower than routing.js's contour-following feedRate default of
 *     40; a straight plunge into solid material, not a light profile pass).
 *   spindleSpeed (rpm, default 8000), spindleDwellSeconds (default 2).
 *   controller: 'linuxcnc' (default) | 'wincnc', units: 'in' | 'mm' (default 'in')
 *   programNumber (default 1002 - 1000/1001 already used by turning.js/
 *     routing.js's own conventions elsewhere in this app, kept distinct)
 */
export function generateTubestockGcode(tubeFeatures, params = {}) {
  const walls = tubeFeatures?.walls;
  if (!Array.isArray(walls) || walls.length === 0) {
    throw new Error('Tube stock needs at least one wall with hole data');
  }
  const totalHoles = walls.reduce((sum, w) => sum + w.holes.length, 0);
  if (totalHoles === 0) {
    throw new Error('No holes found across any wall - nothing to drill');
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

  const combined = generateProgram(walls, params, { programNumber });
  const facePrograms = wallsWithHolesByFace(walls).map((wall, index) => {
    const label = tubestockFaceLabel(wall.angleDeg);
    const faceProgram = generateProgram([wall], params, {
      faceAngleDeg: wall.angleDeg,
      faceLabel: label,
      programNumber: Number(programNumber) + index
    });
    return {
      angleDeg: wall.angleDeg,
      label,
      holeCount: faceProgram.totalHoles,
      programNumber: Number(programNumber) + index,
      gcode: faceProgram.gcode
    };
  });

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
      facePrograms
    }
  };
}
