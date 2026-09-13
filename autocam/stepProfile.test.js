import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readStepMeshes,
  extractTurningProfileFromMeshes,
  extractRoutingContoursFromMeshes,
  extractTubeFeaturesFromMeshes,
  pickLengthAxis,
  transformMeshesForTurningScene,
  transformMeshesForRoutingScene
} from './stepProfile.js';
import { generateTurningGcode } from './inprocess/turning.js';
import { generateRoutingGcode } from './inprocess/routing.js';
import { generateTubestockGcode } from './inprocess/tubestock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEX_SHAFT = path.join(__dirname, '__fixtures__', 'hex-shaft.step');
const FLAT_PLATE = path.join(__dirname, '__fixtures__', 'flat-plate.step');
// Real, more complex CAD files pulled from REV Robotics' public STEP library
// to stress-test the pipeline past simple shapes - each of these caught a
// real bug on first pass (see the describe blocks below).
const VORTEX_SHAFT = path.join(__dirname, '__fixtures__', 'vortex-shaft.step'); // REV-21-2807
const HEX_ADAPTER = path.join(__dirname, '__fixtures__', 'hex-adapter.step'); // REV-41-1620
const MAXSPLINE_BRACKET = path.join(__dirname, '__fixtures__', 'maxspline-bracket.step'); // REV-21-2360
const MULTIBODY_BRACKET = path.join(__dirname, '__fixtures__', 'multibody-bracket.step'); // REV-21-2046
const MOUNTING_BRACKET_FLAT = path.join(__dirname, '__fixtures__', 'mounting-bracket-flat.step'); // REV-41-1624
const MOUNTING_BRACKET_BENT = path.join(__dirname, '__fixtures__', 'mounting-bracket-bent.step'); // REV-41-1623
// From AndyMark's public STEP library - a further round of stress-testing
// against real, more complex parts.
const SPROCKET_32T = path.join(__dirname, '__fixtures__', 'sprocket-32t.step'); // am-4781
const LEAD_SCREW = path.join(__dirname, '__fixtures__', 'lead-screw.step'); // am-3257
const TOUGHBOX_MOTOR_PLATE = path.join(__dirname, '__fixtures__', 'toughbox-motor-plate.step'); // am-0978
// From step.parts (github.com/earthtojake/step.parts, MIT licensed) - real,
// short/wide (diameter > length) turned parts that caught a real bug: the
// turning-profile length-axis auto-detection only ever tried the bounding
// box's LARGEST span as the rotational axis, which is wrong for a
// disc-shaped part (a hub, pulley, washer, flange) where the true axial
// length is the SHORTEST span - see pickLengthAxis in stepProfile.js.
const SET_SCREW_HUB = path.join(__dirname, '__fixtures__', 'set-screw-hub.step');
const V_BELT_PULLEY = path.join(__dirname, '__fixtures__', 'v-belt-pulley.step');
// Real STEP files downloaded directly from vendor sites (AndyMark's public
// S3-hosted CAD downloads, REV Robotics' content/cad/ endpoint), not
// synthetic - see autocam/tubestock-validation-*.md for the full download
// provenance. Tube fixtures specifically stress-test extractTubeFeaturesFromMeshes/
// tubestock.js against real, densely-drilled predrilled tube stock.
const TUBE_05X05_SQUARE = path.join(__dirname, '__fixtures__', 'tube-05x05-square.step'); // am-5001-4700, 0.5"x0.5" tube, 4 walls each with a #10 clearance grid
const TUBE_2X1_WIDE_FACE = path.join(__dirname, '__fixtures__', 'tube-2x1-wide-face.step'); // am-5180, 2"x1" tube - the wide face has side-by-side hole pairs, the file behind the lateralOffset bug fix
const TUBE_2X1_TWO_WALLS = path.join(__dirname, '__fixtures__', 'tube-2x1-two-walls.step'); // am-5644, 2"x1" tube, only 2 of 4 walls drilled
const UNIVERSAL_MOTOR_BRACKET = path.join(__dirname, '__fixtures__', 'universal-motor-bracket.step'); // REV-21-2804
const MOTOR_PLATE_550 = path.join(__dirname, '__fixtures__', '550-motor-plate.step'); // REV-41-1607 - the real file behind the synthetic "550 Motor Plate" regression test above (pickLengthAxis describe block)
const GEARBOX_MOTION_BRACKET_15MM = path.join(__dirname, '__fixtures__', '15mm-gearbox-motion-bracket.step'); // REV-41-1315 - a real bent/formed bracket (15mm wall height matches its own product name), the second real file (after mounting-bracket-bent.step) confirming the bent-part thickness rejection generalizes

// Real STEP files, committed as fixtures - these previously caught a real
// bug (both extractors silently assumed the STEP file's Z axis was the
// relevant one; these files' actual long/thickness axes are X, not Z - see
// stepProfile.js's top-of-file doc comment). Loading real geometry through
// occt-import-js is slow-ish (WASM init) - loaded once per file, reused
// across tests in the same describe block.

