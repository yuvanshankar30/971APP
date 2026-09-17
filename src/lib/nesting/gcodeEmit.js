import { buildEmitFilename } from './emitFilename.js';
import { holeProgramForThickness } from './holePrograms.js';
import { gcodeDisplayBounds } from './gcodeDocument.js';

const coordinatePattern = /([XYIJ])\s*(-?\d*\.?\d+)/gi;
const terminatePattern = /^\s*(?:%|M2|M30)\b/i;

function splitComment(line) {
  const indexes = [line.indexOf('('), line.indexOf('[')].filter(index => index >= 0);
  const index = indexes.length ? Math.min(...indexes) : -1;
  return index === -1 ? { code: line, comment: '' } : { code: line.slice(0, index), comment: line.slice(index) };
}

function motionForLine(code, state) {
  const gCodes = [...code.matchAll(/\bG(\d+(?:\.\d+)?)\b/gi)].map(match => Number(match[1]));
  if (gCodes.includes(53)) return false;
  if (gCodes.includes(17)) state.plane = 'G17';
  if (gCodes.includes(18)) state.plane = 'G18';
  if (gCodes.includes(19)) state.plane = 'G19';
  const motion = gCodes.find(code => code >= 0 && code <= 3);
  if (motion !== undefined) {
    state.motion = motion;
    return state.plane === 'G17';
  }
  // A bare X/Y line continues the preceding G0-G3 motion. Commands such as
  // G4 X4 are intentionally excluded: their X is a dwell parameter, not X/Y.
  return !gCodes.length && state.motion !== null && state.plane === 'G17';
}

function transformLine(line, placement, state, bounds) {
  const { code, comment } = splitComment(line);
  if (/\bG90\b/i.test(code)) state.absolute = true;
  if (/\bG91(?!\.)\b/i.test(code)) state.absolute = false;
  if (!motionForLine(code, state)) return line;
  const values = {};
  let match;
  while ((match = coordinatePattern.exec(code))) values[match[1].toUpperCase()] = Number(match[2]);
  coordinatePattern.lastIndex = 0;
  if (!Object.keys(values).length) return line;
  const cos = Math.cos(placement.rotation || 0), sin = Math.sin(placement.rotation || 0);
  const rotate = (x, y) => ({ x: x * cos - y * sin, y: x * sin + y * cos });
  const transformed = { ...values };
  if ('X' in values || 'Y' in values) {
    const localX = 'X' in values ? values.X : state.x, localY = 'Y' in values ? values.Y : state.y;
    const point = rotate(localX - bounds.centerX, localY - bounds.centerY);
    if (state.absolute) { transformed.X = point.x + placement.x; transformed.Y = point.y + placement.y; state.x = localX; state.y = localY; }
    else { transformed.X = point.x; transformed.Y = point.y; }
  }
  if ('I' in values || 'J' in values) {
    const vector = rotate(values.I || 0, values.J || 0);
    // I/J describe one vector. Once it has been rotated both components must
    // be emitted, even when the source omitted its zero component. Keeping an
    // old modal J (or I) makes the resulting arc geometrically impossible.
    transformed.I = vector.x;
    transformed.J = vector.y;
  }
  if (!('X' in values || 'Y' in values || 'I' in values || 'J' in values)) return line;

  // The original Java JProg transformer always writes both X/Y and I/J after
  // a rotation. A source program may legally omit an unchanged axis, but that
  // axis generally changes after rotation. Rebuilding these words prevents a
  // controller from reusing a stale modal coordinate or arc-center component.
  const retainedCode = code.replace(coordinatePattern, ' ').replace(/\s+/g, ' ').trim();
  const formatted = (value) => (Math.abs(value) < 0.00000001 ? 0 : value).toFixed(4);
  const words = [retainedCode];
  if ('X' in values || 'Y' in values) {
    words.push(`X${formatted(transformed.X)}`, `Y${formatted(transformed.Y)}`);
  }
  if ('I' in values || 'J' in values) {
    words.push(`I${formatted(transformed.I)}`, `J${formatted(transformed.J)}`);
  }
  return `${words.filter(Boolean).join(' ')}${comment}`;
}

function transformedProgram(source, placement, bounds) {
  const state = { x: 0, y: 0, absolute: true, motion: null, plane: 'G17' };
  return String(source || '').split(/\r?\n/).filter(line => !terminatePattern.test(line)).map(line => transformLine(line, placement, state, bounds));
}

function isG53Line(line) {
  return /\bG53\b/i.test(splitComment(line).code);
}

function router971Body(source, omitSetup = false) {
  const lines = String(source || '').split(/\r?\n/).filter(line => !terminatePattern.test(line));
  const firstSafeRetract = lines.findIndex(isG53Line);
  const lastSafeRetract = lines.findLastIndex(isG53Line);
  const body = firstSafeRetract >= 0 && lastSafeRetract > firstSafeRetract
    ? lines.slice(firstSafeRetract + 1, lastSafeRetract)
    : lines;
  return body.filter(line => {
    const code = splitComment(line).code;
    if (/\bG54\b/i.test(code)) return false;
    if (!omitSetup) return true;
    return !/\bT\d+\s*M6\b|\bS\d+\s*M3\b|\bG4\s+P[\d.]+\b|\bG43\b/i.test(code);
  });
}

function toolTableLines(programs) {
  const seen = new Set();
  const definitions = [];
  for (const { source } of programs) {
    for (const line of String(source || '').split(/\r?\n/)) {
      const match = line.match(/T(\d+)\s+D\s*=\s*([\d.]+)/i);
      if (!match || seen.has(match[1])) continue;
      seen.add(match[1]);
      definitions.push({ tool: Number(match[1]), diameter: Number(match[2]) });
    }
  }
  return definitions.sort((left, right) => left.tool - right.tool);
}

function uncommentedCode(line) {
  return splitComment(line).code;
}

// Matches AutoCAM's own release/outer-profile operation names (see
// DeleteToolpaths.py's _is_outer_profile - kept identical to that pattern on
// purpose, since this is the same operation flowing through both systems).
// Direct instruction: the cut that actually separates a part from stock
// must always run dead last in JProg's emitted program, never grouped in
// with the rest of its tool's ordinary work - cutting it earlier can free
// the part (or its holding tabs) while other operations still need the
// material secured.
const RELEASE_CUT_NAME_PATTERN = /\b(2d\s*slot\s*cut|slot\s*cut\s*for\s*edges)\b/i;
// Direct instruction: only Tool 6 is approved to cut a release/slot cut for
// now - see emitNestingGcode's own validation using this constant.
const APPROVED_RELEASE_CUT_TOOL = 6;

function winCncToolBlocks(source) {
  const blocks = new Map();
  const releaseBlocks = new Map();
  let activeTool = null;
  const releaseTriggered = new Set();
  const lines = String(source || '').split(/\r?\n/).filter(line => !terminatePattern.test(line));
  const finalStop = lines.findLastIndex(line => /\bM5\b/i.test(uncommentedCode(line)));
  const programLines = finalStop >= 0 ? lines.slice(0, finalStop) : lines;
  for (let index = 0; index < programLines.length; index += 1) {
    const line = programLines[index];
    const code = uncommentedCode(line);
    const toolMatch = code.match(/\bT(\d+)\b/i);
    if (toolMatch) {
      activeTool = Number(toolMatch[1]);
      if (!blocks.has(activeTool)) blocks.set(activeTool, []);
      continue;
    }
    if (activeTool === null) continue;
    // AutoCAM normally writes an operation label after its T-word, but its
    // slot-cut post can put the label immediately *before* that T-word. Bind
    // the release marker to that next declaration when present; otherwise it
    // belongs to the currently active tool. This keeps the label and every
    // following slot move together in the final release group.
    if (RELEASE_CUT_NAME_PATTERN.test(line)) {
      const nextTool = uncommentedCode(programLines[index + 1] || '').match(/^\s*T(\d+)\b/i);
      const releaseTool = nextTool ? Number(nextTool[1]) : activeTool;
      releaseTriggered.add(releaseTool);
      if (!releaseBlocks.has(releaseTool)) releaseBlocks.set(releaseTool, []);
      releaseBlocks.get(releaseTool).push(line);
      continue;
    }
    if (releaseTriggered.has(activeTool)) {
      if (!releaseBlocks.has(activeTool)) releaseBlocks.set(activeTool, []);
      releaseBlocks.get(activeTool).push(line);
    } else {
      blocks.get(activeTool).push(line);
    }
  }
  // A tool whose every line went to its release segment leaves an empty
  // (but present) regular entry from the T-word branch above - drop it so
  // callers never see a phantom tool-change with nothing to cut under it.
  for (const [tool, body] of blocks) if (!body.length) blocks.delete(tool);
  // Some valid small programs have no explicit T command. JProg's default
  // router layer is tool 1, so keep that program runnable and schedulable.
  if (!blocks.size && !releaseBlocks.size) blocks.set(1, programLines.filter(line => !isG53Line(line)));
  return { blocks, releaseBlocks };
}