describe('extractTurningProfileFromMeshes (real STEP file: hex-shaft.step)', () => {
  let meshes;
  beforeAll(async () => {
    meshes = await readStepMeshes(fs.readFileSync(HEX_SHAFT));
  });

  it('rejects finished hex geometry instead of silently turning it into a round envelope', () => {
    expect(() => extractTurningProfileFromMeshes(meshes)).toThrow(/not radially symmetric/);
  });

  it('rejects a profile whose radius exceeds half the detected length (wrong-axis / disc-shaped guard)', () => {
    // length is bounded by definition as the single largest bounding-box
    // span, so radius (from the other two axes) can approach but never
    // exceed length/sqrt(2) =~ 0.707*length - constructed so both "radius"
    // axes (Y, Z) independently span nearly as much as the picked length
    // axis (X, 10) and a single point sits at both their extremes at once,
    // giving radius ~7.0 against a length/2 threshold of 5.
    const discMeshes = [{
      attributes: { position: { array: new Float32Array([0, 4.95, 4.95, 10, 4.95, 4.95, 5, -4.95, -4.95]) } },
      index: { array: new Uint32Array([]) },
      brep_faces: []
    }];
    expect(() => extractTurningProfileFromMeshes(discMeshes)).toThrow(/doesn't look like a turned part/);
  });

  it('rejects a cross-drilled profile rather than inferring a smooth turning envelope from sparse outer vertices', () => {
    // A simple round tube from z=0 to z=10, radius 1, tessellated with
    // vertices ONLY at its two end rings (exactly what a real STEP export
    // can do for a long straight cylindrical run - a flat surface doesn't
    // need interior vertices to tessellate accurately). Plus 4 loose
    // vertices at (0,0,5) - unconnected to any OD-spanning edge - standing
    // in for a small feature's own near-zero-radius surface sitting right
    // at the shaft's midpoint, same as the real hole that caught this.
    const positions = [];
    for (let k = 0; k < 8; k += 1) {
      const a = (k / 8) * 2 * Math.PI;
      positions.push(Math.cos(a), Math.sin(a), 0); // ring A: indices 0-7
    }
    for (let k = 0; k < 8; k += 1) {
      const a = (k / 8) * 2 * Math.PI;
      positions.push(Math.cos(a), Math.sin(a), 10); // ring B: indices 8-15
    }
    for (let i = 0; i < 4; i += 1) positions.push(0, 0, 5); // indices 16-19

    const indices = [];
    for (let k = 0; k < 8; k += 1) {
      const a0 = k, a1 = (k + 1) % 8;
      const b0 = 8 + k, b1 = 8 + ((k + 1) % 8);
      indices.push(a0, a1, b0);
      indices.push(a1, b1, b0);
    }

    const mesh = {
      attributes: { position: { array: new Float32Array(positions) } },
      index: { array: new Uint32Array(indices) },
      brep_faces: []
    };

    expect(() => extractTurningProfileFromMeshes([mesh], { buckets: 20 })).toThrow(/not radially symmetric/);
  });

  it('rejects a flat plate whose cross-section aspect ratio gives it away, even when it passes the maxRadius<length/2 guard', () => {
    // A thin plate: long in X (10), wide in Y (8), thin in Z (0.5) - this is
    // exactly the shape that slipped through before this check existed (a
    // real "550 Motor Plate" STEP file: long, wide, flat, with mounting
    // holes). maxRadius here is hypot(4, 0.25) =~ 4.008, comfortably under
    // length/2 = 5, so only the new aspect-ratio check catches it.
    const plateMeshes = [{
      attributes: {
        position: {
          array: new Float32Array([
            0, -4, -0.25, 0, 4, -0.25, 0, 4, 0.25, 0, -4, 0.25,
            10, -4, -0.25, 10, 4, -0.25, 10, 4, 0.25, 10, -4, 0.25
          ])
        }
      },
      index: { array: new Uint32Array([]) },
      brep_faces: []
    }];
    expect(() => extractTurningProfileFromMeshes(plateMeshes)).toThrow(/too flat\/rectangular for bar stock/);
  });

  it('rejects a rectangular bar cross-section rather than treating tube stock as turnable', () => {
    expect(pickLengthAxis({ x: 12, y: 2, z: 1.4 })).toBeNull();
  });

  it('rejects the real flat-plate.step fixture (a genuinely flat/holed part, not bar stock)', async () => {
    const plateMeshes = await readStepMeshes(fs.readFileSync(FLAT_PLATE));
    expect(() => extractTurningProfileFromMeshes(plateMeshes)).toThrow(/doesn't look like a turned part/);
  });
});

describe('extractTurningProfileFromMeshes (real formed brackets)', () => {
  it('rejects a bent mounting bracket instead of reducing it to a rotational envelope', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(MOUNTING_BRACKET_BENT));
    expect(() => extractTurningProfileFromMeshes(meshes)).toThrow(/doesn't look like a turned part/);
  });

  it('rejects the independent 15 mm formed bracket regression fixture', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(GEARBOX_MOTION_BRACKET_15MM));
    expect(() => extractTurningProfileFromMeshes(meshes)).toThrow(/doesn't look like a turned part/);
  });

  it('rejects an equal-bounding-box asymmetric prism that cannot be detected from cross-section aspect alone', () => {
    const sides = 16;
    const positions = [];
    for (const x of [0, 5]) {
      for (let i = 0; i < sides; i += 1) {
        const angle = (i / sides) * Math.PI * 2;
        const radius = i % 2 === 0 ? 1 : 0.55;
        positions.push(x, Math.cos(angle) * radius, Math.sin(angle) * radius);
      }
    }
    const index = [];
    for (let i = 0; i < sides; i += 1) {
      const next = (i + 1) % sides;
      index.push(i, next, sides + next, i, sides + next, sides + i);
    }
    const prism = {
      attributes: { position: { array: new Float32Array(positions) } },
      index: { array: new Uint32Array(index) },
      brep_faces: []
    };

    expect(() => extractTurningProfileFromMeshes([prism])).toThrow(/not radially symmetric/);
  });
});

describe('extractTurningProfileFromMeshes (real STEP file: vortex-shaft.step - a stepped motor shaft with a cross-drilled retention-pin hole)', () => {
  let meshes;
  beforeAll(async () => {
    meshes = await readStepMeshes(fs.readFileSync(VORTEX_SHAFT));
  });

  it('rejects the cross-drilled finished part instead of omitting that feature from an XZ turning program', () => {
    expect(() => extractTurningProfileFromMeshes(meshes)).toThrow(/not radially symmetric/);
  });
});

describe('extractTurningProfileFromMeshes (real STEP file: hex-adapter.step - a stepped round-to-hex adapter with a bore)', () => {
  it('rejects non-rotational hex geometry instead of omitting it from the turning profile', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(HEX_ADAPTER));
    expect(() => extractTurningProfileFromMeshes(meshes)).toThrow(/not radially symmetric/);
  });
});

describe('extractTurningProfileFromMeshes (real STEP file: lead-screw.step - a long, thin, stepped shaft)', () => {
  it('produces a clean profile with no near-zero-radius dropouts and generates G-code end to end', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(LEAD_SCREW));
    const profile = extractTurningProfileFromMeshes(meshes);
    const maxRadius = Math.max(...profile.map((p) => p.x));
    for (let i = 2; i < profile.length - 2; i += 1) {
      expect(profile[i].x).toBeGreaterThan(maxRadius * 0.4);
    }
    const result = generateTurningGcode(profile, {
      stockDiameter: maxRadius * 2 * 1.05, stepDown: 0.05, finishAllowance: 0.02, feedRough: 0.008, feedFinish: 0.004
    });
    expect(result.gcode).toContain('M30');
  });
});

describe('extractTurningProfileFromMeshes (real STEP file: set-screw-hub.step - a real bug: short/wide disc-shaped part, diameter > length)', () => {
  it('correctly picks the short axis as rotational, not the largest-span diameter axis, and generates G-code end to end', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(SET_SCREW_HUB));
    const profile = extractTurningProfileFromMeshes(meshes);
    const maxRadius = Math.max(...profile.map((p) => p.x));
    const length = Math.abs(profile[profile.length - 1].z - profile[0].z);
    // This part is genuinely wider than it is long (a real hub, not a
    // shaft) - the pre-fix version rejected this outright as "not a turned
    // part" because it always tried the largest bounding-box span (a
    // diameter direction) as the rotational axis first and never fell back.
    expect(maxRadius).toBeGreaterThan(length / 2);
    const result = generateTurningGcode(profile, {
      stockDiameter: maxRadius * 2 * 1.1, stepDown: 0.05, finishAllowance: 0.02, feedRough: 0.008, feedFinish: 0.004
    });
    expect(result.gcode).toContain('M30');
  });
});

describe('extractTurningProfileFromMeshes (real STEP file: v-belt-pulley.step - another short/wide disc-shaped part)', () => {
  it('correctly picks the short axis as rotational and generates G-code end to end', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(V_BELT_PULLEY));
    const profile = extractTurningProfileFromMeshes(meshes);
    const maxRadius = Math.max(...profile.map((p) => p.x));
    const length = Math.abs(profile[profile.length - 1].z - profile[0].z);
    expect(maxRadius).toBeGreaterThan(length / 2);
    const result = generateTurningGcode(profile, {
      stockDiameter: maxRadius * 2 * 1.1, stepDown: 0.05, finishAllowance: 0.02, feedRough: 0.008, feedFinish: 0.004
    });
    expect(result.gcode).toContain('M30');
  });
});

describe('extractRoutingContoursFromMeshes (real STEP file: sprocket-32t.step - a 32-tooth chain sprocket, the file behind the silhouette-overrun check below)', () => {
  it('rejects the part instead of silently tracing a toothless disc (real bug: the largest flat face stops at the tooth ROOT relief; the actual tooth TIPS are non-planar surfaces entirely outside that face and reach ~20% further out - the traced contour used to become a plain circular disc with zero indication the teeth had been dropped)', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(SPROCKET_32T));
    expect(() => extractRoutingContoursFromMeshes(meshes)).toThrow(/geometry beyond the flat face/);
  });
});

describe('extractRoutingContoursFromMeshes (real STEP file: toughbox-motor-plate.step - a classic multi-hole gearbox motor plate)', () => {
  it('generates G-code end to end with a multi-tool sequence sized for its smallest holes', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(TOUGHBOX_MOTOR_PLATE));
    const { contours, thickness } = extractRoutingContoursFromMeshes(meshes);
    expect(contours.length).toBeGreaterThan(5);
    // 0.0625" added after routing.js started rejecting a helical entry that
    // doesn't leave real clearance (see MIN_HELIX_RADIUS_FRACTION) - this
    // part's smallest holes are only marginally bigger than 0.125", which
    // used to "fit" (didn't collapse the offset) but left almost no
    // toolpath radius, producing a 100+ turn near-stationary "helix."
    const toolSequence = [0.375, 0.25, 0.125, 0.0625].map((d, i) => ({ toolDiameter: d, toolNumber: i + 1 }));
    const result = generateRoutingGcode(contours, { stepDown: 0.1, targetDepth: thickness, toolSequence });
    expect(result.gcode).toContain('M30');
  });
});

describe('extractRoutingContoursFromMeshes (real STEP file: flat-plate.step)', () => {
  let meshes;
  beforeAll(async () => {
    meshes = await readStepMeshes(fs.readFileSync(FLAT_PLATE));
  });

  it('finds the flat face and traces its outline', () => {
    const { contours } = extractRoutingContoursFromMeshes(meshes);
    expect(contours.length).toBeGreaterThanOrEqual(1);
    expect(contours[0].isHole).toBe(false);
  });

  it('reads material thickness from the face normal direction, not a hardcoded Z bounding box', () => {
    // Known-good value for this file - this specific check caught a real
    // bug where thickness came out ~8x too large (2.074" instead of 0.25")
    // because the old code measured along Z instead of the face's own normal.
    const { thickness } = extractRoutingContoursFromMeshes(meshes);
    expect(thickness).toBeCloseTo(0.25, 1);
  });

  it('generates G-code end to end (this fixture is the app\'s primary/simplest routing example but had never actually been run through generateRoutingGcode in a test before)', () => {
    const { contours, thickness } = extractRoutingContoursFromMeshes(meshes);
    const toolSequence = [0.375, 0.25, 0.125].map((d, i) => ({ toolDiameter: d, toolNumber: i + 1 }));
    const result = generateRoutingGcode(contours, { stepDown: 0.1, targetDepth: thickness, toolSequence });
    expect(result.gcode).toContain('M30');
  });

  it('ignores unrelated bodies in a multi-mesh STEP file when measuring thickness', () => {
    // A real STEP file (REV-21-2046) came through as 3 separate meshes: the
    // actual bracket plus two small fastener bodies bundled into the same
    // file. Face SELECTION already correctly picks whichever mesh has the
    // largest flat face, but thickness used to be measured by scanning
    // every mesh's raw vertices regardless of which body the chosen face
    // came from - a fastener poking further along the face normal than the
    // part itself would silently inflate the measured thickness. Modeled
    // here as a flat 2x2 plate (real thickness 2) plus a detached "fastener"
    // mesh with a vertex way out at z=50 and no flat face of its own (so it
    // never wins face selection, but the old code still scanned its
    // position array for the thickness min/max).
    const plateMesh = {
      attributes: {
        position: {
          array: new Float32Array([
            -5, -5, 0, 5, -5, 0, 5, 5, 0, -5, 5, 0, // top face (traced)
            -5, -5, -2, 5, -5, -2, 5, 5, -2, -5, 5, -2 // bottom face (thickness only)
          ])
        }
      },
      // Bottom face declared as a real B-rep face (reversed winding so its
      // normal is -Z, anti-parallel to the top) - not just loose vertices in
      // the position array. Real STEP-derived meshes always have a proper
      // face on both sides of a flat plate; the thickness sanity check added
      // alongside mounting-bracket-bent.step's rejection test (below)
      // requires finding that real opposite face, not just any vertex that
      // happens to be far away along the normal.
      index: { array: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6]) },
      brep_faces: [{ first: 0, last: 1 }, { first: 2, last: 3 }]
    };
    const fastenerMesh = {
      attributes: { position: { array: new Float32Array([0, 0, 50, 0.1, 0, 50]) } },
      index: { array: new Uint32Array([]) },
      brep_faces: []
    };
    const { thickness } = extractRoutingContoursFromMeshes([plateMesh, fastenerMesh]);
    expect(thickness).toBeCloseTo(2, 5);
  });
});