function router971Offset(placement, bounds) {
  const radians = placement.rotation || 0;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  // The Java emitter applies G59.3 rotation around the source program's
  // local 0,0. The web editor stores the visual center, so convert only that
  // center point before emitting the same legacy G10/G59.3 sequence.
  const centerX = bounds.centerX * cosine - bounds.centerY * sine;
  const centerY = bounds.centerX * sine + bounds.centerY * cosine;
  const x = placement.x - centerX;
  const y = placement.y - centerY;
  const rotation = radians * 180 / Math.PI;
  return `G10 L2 P9 X[#5221+${x.toFixed(4)}] Y[#5222+${y.toFixed(4)}] Z[#5223] R${rotation.toFixed(4)}`;
}

function sourceForPlacement(placement, programs, suffix, thickness, dialect) {
  if (placement.kind === 'hole') {
    const source = suffix === 'holes' ? holeProgramForThickness(thickness, dialect) : null;
    return source ? { source, bounds: gcodeDisplayBounds(source) } : null;
  }
  const candidate = programs[placement.part_library_path];
  if (!candidate) return null;
  // Emission must center on the same cutting-only box the editor uses for
  // width_in/height_in, on-screen placement, and collision checks. A
  // leading rapid move (a tool-change/home position an AutoCAM post
  // commonly emits before the first cut) sits outside the actual part
  // geometry, almost always offset in X; folding that rapid into the
  // center used here silently shifted the exported cut geometry off of
  // its displayed, validated-as-non-overlapping position.
  if (candidate.variants) {
    const variant = candidate.variants.find(item => item.suffix === suffix);
    return variant ? { source: variant.source, bounds: variant.bounds } : null;
  }
  const source = candidate.suffix && candidate.suffix !== suffix ? null : candidate.source || candidate;
  return source ? { source, bounds: candidate.bounds || gcodeDisplayBounds(source) } : null;
}

// Matches the original JProg tool-order dialog: T0 is not a cutting tool and
// programs with no explicit T word use the legacy T1 fallback.
export function nestingEmissionTools({ placements, programs, suffix = '', dialect = 'linuxcnc', thickness = '0.125' }) {
  if (dialect !== 'wincnc') return [];
  const tools = new Set();
  for (const placement of placements || []) {
    const program = sourceForPlacement(placement, programs, suffix, thickness, dialect);
    if (!program) continue;
    for (const tool of winCncToolBlocks(program.source).blocks.keys()) if (tool !== 0) tools.add(tool);
  }
  return [...tools].sort((left, right) => left - right);
}

function configuredWinCncToolOrder(order, detectedTools) {
  if (!Array.isArray(order) || !order.length) return detectedTools;
  const normalized = order.map(Number);
  const complete = normalized.length === detectedTools.length && normalized.every(tool => detectedTools.includes(tool));
  if (new Set(normalized).size !== normalized.length || !complete) {
    throw new Error(`Tool order must include each detected tool exactly once: ${detectedTools.map(tool => `T${tool}`).join(', ')}`);
  }
  return normalized;
}