describe('extractRoutingContoursFromMeshes (synthetic closed cube)', () => {
  it('rejects a thick solid instead of emitting a sheet-profile perimeter that can omit features on other faces', () => {
    const vertices = [
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
      0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1
    ];
    const faces = [
      [0, 1, 2, 0, 2, 3], [4, 6, 5, 4, 7, 6],
      [0, 4, 5, 0, 5, 1], [1, 5, 6, 1, 6, 2],
      [2, 6, 7, 2, 7, 3], [3, 7, 4, 3, 4, 0]
    ];
    const index = faces.flat();
    const brep_faces = faces.map((face, i) => ({ first: i * 2, last: i * 2 + 1 }));
    const cube = {
      attributes: { position: { array: new Float32Array(vertices) } },
      index: { array: new Uint32Array(index) },
      brep_faces
    };

    expect(() => extractRoutingContoursFromMeshes([cube])).toThrow(/too thick for the sheet-profile router operation/);
  });
});

describe('extractRoutingContoursFromMeshes (real STEP file: multibody-bracket.step - the real file behind the multi-mesh thickness test above: a bracket bundled with 2 small fastener bodies)', () => {
  it('reads a sane thickness for the bracket itself, not contaminated by the fastener bodies', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(MULTIBODY_BRACKET));
    expect(meshes.length).toBeGreaterThan(1); // confirms this really is a multi-body file
    const { thickness } = extractRoutingContoursFromMeshes(meshes);
    expect(thickness).toBeCloseTo(0.25, 1);
  });

  it('generates G-code end to end with a multi-tool sequence sized for its smallest holes', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(MULTIBODY_BRACKET));
    const { contours, thickness } = extractRoutingContoursFromMeshes(meshes);
    const toolSequence = [0.1875, 0.125, 0.0625].map((d, i) => ({ toolDiameter: d, toolNumber: i + 1 }));
    const result = generateRoutingGcode(contours, { stepDown: 0.1, targetDepth: thickness, toolSequence });
    expect(result.gcode).toContain('M30');
  });
});

describe('extractRoutingContoursFromMeshes (real STEP file: maxspline-bracket.step - includes a real 175-point internal spline bore, the file behind the minThroatDistance message fix in routing.test.js)', () => {
  it('generates G-code end to end with a multi-tool sequence sized for the spline bore', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(MAXSPLINE_BRACKET));
    const { contours, thickness } = extractRoutingContoursFromMeshes(meshes);
    const toolSequence = [0.1875, 0.125, 0.0625].map((d, i) => ({ toolDiameter: d, toolNumber: i + 1 }));
    const result = generateRoutingGcode(contours, { stepDown: 0.1, targetDepth: thickness, toolSequence });
    expect(result.gcode).toContain('M30');
  });
});

describe('extractRoutingContoursFromMeshes (real STEP file: mounting-bracket-flat.step - a genuinely complex multi-hole bracket)', () => {
  it('generates G-code end to end with a multi-tool sequence', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(MOUNTING_BRACKET_FLAT));
    const { contours, thickness } = extractRoutingContoursFromMeshes(meshes);
    expect(contours.length).toBeGreaterThan(5); // genuinely multi-feature, not a plain plate
    const toolSequence = [0.1875, 0.125, 0.0625].map((d, i) => ({ toolDiameter: d, toolNumber: i + 1 }));
    const result = generateRoutingGcode(contours, { stepDown: 0.1, targetDepth: thickness, toolSequence });
    expect(result.gcode).toContain('M30');
  });
});

describe('extractRoutingContoursFromMeshes (real STEP file: mounting-bracket-bent.step - the same bracket already bent, not a flat pattern)', () => {
  it('rejects it instead of measuring a bent-up wall as material thickness (real bug: minD/maxD spanned 0.591" end to end - the base flange\'s real two faces sit ~0.118" apart, matching mounting-bracket-flat.step almost exactly, but a bent-up wall\'s vertices reached the rest of the way with no real face backing that far extreme - would have told the router to cut ~5x deeper than the actual material)', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(MOUNTING_BRACKET_BENT));
    expect(() => extractRoutingContoursFromMeshes(meshes)).toThrow(/no face parallel to its flat face/);
  });
});

describe('extractRoutingContoursFromMeshes (real STEP file: universal-motor-bracket.step - REV-21-2804, a genuinely complex multi-hole bracket)', () => {
  it('generates G-code end to end with a multi-tool sequence', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(UNIVERSAL_MOTOR_BRACKET));
    const { contours, thickness } = extractRoutingContoursFromMeshes(meshes);
    expect(contours.length).toBeGreaterThan(5);
    const toolSequence = [0.375, 0.25, 0.1875, 0.125, 0.0625].map((d, i) => ({ toolDiameter: d, toolNumber: i + 1 }));
    const result = generateRoutingGcode(contours, { stepDown: 0.1, targetDepth: thickness, toolSequence });
    expect(result.gcode).toContain('M30');
  });
});

describe('extractRoutingContoursFromMeshes (real STEP file: 550-motor-plate.step - REV-41-1607, the real file behind the synthetic "550 Motor Plate" flat-plate rejection test in the pickLengthAxis-adjacent turning tests above)', () => {
  it('generates G-code end to end via routing (the correct path for this part, unlike turning)', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(MOTOR_PLATE_550));
    const { contours, thickness } = extractRoutingContoursFromMeshes(meshes);
    const toolSequence = [0.375, 0.25, 0.1875, 0.125, 0.0625].map((d, i) => ({ toolDiameter: d, toolNumber: i + 1 }));
    const result = generateRoutingGcode(contours, { stepDown: 0.1, targetDepth: thickness, toolSequence });
    expect(result.gcode).toContain('M30');
  });

  it('is correctly rejected by the turning path (real bug this part originally caught, now confirmed against the real file, not just a synthetic proxy)', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(MOTOR_PLATE_550));
    expect(() => extractTurningProfileFromMeshes(meshes)).toThrow(/doesn't look like a turned part|too flat\/rectangular for bar stock/);
  });
});

describe('extractRoutingContoursFromMeshes (real STEP file: 15mm-gearbox-motion-bracket.step - REV-41-1315, a real bent/formed bracket)', () => {
  it('rejects it as a bent part (a second real file, independent of mounting-bracket-bent.step, confirming the fix generalizes - its 0.591" bounding-box depth matches its own "15mm" product name, not a measurement bug)', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(GEARBOX_MOTION_BRACKET_15MM));
    expect(() => extractRoutingContoursFromMeshes(meshes)).toThrow(/no face parallel to its flat face/);
  });
});

describe('extractTubeFeaturesFromMeshes (real STEP file: tube-05x05-square.step - am-5001-4700, a real AndyMark 0.5"x0.5" predrilled tube)', () => {
  it('finds a #10 clearance-hole grid on all 4 walls and generates tubestock G-code end to end', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(TUBE_05X05_SQUARE));
    const features = extractTubeFeaturesFromMeshes(meshes);
    expect(features.tubeLength).toBeCloseTo(47, 0);
    expect(features.walls.length).toBe(4);
    for (const wall of features.walls) {
      expect(wall.holes.length).toBeGreaterThan(50); // a 47" tube on a 0.5" grid is ~94 holes/wall
      for (const hole of wall.holes) expect(hole.diameter).toBeCloseTo(0.201, 1); // AndyMark's documented #10 clearance grid
    }
    const result = generateTubestockGcode(features, { holeDepth: 0.15 });
    expect(result.gcode).toContain('M30');
  });
});

describe('extractTubeFeaturesFromMeshes (real STEP file: tube-2x1-wide-face.step - am-5180, a real AndyMark 2"x1" predrilled tube - the file behind the lateralOffset bug fix)', () => {
  it('finds side-by-side hole pairs on the wide (2") face at distinct, non-zero lateral offsets - not collapsed onto the same Y (real bug: lateralOffset used to be computed and silently dropped, which would have driven every hole on this wall to the same G-code Y)', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(TUBE_2X1_WIDE_FACE));
    const features = extractTubeFeaturesFromMeshes(meshes);
    const wideWall = features.walls.find((w) => w.holes.length > 100); // the 2"-wide faces have ~279 holes vs ~93 on the narrow faces
    expect(wideWall).toBeDefined();
    const distinctOffsets = new Set(wideWall.holes.map((h) => Math.round(h.lateralOffset * 100) / 100));
    expect(distinctOffsets.size).toBeGreaterThan(1);
    const result = generateTubestockGcode(features, { holeDepth: 0.2 });
    expect(result.gcode).toContain('M30');
    expect(result.stats.totalHoles).toBeGreaterThan(700);
  });
});

describe('extractTubeFeaturesFromMeshes (real STEP file: tube-2x1-two-walls.step - am-5644, a real AndyMark 2"x1" tube with only 2 of 4 walls drilled)', () => {
  it('correctly leaves the 2 undrilled walls empty rather than inventing holes, and generates G-code end to end', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(TUBE_2X1_TWO_WALLS));
    const features = extractTubeFeaturesFromMeshes(meshes);
    const drilledWalls = features.walls.filter((w) => w.holes.length > 0);
    const blankWalls = features.walls.filter((w) => w.holes.length === 0);
    expect(drilledWalls.length).toBe(2);
    expect(blankWalls.length).toBe(2);
    const result = generateTubestockGcode(features, { holeDepth: 0.15 });
    expect(result.gcode).toContain('M30');
  });
});

describe('readStepMeshes', () => {
  it('loads real geometry with vertices, triangle indices, and named faces', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(HEX_SHAFT));
    expect(meshes.length).toBeGreaterThan(0);
    expect(meshes[0].attributes.position.array.length).toBeGreaterThan(0);
    expect(meshes[0].index.array.length).toBeGreaterThan(0);
  });

  it('throws a clear error for garbage input instead of a cryptic WASM crash', async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5]);
    await expect(readStepMeshes(garbage)).rejects.toThrow();
  });
});