export function emitNestingGcode({ name, placements, programs, suffix = '', filenameSuffix = suffix, suffixCount = 1, dialect = 'linuxcnc', thickness = '0.125', toolOrder = [] }) {
  const selectedPrograms = [];
  for (const placement of placements) {
    const program = sourceForPlacement(placement, programs, suffix, thickness, dialect);
    if (program) selectedPrograms.push({ placement, ...program });
  }
  const bracket = dialect === 'wincnc' ? ['[', ']'] : ['(', ')'];
  const lines = [
    `${bracket[0]}${name} - Sheet Nesting${bracket[1]}`,
    dialect === 'wincnc' ? 'G90\nG20' : '%\nG90 G94 G17 G91.1\nG64 P0.001 Q0.001\nG20\nG53 G0 Z0.',
    `${bracket[0]}Master Tool Table${bracket[1]}`,
    ...toolTableLines(selectedPrograms).map(({ tool, diameter }) => `${bracket[0]}T${tool} D=${diameter.toFixed(4)}${bracket[1]}`),
  ];
  let emitted = 0;
  if (dialect === 'linuxcnc') {
    for (const [index, { placement, source, bounds }] of selectedPrograms.entries()) {
      emitted += 1;
      lines.push(`${bracket[0]}Part: ${placement.label}${bracket[1]}`);
      // This mirrors GCodeParser971: place the unchanged part body using the
      // G59.3 work offset rather than rewriting its controller coordinates.
      lines.push(router971Offset(placement, bounds), 'G59.3', ...router971Body(source, index > 0));
    }
  } else {
    const byTool = new Map();
    const byReleaseTool = new Map();
    for (const program of selectedPrograms) {
      const { blocks, releaseBlocks } = winCncToolBlocks(program.source);
      for (const [tool, body] of blocks) {
        if (!byTool.has(tool)) byTool.set(tool, []);
        byTool.get(tool).push({ ...program, source: body.join('\n') });
      }
      for (const [tool, body] of releaseBlocks) {
        if (!byReleaseTool.has(tool)) byReleaseTool.set(tool, []);
        byReleaseTool.get(tool).push({ ...program, source: body.join('\n') });
      }
    }
    // Direct operator report, with a real posted G-code snippet: a plate
    // part's release/slot cut ran under "[Tool 2]" / T2 - only Tool 6 is
    // approved to cut a release/slot cut for now. Fail emission loudly
    // here, before JProg ever writes the file a router would run, rather
    // than letting an unapproved tool reach the machine.
    for (const [tool, toolPrograms] of byReleaseTool) {
      if (tool === APPROVED_RELEASE_CUT_TOOL) continue;
      const offender = toolPrograms[0]?.placement?.label || 'a placed part';
      throw new Error(
        `${offender}'s release/slot cut is assigned Tool ${tool} - only Tool ${APPROVED_RELEASE_CUT_TOOL} is approved to cut a release/slot cut. Check the AutoCAM job's tool library for whatever tool matched the template's release-cut tool.`
      );
    }
    const orderedTools = configuredWinCncToolOrder(toolOrder, [...byTool.keys()].sort((left, right) => left - right));
    for (const tool of orderedTools) {
      const toolPrograms = byTool.get(tool) || [];
      // GCodeParserWinCNC emits all parts using a tool together, with the safe
      // machine-coordinate retract/tool-change sequence before each group.
      lines.push('G53 Z', 'M5', `[Tool ${tool}]`, `T${tool}`);
      for (const { placement, source, bounds } of toolPrograms) {
        emitted += 1;
        lines.push(`[Part: ${placement.label}]`, ...transformedProgram(source, placement, bounds));
      }
    }
    // Release/outer-profile cuts always run last, after every configured
    // tool group above - see RELEASE_CUT_NAME_PATTERN's own comment. Sorted
    // by tool number only for a stable, deterministic order among
    // themselves; their position relative to everything else is fixed.
    for (const tool of [...byReleaseTool.keys()].sort((left, right) => left - right)) {
      const toolPrograms = byReleaseTool.get(tool) || [];
      lines.push('G53 Z', 'M5', `[Tool ${tool}]`, `T${tool}`);
      for (const { placement, source, bounds } of toolPrograms) {
        emitted += 1;
        lines.push(`[Part: ${placement.label}]`, ...transformedProgram(source, placement, bounds));
      }
    }
  }
  if (dialect === 'linuxcnc') lines.push('M9', 'G53 G0 Z0.', 'M30', '%');
  else lines.push('G53 Z', 'M5', 'G53 P10', 'M30');
  return {
    filename: buildEmitFilename(name, filenameSuffix, suffixCount, dialect === 'wincnc' ? 'tap' : 'ngc'),
    text: lines.join('\n') + '\n',
    emitted,
    toolOrder: dialect === 'wincnc' ? configuredWinCncToolOrder(toolOrder, nestingEmissionTools({ placements, programs, suffix, dialect, thickness })) : []
  };
}