describe('pickLengthAxis (synthetic bounding-box spans - the length-axis auto-detection heuristic itself)', () => {
  it('picks the largest span as length for an elongated shaft (the common case, unchanged from before)', () => {
    const picked = pickLengthAxis({ x: 4, y: 0.5, z: 0.5 });
    expect(picked.lengthAxis).toBe('x');
  });

  it('falls back to the SMALLEST span as length for a short/wide disc-shaped part (a hub, pulley, washer) - real bug: the largest-span-only heuristic rejected these outright', () => {
    const picked = pickLengthAxis({ x: 0.7, y: 0.7, z: 0.3 });
    expect(picked.lengthAxis).toBe('z');
  });

  it('still rejects a genuine flat SQUARE plate even though its bounding box is indistinguishable from a round disc by aspect ratio alone - gated by the diameter-to-length ratio, not just roundness', () => {
    // 4"x4"x0.1" square plate: same off-axis aspect ratio (1.0, perfectly
    // "round"-looking by bounding box alone) as a genuine 4"-diameter,
    // 0.1"-thick disc would have - only the diameter:length ratio (40:1
    // here, versus a real disc's typical single-digit ratio) tells them apart.
    const picked = pickLengthAxis({ x: 4, y: 4, z: 0.1 });
    expect(picked).toBeNull();
  });

  it('still rejects a genuine rectangular (non-square) flat plate', () => {
    const picked = pickLengthAxis({ x: 4, y: 2, z: 0.1 });
    expect(picked).toBeNull();
  });

  it('accepts a reasonably proportioned disc (diameter well within the sanity ratio)', () => {
    const picked = pickLengthAxis({ x: 1, y: 1, z: 0.3 }); // ~3.3:1 diameter:length
    expect(picked.lengthAxis).toBe('z');
  });

  it('rejects an unreasonably thin "disc" past the diameter-to-length sanity ratio (still plate-like, just happened to pass the roundness check)', () => {
    const picked = pickLengthAxis({ x: 5, y: 0.1, z: 3 }); // passes roundness on the y-as-length fallback, but the diameter:length ratio is still plate-like
    expect(picked).toBeNull();
  });

  it('tolerates a hex/square bar-stock cross-section on the primary (elongated) path - real turned parts are not always circular', () => {
    const picked = pickLengthAxis({ x: 3, y: 0.5, z: 0.4 }); // 0.8 aspect - within the 0.5 roundness bar
    expect(picked.lengthAxis).toBe('x');
  });

  it('handles a perfect-cube bounding box without erroring (degenerate tie between largest and smallest span)', () => {
    const picked = pickLengthAxis({ x: 1, y: 1, z: 1 });
    expect(picked).not.toBeNull();
    expect(['x', 'y', 'z']).toContain(picked.lengthAxis);
  });
});

// --- Synthetic rectangular tube mesh builder, for extractTubeFeaturesFromMeshes ---
//
// Builds a real, topologically valid triangle mesh (not a shortcut/mock) for
// a rectangular tube: 4 side walls + 2 end caps, with genuine round holes
// tessellated directly into a wall's own triangulation (a hole is a real
// inner boundary loop of that wall's mesh - exactly how a real STEP export
// represents it, and exactly what extractTubeFeaturesFromMeshes expects -
// not a cylindrical "hole surface" needing separate detection). Holes are
// built via plain grid-cell inclusion/exclusion (not a bridge/keyhole
// polygon triangulation) specifically because a naive bridge triangulation
// leaves the bridge's own edges on the mesh boundary instead of interior,
// splitting what should be one clean hole loop into a corrupted multi-loop
// mess - grid cells sharing vertices between neighbors sidesteps that
// entirely and is what a real CAD kernel's tessellation topologically
// resembles anyway.
// excludedFn(u, v) -> true skips that grid cell entirely, leaving a gap in
// the tessellation that traces out as an inner boundary loop - a round hole
// (circle predicate) or a non-round feature (any other predicate, e.g. a
// slot, used to exercise the roundness-rejection path) are built exactly
// the same way.
function buildGridWithCutouts(width, height, excludedFn, cellSize) {
  const nu = Math.max(4, Math.round(width / cellSize));
  const nv = Math.max(4, Math.round(height / cellSize));
  const points = [];
  const idOf = (i, j) => j * (nu + 1) + i;
  for (let j = 0; j <= nv; j += 1) {
    for (let i = 0; i <= nu; i += 1) points.push({ u: (i / nu) * width, v: (j / nv) * height });
  }
  const triangles = [];
  for (let j = 0; j < nv; j += 1) {
    for (let i = 0; i < nu; i += 1) {
      const cu = ((i + 0.5) / nu) * width, cv = ((j + 0.5) / nv) * height;
      if (excludedFn(cu, cv)) continue;
      const a = idOf(i, j), b = idOf(i + 1, j), c = idOf(i + 1, j + 1), d = idOf(i, j + 1);
      triangles.push([a, b, c], [a, c, d]);
    }
  }
  return { points, triangles };
}

function circleHoles(holes) {
  return (u, v) => holes.some((h) => Math.hypot(u - h.cu, v - h.cv) < h.r);
}

// embed(u,v) maps this wall's local 2D grid into 3D; flip controls winding
// so the resulting face normal points the intended outward direction
// (verified numerically while building this fixture, not just assumed).
function wallFace(uSpan, vSpan, excludedFn, cellSize, embed, flip) {
  const { points, triangles } = buildGridWithCutouts(uSpan, vSpan, excludedFn, cellSize);
  const verts3d = points.map((p) => embed(p.u, p.v));
  const tris = flip ? triangles.map(([a, b, c]) => [a, c, b]) : triangles;
  return { verts3d, tris };
}

function simpleRectFace(uSpan, vSpan, embed, flip) {
  const points = [{ u: 0, v: 0 }, { u: uSpan, v: 0 }, { u: uSpan, v: vSpan }, { u: 0, v: vSpan }];
  const verts3d = points.map((p) => embed(p.u, p.v));
  const tris = flip ? [[0, 2, 1], [0, 3, 2]] : [[0, 1, 2], [0, 2, 3]];
  return { verts3d, tris };
}

function assembleTubeMesh(faces) {
  const positions = [];
  const indices = [];
  const brepFaces = [];
  for (const { verts3d, tris } of faces) {
    const base = positions.length / 3;
    for (const v of verts3d) positions.push(v.x, v.y, v.z);
    const firstTri = indices.length / 3;
    for (const [a, b, c] of tris) indices.push(base + a, base + b, base + c);
    brepFaces.push({ first: firstTri, last: indices.length / 3 - 1 });
  }
  return {
    attributes: { position: { array: new Float32Array(positions) } },
    index: { array: new Uint32Array(indices) },
    brep_faces: brepFaces
  };
}

// A 6" x 1.5" x 1.0" rectangular tube: 2 round holes (0.3" dia) on the +Y
// wall at X=1.5"/4.5", 1 round hole (0.25" dia) on the +Z wall at X=3", the
// other two walls blank, both end caps present (and must be excluded from
// the result - they're not side walls).
function buildTestTube({ slotInsteadOfSecondHole = false } = {}) {
  const LEN = 6, WY = 1.5, HZ = 1.0;
  // Non-round feature (an elongated slot, not a circle) on the +Y wall in
  // place of its second hole, to exercise the roundness-rejection path.
  const wallAplusCutouts = slotInsteadOfSecondHole
    ? (u, v) => Math.hypot(u - 1.5, v - 0.5) < 0.15 || (Math.abs(u - 4.5) < 0.6 && Math.abs(v - 0.5) < 0.12)
    : circleHoles([{ cu: 1.5, cv: 0.5, r: 0.15 }, { cu: 4.5, cv: 0.5, r: 0.15 }]);
  const wallAplus = wallFace(LEN, HZ, wallAplusCutouts, 0.025, (u, v) => ({ x: u, y: WY, z: v }), true);
  const wallBplus = wallFace(LEN, WY, circleHoles([{ cu: 3.0, cv: 0.75, r: 0.125 }]), 0.025, (u, v) => ({ x: u, y: v, z: HZ }), false);
  const wallAminus = simpleRectFace(LEN, HZ, (u, v) => ({ x: u, y: 0, z: v }), false);
  const wallBminus = simpleRectFace(LEN, WY, (u, v) => ({ x: u, y: v, z: 0 }), true);
  const capStart = simpleRectFace(WY, HZ, (u, v) => ({ x: 0, y: u, z: v }), true);
  const capEnd = simpleRectFace(WY, HZ, (u, v) => ({ x: LEN, y: u, z: v }), false);
  return assembleTubeMesh([wallAplus, wallBplus, wallAminus, wallBminus, capStart, capEnd]);
}

describe('extractTubeFeaturesFromMeshes (synthetic rectangular tube: 6"x1.5"x1.0", 2 holes on one wall, 1 on another, 2 blank walls, 2 end caps)', () => {
  it('finds the tube\'s long axis, outer cross-section, and all 4 side walls at 0/90/180/270 degrees', () => {
    const result = extractTubeFeaturesFromMeshes([buildTestTube()]);
    expect(result.lengthAxis).toBe('x');
    expect(result.tubeLength).toBeCloseTo(6, 3);
    expect(result.crossSection.a).toBeCloseTo(1.5, 3);
    expect(result.crossSection.b).toBeCloseTo(1.0, 3);
    expect(result.walls.map((w) => w.angleDeg)).toEqual([0, 90, 180, 270]);
  });

  it('excludes the end caps entirely - only 4 side walls, never 6 faces', () => {
    const result = extractTubeFeaturesFromMeshes([buildTestTube()]);
    expect(result.walls.length).toBe(4);
  });

  it('finds both holes on the same wall, sorted by position along the tube, with correct diameters', () => {
    const result = extractTubeFeaturesFromMeshes([buildTestTube()]);
    const wall0 = result.walls.find((w) => w.angleDeg === 0);
    expect(wall0.holes.length).toBe(2);
    expect(wall0.holes[0].position).toBeCloseTo(1.5, 1);
    expect(wall0.holes[0].diameter).toBeCloseTo(0.3, 1);
    expect(wall0.holes[1].position).toBeCloseTo(4.5, 1);
    expect(wall0.holes[1].diameter).toBeCloseTo(0.3, 1);
  });

  it('finds the single hole on the second wall and leaves the two blank walls empty', () => {
    const result = extractTubeFeaturesFromMeshes([buildTestTube()]);
    const wall90 = result.walls.find((w) => w.angleDeg === 90);
    expect(wall90.holes.length).toBe(1);
    expect(wall90.holes[0].position).toBeCloseTo(3, 1);
    expect(wall90.holes[0].diameter).toBeCloseTo(0.25, 1);
    expect(result.walls.find((w) => w.angleDeg === 180).holes).toEqual([]);
    expect(result.walls.find((w) => w.angleDeg === 270).holes).toEqual([]);
  });

  it('classifies a non-round feature (a slot) as a profile rather than treating it as a round hole of some averaged diameter, or throwing away every real hole on the same tube over it', () => {
    // Real regression this replaced: refusing the whole tube here used to
    // discard 388 real holes on a real part over 2 shapes (obround witness
    // marks the CAD modeler drew, not holes) that this extractor has no way
    // to represent as a single center+diameter.
    const result = extractTubeFeaturesFromMeshes([buildTestTube({ slotInsteadOfSecondHole: true })]);
    const wall0 = result.walls.find((w) => w.angleDeg === 0);
    // The first (round) hole on this wall still comes through untouched.
    expect(wall0.holes.length).toBe(1);
    expect(wall0.holes[0].position).toBeCloseTo(1.5, 1);
    // The slot is described, not silently dropped, so tubestock.js can mill it.
    expect(wall0.profiles.length).toBe(1);
    expect(wall0.profiles[0].position).toBeCloseTo(4.5, 1);
    expect(wall0.profiles[0].lateralOffset).toBeCloseTo(0, 1);
  });

  it('gives a profile its full boundary, in the same (position, lateralOffset) coordinates as a hole - not just a centroid', () => {
    // The synthetic slot is a 1.2" x 0.24" rectangle centered at u=4.5,
    // v=0.5 on a wall spanning v in [0, 1.0] - see wallAplusCutouts in
    // buildTestTube. After the same transform holes get (position =
    // u - lengthMin, lateralOffset = v - wallWidth/2), its boundary should
    // span roughly x in [3.9, 5.1] and y in [-0.12, 0.12].
    const result = extractTubeFeaturesFromMeshes([buildTestTube({ slotInsteadOfSecondHole: true })]);
    const profile = result.walls.find((w) => w.angleDeg === 0).profiles[0];
    expect(profile.points.length).toBeGreaterThan(3);
    const xs = profile.points.map((p) => p.x);
    const ys = profile.points.map((p) => p.y);
    expect(Math.min(...xs)).toBeGreaterThan(3.5);
    expect(Math.max(...xs)).toBeLessThan(5.5);
    expect(Math.min(...ys)).toBeGreaterThan(-0.3);
    expect(Math.max(...ys)).toBeLessThan(0.3);
    // A real 2D boundary, not every point collapsed onto the centroid.
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.5);
  });

  it('reports an empty profiles on a wall with nothing non-round, not a missing field', () => {
    const result = extractTubeFeaturesFromMeshes([buildTestTube()]);
    for (const wall of result.walls) expect(wall.profiles).toEqual([]);
  });

  it('reports lateralOffset as a signed distance from the wall\'s own centerline, not just the position along the tube - real bug found against a real AndyMark 2"x1" tube fixture: this field used to be computed and silently dropped, which would have driven multiple holes on a wide face to the same G-code Y (see tubestock.test.js)', () => {
    // Two holes on the +Y wall (spans Z in [0,1.0]) at the same X position
    // but offset +/-0.3" from the wall's own center (0.5) - a real
    // side-by-side hole pair on a wide face, not a duplicate.
    const LEN = 6, WY = 1.5, HZ = 1.0;
    const wallAplus = wallFace(
      LEN, HZ,
      circleHoles([{ cu: 3, cv: 0.2, r: 0.1 }, { cu: 3, cv: 0.8, r: 0.1 }]),
      0.02, (u, v) => ({ x: u, y: WY, z: v }), true
    );
    const wallBplus = simpleRectFace(LEN, WY, (u, v) => ({ x: u, y: v, z: HZ }), false);
    const wallAminus = simpleRectFace(LEN, HZ, (u, v) => ({ x: u, y: 0, z: v }), false);
    const wallBminus = simpleRectFace(LEN, WY, (u, v) => ({ x: u, y: v, z: 0 }), true);
    const capStart = simpleRectFace(WY, HZ, (u, v) => ({ x: 0, y: u, z: v }), true);
    const capEnd = simpleRectFace(WY, HZ, (u, v) => ({ x: LEN, y: u, z: v }), false);
    const mesh = assembleTubeMesh([wallAplus, wallBplus, wallAminus, wallBminus, capStart, capEnd]);

    const result = extractTubeFeaturesFromMeshes([mesh]);
    const wall0 = result.walls.find((w) => w.angleDeg === 0);
    expect(wall0.holes.length).toBe(2);
    // Wall center is at v=0.5 (HZ/2); holes at v=0.2 and v=0.8 -> offsets -0.3 and +0.3.
    const offsets = wall0.holes.map((h) => h.lateralOffset).sort((a, b) => a - b);
    expect(offsets[0]).toBeCloseTo(-0.3, 1);
    expect(offsets[1]).toBeCloseTo(0.3, 1);
  });

  it('generates G-code end to end through generateTubestockGcode', () => {
    const features = extractTubeFeaturesFromMeshes([buildTestTube()]);
    const result = generateTubestockGcode(features, { holeDepth: 0.15 });
    expect(result.gcode).toContain('M30');
    expect(result.stats.totalHoles).toBe(3);
  });
});

describe('transformMeshesForTurningScene (Phase 5 ghost-part overlay)', () => {
  it('aligns with extractTurningProfileFromMeshes for the same real STEP file (lead-screw.step) - not just a similar-looking transform, the same one', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(LEAD_SCREW));
    const profile = extractTurningProfileFromMeshes(meshes);
    const transformed = transformMeshesForTurningScene(meshes);

    let transformedMaxRadius = 0;
    let transformedMinX = Infinity;
    let transformedMaxX = -Infinity;
    for (const mesh of transformed) {
      const pos = mesh.position;
      for (let i = 0; i < pos.length; i += 3) {
        const r = Math.hypot(pos[i + 1], pos[i + 2]);
        if (r > transformedMaxRadius) transformedMaxRadius = r;
        if (pos[i] < transformedMinX) transformedMinX = pos[i];
        if (pos[i] > transformedMaxX) transformedMaxX = pos[i];
      }
    }

    // Same envelope: the extracted profile's max radius is the exact same
    // "farthest any vertex sits from the spindle axis" measurement the
    // transform's own radial plane should reproduce.
    const profileMaxRadius = Math.max(...profile.map((p) => p.x));
    expect(transformedMaxRadius).toBeCloseTo(profileMaxRadius, 2);

    // Same axial span, and scene x=0 (the face) is the near end, going
    // negative toward the chuck - matches turning.js's own normalization
    // (zOrigin = profile[0].z, machining Z = zOrigin - nativeZ).
    const profileZRange = Math.abs(profile[profile.length - 1].z - profile[0].z);
    expect(Math.abs(transformedMaxX - transformedMinX)).toBeCloseTo(profileZRange, 1);
    expect(transformedMaxX).toBeGreaterThanOrEqual(-1e-6);
    expect(transformedMinX).toBeLessThan(0);
  });

  it('throws the same "no spindle axis" error extractTurningProfileFromMeshes would, for a non-turned part', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(FLAT_PLATE));
    expect(() => transformMeshesForTurningScene(meshes)).toThrow(/spindle axis/);
  });
});

describe('transformMeshesForRoutingScene (Phase 5 ghost-part overlay)', () => {
  it('aligns with extractRoutingContoursFromMeshes for the same real STEP file (flat-plate.step) - same frame, so it cannot disagree', async () => {
    const meshes = await readStepMeshes(fs.readFileSync(FLAT_PLATE));
    const { contours, thickness, frame } = extractRoutingContoursFromMeshes(meshes);
    const transformed = transformMeshesForRoutingScene(meshes, frame);

    let minZ = Infinity;
    let maxZ = -Infinity;
    let meshMinX = Infinity;
    let meshMaxX = -Infinity;
    for (const mesh of transformed) {
      const pos = mesh.position;
      for (let i = 0; i < pos.length; i += 3) {
        if (pos[i] < meshMinX) meshMinX = pos[i];
        if (pos[i] > meshMaxX) meshMaxX = pos[i];
        if (pos[i + 2] < minZ) minZ = pos[i + 2];
        if (pos[i + 2] > maxZ) maxZ = pos[i + 2];
      }
    }

    // scene z=0 is the found face (routing.js's own Z0 convention, no
    // further offset) - depth into the material reads negative, down to
    // -thickness, never meaningfully positive.
    expect(maxZ).toBeLessThanOrEqual(1e-4);
    expect(minZ).toBeCloseTo(-thickness, 1);

    // scene x/y footprint matches the traced outer contour - same u/v
    // basis both were built from.
    const outer = contours[0].points;
    const contourMinX = Math.min(...outer.map((p) => p.x));
    const contourMaxX = Math.max(...outer.map((p) => p.x));
    expect(meshMinX).toBeCloseTo(contourMinX, 1);
    expect(meshMaxX).toBeCloseTo(contourMaxX, 1);
  });
});
