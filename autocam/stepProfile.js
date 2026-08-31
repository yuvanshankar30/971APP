/**
 * Extracts 2D CAM geometry directly from a STEP file's triangulated mesh via
 * occt-import-js (already a dependency here, used by CadViewer.svelte for
 * the 3D viewer - this module reuses the exact same library, just server-side
 * in Node instead of the browser). No DXF, no separate 2D drawing needed.
 *
 * Both extractors work off the mesh geometry only (positions + triangle
 * indices + per-face triangle ranges), not true B-rep surfaces - occt-import-js
 * only exposes the triangulated result, not raw OpenCascade topology. That's
 * enough for what's needed here:
 *
 * - Turning: lathe parts are physically solids of revolution (that's the only
 *   thing a lathe can produce), so instead of requiring a specific modeling
 *   axis, this auto-detects the part's long axis (the bounding box's largest
 *   span - real turned parts are always much longer than they are wide) and
 *   uses it as the length axis, centering the radius calculation on the
 *   bounding-box midpoint of the other two axes. Works regardless of which
 *   way the part happens to be oriented in the STEP file.
 * - Routing: finds the largest planar face on the part (in ANY orientation,
 *   not just facing a particular axis - it's whichever face has the most
 *   area, verified genuinely flat by checking all its triangles share one
 *   normal), traces its triangle-boundary edges into closed 2D loops (outer
 *   profile + holes) projected into that face's own plane, and reads
 *   material thickness as the part's full extent along that face's normal.
 *
 * Earlier versions of both of these assumed the part was modeled with a
 * specific axis (Z) aligned to the tool axis / face normal. Real STEP
 * exports (Onshape in particular) very often don't follow that convention -
 * a "Hex Shaft" test part came through with its long axis on X, and a flat
 * routed part came through with its thin (thickness) axis on X instead of Z,
 * which silently produced a face normal to Z instead of the real flat face -
 * cutting the wrong outline at ~8x the real material thickness. Auto-
 * detecting orientation from the geometry itself removes that whole class of
 * silent-wrong-output failure instead of requiring users to know and follow
 * an arbitrary modeling convention.
 */

// occt-import-js is Emscripten-compiled WASM; its default loader finds its
// .wasm binary via fs.readFileSync() relative to __dirname, which breaks
// once a bundler relocates the code away from its original node_modules
// layout - __dirname no longer points anywhere near the real file. A
// require.resolve()-based fix (tried first, see git history) still failed
// in production: Vercel's build-time file tracer doesn't detect that
// runtime-resolved dependency and never includes the .wasm binary in the
// deployed function bundle at all ("Cannot find module ...occt-import-js.wasm",
// confirmed directly from a real Vercel function error). That fallback still
// works fine locally (plain Node, or `vite dev`), so it stays as the default
// for scripts/test-cam-extraction.mjs and local dev - but the server route
// (src/routes/api/cam-generate/+server.js) now fetches the same WASM binary
// CadViewer.svelte already serves successfully client-side (a real Vite
// build asset with a real URL, not a traced filesystem dependency) and
// passes the bytes in directly via `wasmBinaryOverride`, sidestepping the
// tracer issue entirely. See implementations/vercel-cam-generate-timeout-fix.md.
let occtPromise = null;
async function getOcct(wasmBinaryOverride) {
  if (!occtPromise) {
    const { default: occtimportjsFactory } = await import('occt-import-js');
    if (wasmBinaryOverride) {
      occtPromise = occtimportjsFactory({ wasmBinary: wasmBinaryOverride });
    } else {
      const [{ createRequire }, { readFileSync }] = await Promise.all([import('node:module'), import('node:fs')]);
      const require = createRequire(import.meta.url);
      const wasmPath = require.resolve('occt-import-js/dist/occt-import-js.wasm');
      const wasmBinary = readFileSync(wasmPath);
      occtPromise = occtimportjsFactory({ wasmBinary });
    }
  }
  return occtPromise;
}

/**
 * Reads a STEP file buffer into occt-import-js's mesh result, in inches.
 * @param {Uint8Array} stepBuffer
 * @param {Uint8Array|Buffer} [wasmBinary] - pre-fetched WASM bytes, for
 *   callers (the Vercel-deployed server route) where the default
 *   filesystem-based loader can't find its binary - see getOcct() above.
 */
export async function readStepMeshes(stepBuffer, wasmBinary) {
  const occt = await getOcct(wasmBinary);
  const result = occt.ReadStepFile(stepBuffer, { linearUnit: 'inch' });
  if (!result.success || !result.meshes?.length) {
    throw new Error('Could not read solid geometry from this STEP file');
  }
  return result.meshes;
}

function triangleVertex(mesh, triIndex, corner) {
  const vi = mesh.index.array[triIndex * 3 + corner];
  const pos = mesh.attributes.position.array;
  return { x: pos[vi * 3], y: pos[vi * 3 + 1], z: pos[vi * 3 + 2], vi };
}

function meshesBoundingBox(meshes) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const mesh of meshes) {
    const pos = mesh.attributes.position.array;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

const AXIS_INDEX = { x: 0, y: 1, z: 2 };

/**
 * Turning: max-radius-per-length-bucket envelope across all vertices of all
 * meshes. The "length" axis is auto-detected as whichever of X/Y/Z has the
 * largest bounding-box span (a real turned part is always much longer than
 * it is wide), radius is measured from the bounding-box center of the other
 * two axes. Returns [{z, x}...] (z = position along the detected length
 * axis, x = radius), ordered by position ascending.
 */
// Max plausible diameter-to-length ratio for the short-axis fallback below
// (a disc-shaped turned part - a hub, pulley, washer, flange) before it's
// almost certainly actually flat sheet stock instead. Real hubs/pulleys/
// washers/flanges are rarely more than a few times wider than they are
// thick (found examples: a set-screw hub at ~2.2:1, a V-belt pulley at
// ~3:1); a genuine routed flat plate is typically well past 10:1, often
// 20-100:1. 8 sits comfortably in the gap, generous to legitimate large
// thin discs without accepting an obviously-flat plate through this path.
const MAX_DISC_DIAMETER_TO_LENGTH_RATIO = 8;
// This is an early bounding-box rejection only. The radial-symmetry check
// below is the actual operation guard; it deliberately refuses finished
// polygonal geometry until an explicit raw-stock workflow exists.
const MIN_TURNING_CROSS_SECTION_ASPECT = 0.75;
const TURNING_SYMMETRY_ANGLE_BINS = 64;
const MIN_TURNING_RADIAL_SYMMETRY = 0.99;
const MAX_NON_SYMMETRIC_TURNING_SLICES = 0.06;

/**
 * Picks which bounding-box axis is the part's true rotational axis, trying
 * the largest-span axis first (the common case: an elongated shaft/bar is
 * always much longer than it is wide) and falling back to the SMALLEST-span
 * axis (a short, wide, disc-shaped turned part - a hub, pulley, washer,
 * flange - where the true axial length is the SHORT dimension, not the
 * long one; its diameter, not its thickness, is what dominates the
 * bounding box). Real bug this fixes: "largest span = length" alone
 * rejected a real V-belt pulley and a real set-screw hub as "not a turned
 * part" - both are completely ordinary lathe parts, just wider than they
 * are long, which the largest-span-only heuristic never considered.
 *
 * Returns the accepted candidate's axis assignment, or null if neither the
 * largest-span nor the smallest-span axis produces a plausible preliminary
 * turned-part cross-section (see crossSectionAspect below). The caller then
 * applies its stricter radial-symmetry guard before accepting it. If neither
 * axis is plausible, the caller reports the largest-span candidate's numbers
 * (the "primary"/expected hypothesis for a typical shaft-like part).
 */
export function pickLengthAxis(spans) {
  const axes = ['x', 'y', 'z'];
  const bySpan = [...axes].sort((a, b) => spans[b] - spans[a]);
  const candidates = [bySpan[0]]; // largest span
  if (bySpan[2] !== bySpan[0]) candidates.push(bySpan[2]); // smallest span, if distinct (skips a perfect-cube tie)

  let primary = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const lengthAxis = candidates[i];
    const [radiusAxisA, radiusAxisB] = axes.filter((a) => a !== lengthAxis);
    const radiusAxisSpanA = spans[radiusAxisA];
    const radiusAxisSpanB = spans[radiusAxisB];
    // Preliminary sanity check: a real rotational part is roughly as wide
    // in one off-axis direction as the other, while a flat plate has one
    // drastically smaller off-axis extent. This fast check rejects obvious
    // plates; the stricter radial-symmetry check in the caller rejects
    // non-rotational shapes that happen to have a square-ish bounding box.
    const crossSectionAspect = Math.min(radiusAxisSpanA, radiusAxisSpanB) / Math.max(radiusAxisSpanA, radiusAxisSpanB);
    const candidate = { lengthAxis, radiusAxisA, radiusAxisB, radiusAxisSpanA, radiusAxisSpanB, crossSectionAspect };
    if (i === 0) primary = candidate; // always the largest-span attempt, for the error message below

    if (crossSectionAspect < MIN_TURNING_CROSS_SECTION_ASPECT) continue;
    if (i === 0) return candidate; // largest-span candidate passed outright - the common, unambiguous case

    // The smallest-span candidate passed the roundness bar too, but that
    // alone can't distinguish a genuine disc from a same-proportioned
    // square/rectangular PLATE (a circle and a square share the exact same
    // bounding box) - the diameter-to-length ratio is what actually
    // separates "ordinary hub/pulley/washer" from "obviously flat sheet
    // stock that happens to be square-ish," so gate the fallback on it.
    const approxMaxRadius = Math.hypot(radiusAxisSpanA / 2, radiusAxisSpanB / 2);
    const length = spans[lengthAxis];
    if (approxMaxRadius * 2 / length <= MAX_DISC_DIAMETER_TO_LENGTH_RATIO) return candidate;
  }
  return null; // neither candidate worked - let the caller report the primary (largest-span) attempt's numbers
}

export function extractTurningProfileFromMeshes(meshes, { buckets = 300 } = {}) {
  const bbox = meshesBoundingBox(meshes);
  const spans = {
    x: bbox.maxX - bbox.minX,
    y: bbox.maxY - bbox.minY,
    z: bbox.maxZ - bbox.minZ
  };

  const lengthMinByAxis = { x: bbox.minX, y: bbox.minY, z: bbox.minZ };
  const lengthMaxByAxis = { x: bbox.maxX, y: bbox.maxY, z: bbox.maxZ };
  const primaryLengthAxis = Object.keys(spans).reduce((a, b) => (spans[b] > spans[a] ? b : a));
  if (!Number.isFinite(lengthMinByAxis[primaryLengthAxis]) || !Number.isFinite(lengthMaxByAxis[primaryLengthAxis]) || lengthMaxByAxis[primaryLengthAxis] <= lengthMinByAxis[primaryLengthAxis]) {
    throw new Error('STEP geometry has no usable extent for a turning profile');
  }

  const picked = pickLengthAxis(spans);
  if (!picked) {
    const [radiusAxisA, radiusAxisB] = ['x', 'y', 'z'].filter((a) => a !== primaryLengthAxis);
    throw new Error(
      `This doesn't look like a turned part: cross-section is ${radiusAxisA.toUpperCase()}=${spans[radiusAxisA].toFixed(3)}" by ${radiusAxisB.toUpperCase()}=${spans[radiusAxisB].toFixed(3)}" ` +
      `at its widest - too flat/rectangular for bar stock (turning needs a roughly round/hex/square cross-section, not a plate). This looks like a routed/milled flat part instead.`
    );
  }
  const { lengthAxis, radiusAxisA, radiusAxisB } = picked;
  const lengthMin = lengthMinByAxis[lengthAxis];
  const lengthMax = lengthMaxByAxis[lengthAxis];
  const centerA = (lengthMinByAxis[radiusAxisA] + lengthMaxByAxis[radiusAxisA]) / 2;
  const centerB = (lengthMinByAxis[radiusAxisB] + lengthMaxByAxis[radiusAxisB]) / 2;

  const li = AXIS_INDEX[lengthAxis], ai = AXIS_INDEX[radiusAxisA], bi = AXIS_INDEX[radiusAxisB];
  const bucketSize = (lengthMax - lengthMin) / buckets;
  const maxRadiusByBucket = new Array(buckets + 1).fill(-1);
  const maxRadiusByAngle = Array.from(
    { length: buckets + 1 },
    () => new Array(TURNING_SYMMETRY_ANGLE_BINS).fill(-1)
  );

  function sample(lengthPos, axisA, axisB) {
    const bucket = Math.min(buckets, Math.max(0, Math.round((lengthPos - lengthMin) / bucketSize)));
    const centeredA = axisA - centerA;
    const centeredB = axisB - centerB;
    const radius = Math.hypot(centeredA, centeredB);
    if (radius > maxRadiusByBucket[bucket]) maxRadiusByBucket[bucket] = radius;
    if (radius > 1e-9) {
      const angle = (Math.atan2(centeredB, centeredA) + Math.PI * 2) % (Math.PI * 2);
      const angleBucket = Math.min(TURNING_SYMMETRY_ANGLE_BINS - 1, Math.floor(angle / (Math.PI * 2) * TURNING_SYMMETRY_ANGLE_BINS));
      if (radius > maxRadiusByAngle[bucket][angleBucket]) maxRadiusByAngle[bucket][angleBucket] = radius;
    }
  }

  for (const mesh of meshes) {
    const pos = mesh.attributes.position.array;
    for (let i = 0; i < pos.length; i += 3) {
      sample(pos[i + li], pos[i + ai], pos[i + bi]);
    }

    // Also walk every triangle edge and interpolate extra samples along it
    // at roughly bucket resolution, not just its two endpoints. A straight
    // cylindrical run of real bar stock can be tessellated with very few
    // vertices (a flat surface doesn't need many to represent accurately),
    // while a small local feature - e.g. a cross-drilled retention-pin hole
    // - injects a dense vertex cluster right at its own axial position,
    // including vertices on the hole's own near-zero-radius surface. Without
    // this, a fine length-bucket landing in the gap between two sparse OD
    // vertices could end up containing ONLY that hole's inner-surface
    // vertices and nothing from the actual OD, reporting a false near-zero
    // "max radius" there. Found against a real "Vortex Shaft" STEP file: the
    // profile showed the shaft necking down to a literal 0.0000" radius
    // mid-shaft, sandwiched between ~0.27"-radius readings on both sides -
    // which would have cut a phantom groove into solid material. Most of the
    // OD surface at any given length position is still intact even where a
    // narrow cross-hole interrupts part of the circumference, so sampling
    // along OD edges recovers the true envelope; the hole's own low-radius
    // samples simply lose the per-bucket max to the real OD samples now
    // present in the same bucket.
    const idx = mesh.index.array;
    for (let t = 0; t < idx.length; t += 3) {
      for (let e = 0; e < 3; e += 1) {
        const v1 = idx[t + e] * 3;
        const v2 = idx[t + ((e + 1) % 3)] * 3;
        const l1 = pos[v1 + li], l2 = pos[v2 + li];
        const span = Math.abs(l2 - l1);
        if (span <= bucketSize) continue; // endpoints alone already cover this edge's bucket(s)
        const steps = Math.min(1000, Math.ceil(span / bucketSize));
        const a1 = pos[v1 + ai], b1 = pos[v1 + bi];
        const a2 = pos[v2 + ai], b2 = pos[v2 + bi];
        for (let s = 1; s < steps; s += 1) {
          const frac = s / steps;
          const lengthPos = l1 + frac * (l2 - l1);
          sample(lengthPos, a1 + frac * (a2 - a1), b1 + frac * (b2 - b1));
        }
      }
    }
  }

  const profile = [];
  for (let b = 0; b <= buckets; b += 1) {
    if (maxRadiusByBucket[b] < 0) continue; // no geometry sampled at this position
    profile.push({ z: lengthMin + b * bucketSize, x: maxRadiusByBucket[b] });
  }
  if (profile.length < 2) {
    throw new Error('Not enough geometry variation along the detected length axis to build a turning profile - is this really a lathe part?');
  }

  // A bounding box alone cannot tell a turned body from a folded bracket:
  // both can look roughly square across one candidate axis. Compare the
  // largest available radius around the proposed spindle axis in angular
  // bins. Cylinders and cones remain close to radially uniform; brackets,
  // gears, and other one-sided shapes have angular variation. Inner or
  // cross-drilled features only lower a local radius, so this uses the outer
  // radius in each bin and tolerates a minority of affected slices.
  let symmetrySlices = 0;
  let nonSymmetricSlices = 0;
  const requiredAngleBins = Math.ceil(TURNING_SYMMETRY_ANGLE_BINS * 0.25);
  for (let bucket = 1; bucket < buckets; bucket += 1) {
    const radii = maxRadiusByAngle[bucket].filter((radius) => radius >= 0);
    if (radii.length < requiredAngleBins) continue;
    symmetrySlices += 1;
    if (Math.min(...radii) < Math.max(...radii) * MIN_TURNING_RADIAL_SYMMETRY) nonSymmetricSlices += 1;
  }
  if (symmetrySlices >= 8 && nonSymmetricSlices / symmetrySlices > MAX_NON_SYMMETRIC_TURNING_SLICES) {
    throw new Error(
      `This doesn't look like a turned part: ${nonSymmetricSlices} of ${symmetrySlices} sampled cross-sections are not radially symmetric ` +
      `around the detected ${lengthAxis.toUpperCase()} spindle axis. Check this is a solid of revolution, not a gear, bracket, tube, or assembly.`
    );
  }

  // Sanity check: for the PRIMARY (largest-span-as-length) path only, a real
  // turned part's max radius should be meaningfully smaller than half its
  // length (it's an elongated shaft, not a disc) - if not, the "long axis"
  // heuristic likely picked the wrong axis for this geometry. Does NOT apply
  // to the short-axis fallback path (see pickLengthAxis) - that path exists
  // specifically for disc-shaped turned parts (a hub, pulley, washer,
  // flange) where maxRadius comfortably exceeding half the (short) length
  // is the expected, correct shape, not a red flag; pickLengthAxis already
  // has its own appropriate diameter-to-length guard for that path.
  //
  // Threshold is length/2, not length: since `length` is defined as the
  // single largest bounding-box axis span and `maxRadius` is computed from
  // the other two (necessarily smaller-or-equal) axes via hypot of their
  // half-spans, maxRadius is mathematically bounded at length/sqrt(2) =~
  // 0.707*length whenever the axis choice is even plausible - `maxRadius >
  // length` can never actually be true, which made an earlier version of
  // this check unreachable dead code despite its own comment already
  // describing a length/2 threshold. Found via a synthetic test that could
  // not be made to fail no matter what geometry it was given.
  const maxRadius = Math.max(...profile.map((p) => p.x));
  const length = lengthMax - lengthMin;
  if (lengthAxis === primaryLengthAxis && maxRadius > length / 2) {
    throw new Error(
      `This doesn't look like a turned part: detected length ${length.toFixed(3)}" along the "${lengthAxis}" axis ` +
      `but max radius ${maxRadius.toFixed(3)}" - too wide relative to its length for a shaft. Check the STEP file is a single lathe part, not an assembly or a non-axisymmetric shape.`
    );
  }

  return profile;
}

/**
 * Transforms raw STEP mesh vertices (native CAD coordinates) into the
 * turning 3D sim's scene coordinates, for the "show the source part"
 * ghost overlay (docs/toolpath-simulation-plan.md Phase 5). Reuses
 * pickLengthAxis so this can never disagree with what
 * extractTurningProfileFromMeshes itself picked for the same file.
 *
 * Unlike the toolpath's own 2D diameter-mode projection (which collapses
 * the radial plane down to a signed radius, discarding angle - see
 * projectTurningToolpath in toolpathPreview.js), this keeps the true 3D
 * shape: scene x = axial position (matches turning.js's own
 * zOrigin-at-the-face normalization exactly), scene y/z = the real
 * radial-plane position, not a collapsed radius. A genuinely turned part
 * is axisymmetric anyway (or extraction would have rejected it), so this
 * reads as a clean round solid once rendered - any residual real-world
 * asymmetry within the extractor's tolerance shows up honestly instead of
 * being hidden.
 *
 * @returns {Array<{position: Float32Array, index: Uint32Array|null}>}
 */
export function transformMeshesForTurningScene(meshes) {
  const bbox = meshesBoundingBox(meshes);
  const spans = { x: bbox.maxX - bbox.minX, y: bbox.maxY - bbox.minY, z: bbox.maxZ - bbox.minZ };
  const picked = pickLengthAxis(spans);
  if (!picked) {
    throw new Error('Could not determine a spindle axis for this part - same check as extractTurningProfileFromMeshes');
  }
  const { lengthAxis, radiusAxisA, radiusAxisB } = picked;
  const lengthMinByAxis = { x: bbox.minX, y: bbox.minY, z: bbox.minZ };
  const lengthMaxByAxis = { x: bbox.maxX, y: bbox.maxY, z: bbox.maxZ };
  const lengthMin = lengthMinByAxis[lengthAxis];
  const centerA = (lengthMinByAxis[radiusAxisA] + lengthMaxByAxis[radiusAxisA]) / 2;
  const centerB = (lengthMinByAxis[radiusAxisB] + lengthMaxByAxis[radiusAxisB]) / 2;
  const li = AXIS_INDEX[lengthAxis], ai = AXIS_INDEX[radiusAxisA], bi = AXIS_INDEX[radiusAxisB];

  return meshes.map((mesh) => {
    const src = mesh.attributes.position.array;
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      out[i] = lengthMin - src[i + li];
      out[i + 1] = src[i + ai] - centerA;
      out[i + 2] = src[i + bi] - centerB;
    }
    return { position: out, index: mesh.index?.array || null };
  });
}

function faceTriangleRange(mesh, brepFace) {
  // brep_faces gives inclusive triangle index ranges into mesh.index.array.
  const tris = [];
  for (let t = brepFace.first; t <= brepFace.last; t += 1) {
    tris.push([triangleVertex(mesh, t, 0), triangleVertex(mesh, t, 1), triangleVertex(mesh, t, 2)]);
  }
  return tris;
}

function triangleNormalAndArea(a, b, c) {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  return { normal: len > 0 ? { x: nx / len, y: ny / len, z: nz / len } : { x: 0, y: 0, z: 0 }, area: len / 2 };
}

// Finds the largest-area face (in ANY orientation) whose triangles are all
// genuinely coplanar (same normal, within tolerance) - the flat top/bottom
// of an extruded sheet part, whichever way the part happens to be modeled.
function findLargestPlanarFace(mesh) {
  let best = null;
  for (const brepFace of mesh.brep_faces || []) {
    const tris = faceTriangleRange(mesh, brepFace);
    if (tris.length === 0) continue;
    let area = 0;
    let refNormal = null;
    let planar = true;
    for (const [a, b, c] of tris) {
      const { normal, area: triArea } = triangleNormalAndArea(a, b, c);
      if (normal.x === 0 && normal.y === 0 && normal.z === 0) continue; // degenerate triangle
      if (!refNormal) {
        refNormal = normal;
      } else {
        const dot = normal.x * refNormal.x + normal.y * refNormal.y + normal.z * refNormal.z;
        if (dot < 0.999) { planar = false; break; }
      }
      area += triArea;
    }
    if (!planar || !refNormal) continue;
    if (!best || area > best.area) best = { brepFace, area, tris, normal: refNormal, point: tris[0][0] };
  }
  return best;
}

function edgeKey(vi1, vi2) {
  return vi1 < vi2 ? `${vi1}_${vi2}` : `${vi2}_${vi1}`;
}

// Builds an orthonormal 2D basis (u, v) lying in the plane perpendicular to `normal`.
function planeBasis(normal) {
  const ref = Math.abs(normal.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const ux0 = ref.y * normal.z - ref.z * normal.y;
  const uy0 = ref.z * normal.x - ref.x * normal.z;
  const uz0 = ref.x * normal.y - ref.y * normal.x;
  const uLen = Math.hypot(ux0, uy0, uz0) || 1;
  const u = { x: ux0 / uLen, y: uy0 / uLen, z: uz0 / uLen };
  const v = {
    x: normal.y * u.z - normal.z * u.y,
    y: normal.z * u.x - normal.x * u.z,
    z: normal.x * u.y - normal.y * u.x
  };
  return { u, v };
}

function project(point, origin, u, v) {
  const dx = point.x - origin.x, dy = point.y - origin.y, dz = point.z - origin.z;
  return { x: dx * u.x + dy * u.y + dz * u.z, y: dx * v.x + dy * v.y + dz * v.z };
}

// Traces the boundary of a set of triangles into closed loops of 2D points
// (via the supplied projector), by finding edges used by exactly one
// triangle (the outer/inner silhouette of a planar triangulated region) and
// chaining them. Assumes a well-formed planar region: every boundary vertex
// touches exactly two boundary edges (true for an outline + separate,
// non-touching holes).
function traceBoundaryLoops(tris, projectPoint) {
  const edgeCount = new Map();
  const edgeVertPair = new Map(); // key -> [viA, viB]
  const pointByIndex = new Map(); // vi -> {x, y}

  for (const tri of tris) {
    for (let i = 0; i < 3; i += 1) {
      const a = tri[i], b = tri[(i + 1) % 3];
      pointByIndex.set(a.vi, projectPoint(a));
      pointByIndex.set(b.vi, projectPoint(b));
      const key = edgeKey(a.vi, b.vi);
      edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
      if (!edgeVertPair.has(key)) edgeVertPair.set(key, [a.vi, b.vi]);
    }
  }

  const adjacency = new Map(); // vi -> [neighborVi, ...] (boundary-only)
  for (const [key, count] of edgeCount.entries()) {
    if (count !== 1) continue;
    const [aVi, bVi] = edgeVertPair.get(key);
    if (!adjacency.has(aVi)) adjacency.set(aVi, []);
    if (!adjacency.has(bVi)) adjacency.set(bVi, []);
    adjacency.get(aVi).push(bVi);
    adjacency.get(bVi).push(aVi);
  }

  const visited = new Set();
  const loops = [];
  for (const startVi of adjacency.keys()) {
    if (visited.has(startVi)) continue;
    const loopIndices = [startVi];
    visited.add(startVi);
    let prevVi = null;
    let curVi = startVi;
    while (true) {
      const neighbors = adjacency.get(curVi) || [];
      const nextVi = neighbors.find((n) => n !== prevVi);
      if (nextVi === undefined || nextVi === startVi) break;
      loopIndices.push(nextVi);
      visited.add(nextVi);
      prevVi = curVi;
      curVi = nextVi;
    }
    if (loopIndices.length >= 3) {
      loops.push(loopIndices.map((vi) => pointByIndex.get(vi)));
    }
  }
  return loops;
}

function signedArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i], b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

// This extractor is deliberately a sheet-profile router path, not general
// 3-axis milling. Limiting stock thickness relative to the smaller profile
// dimension prevents a cube, shaft, pulley, or other solid from being
// accepted merely because one of its planar faces happens to be the largest.
const MAX_ROUTING_THICKNESS_TO_MIN_PROFILE_SPAN = 0.25;

/**
 * Routing: finds the largest flat face (in any orientation), traces its
 * boundary into outer + hole loops projected into that face's own plane,
 * and reads thickness as the part's full extent along the face's normal.
 * Returns { contours: [{points, isHole}], thickness }.
 */
export function extractRoutingContoursFromMeshes(meshes) {
  let best = null;
  for (const mesh of meshes) {
    const candidate = findLargestPlanarFace(mesh);
    if (candidate && (!best || candidate.area > best.area)) best = { ...candidate, mesh };
  }
  if (!best) {
    throw new Error('No flat face found on this part - is this really a flat routed/laser-cut profile?');
  }

  const { u, v } = planeBasis(best.normal);
  const origin = best.point;
  const loops = traceBoundaryLoops(best.tris, (pt) => project(pt, origin, u, v));
  if (loops.length === 0) {
    throw new Error('Could not trace a boundary outline from this STEP file\'s flat face');
  }

  const withArea = loops.map((points) => ({ points, area: signedArea(points) }));
  withArea.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
  const contours = withArea.map((c, i) => ({ points: c.points, isHole: i > 0 }));

  // Sanity check: does the traced outer contour actually represent the
  // part's full silhouette, or does real geometry extend beyond it that
  // this flat-face trace can't see? A 2.5D router profile can only capture
  // material reachable from ONE flat face straight through the part's
  // thickness - it has no way to represent a stepped/relieved edge or a
  // curved surface (like gear/sprocket teeth) that isn't part of that same
  // flat plane. Without this check, such geometry just silently vanishes:
  // found against a real 32-tooth sprocket STEP file where the chosen flat
  // face stopped at the tooth ROOT relief (radius 1.125" from its own
  // centroid) while the actual tooth TIPS - non-planar surfaces entirely
  // outside that face - reached out to 1.345", almost 20% further. The
  // traced contour became a plain circular disc with zero indication a
  // third of the profile (the teeth) had been dropped.
  //
  // Measured as the ratio of the farthest any mesh vertex projects (in the
  // same face-relative plane, from the outer contour's own centroid) versus
  // the outer contour's own farthest point. Ordinary edge treatments
  // (fillets, chamfers, a bent bracket's angled flange) read at ~1.0-1.06
  // against every real fixture on hand; the sprocket's dropped teeth read
  // at 1.196 - the 1.1 threshold sits with real margin on both sides.
  const outerPoints = contours[0].points;
  let outerCx = 0, outerCy = 0;
  for (const p of outerPoints) { outerCx += p.x; outerCy += p.y; }
  outerCx /= outerPoints.length; outerCy /= outerPoints.length;
  const outerMaxR = Math.max(...outerPoints.map((p) => Math.hypot(p.x - outerCx, p.y - outerCy)));

  let meshMaxR = 0;
  for (const mesh of meshes) {
    const pos = mesh.attributes.position.array;
    for (let i = 0; i < pos.length; i += 3) {
      const proj = project({ x: pos[i], y: pos[i + 1], z: pos[i + 2] }, origin, u, v);
      const r = Math.hypot(proj.x - outerCx, proj.y - outerCy);
      if (r > meshMaxR) meshMaxR = r;
    }
  }
  if (meshMaxR > outerMaxR * 1.1) {
    throw new Error(
      `This part has geometry beyond the flat face used to trace its outline (real geometry reaches ${meshMaxR.toFixed(3)}" ` +
      `from center vs ${outerMaxR.toFixed(3)}" for the traced face) - likely a stepped/relieved edge or curved features ` +
      `(e.g. gear/sprocket teeth) that a flat 2.5D routing profile can't represent. Check this is a simple flat part.`
    );
  }

  // Thickness = the part's full extent along the flat face's normal - i.e.
  // the perpendicular distance from this face to the opposite (parallel)
  // face, regardless of which world axis that direction happens to be.
  //
  // Measured only on best.mesh (the body the chosen face actually belongs
  // to), not every mesh in the file - a STEP export can legitimately bundle
  // more than one body (a bracket plus its mounting screws, in a real
  // REV-21-2046 file that surfaced this: 3 meshes, 2 of them small fastener
  // bodies). Scanning all meshes let unrelated hardware silently inflate or
  // shrink the measured thickness whenever it extended further along the
  // face normal than the actual part being routed.
  let minD = Infinity, maxD = -Infinity;
  const pos = best.mesh.attributes.position.array;
  for (let i = 0; i < pos.length; i += 3) {
    const dx = pos[i] - origin.x, dy = pos[i + 1] - origin.y, dz = pos[i + 2] - origin.z;
    const d = dx * best.normal.x + dy * best.normal.y + dz * best.normal.z;
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
  }
  const thickness = Number.isFinite(minD) && Number.isFinite(maxD) ? maxD - minD : null;
  // origin sits ON the found face (best.point is one of its own vertices),
  // so the material's bulk is whichever side of minD/maxD is NOT ~0 - used
  // by transformMeshesForRoutingScene to know which way "into the material"
  // points, matching routing.js's own Z0-at-the-face/cuts-go-negative
  // convention regardless of which raw direction best.normal happens to
  // point in this particular STEP file.
  const materialSign = Number.isFinite(minD) && Number.isFinite(maxD) && Math.abs(maxD) < Math.abs(minD) ? -1 : 1;

  // Sanity check: minD/maxD is only real material thickness if the far
  // extreme is the depth of a genuine, roughly-parallel "bottom" face - not
  // just the farthest point some unrelated, non-parallel wall happens to
  // reach. Real bug found against mounting-bracket-bent.step (REV-41-1623,
  // an already-bent/formed sheet metal bracket, not a flat pattern): its
  // base flange's real bottom face sits at ~20% of the measured range (true
  // thickness ~0.118", matching its flat sibling mounting-bracket-flat.step
  // almost exactly) - but a bent-up wall (normal roughly PERPENDICULAR to
  // best.normal, not parallel) reaches further, to 100% of the range,
  // pulling the far extreme out to 0.591" with no real face backing it -
  // would have told the router to cut ~5x deeper than the actual material.
  //
  // Checked by looking for a second large B-rep face whose normal is
  // roughly ANTI-PARALLEL to best.normal (a genuine opposite/parallel face,
  // not a perpendicular wall) sitting near either extreme - best.mesh's own
  // winning face sits at depth 0 by construction (origin = best.point, a
  // point ON that face), so whichever of minD/maxD isn't ~0 is the "far"
  // side, and which one that is depends on which way best.normal happens to
  // point; checking both bands is simplest and safe, since the winning face
  // itself (alignment +1) can never satisfy the anti-parallel test. A plain
  // "is there area at an intermediate depth" check isn't enough here - it
  // falsely flagged every multi-hole plate on hand (flat-plate.step,
  // multibody-bracket.step, etc.): even a genuinely flat part's own outer
  // perimeter and hole walls are thin strips spanning the *entire* 0..
  // thickness range by construction, averaging to the middle depth same as
  // a real bent wall would - that signal can't tell them apart. Checking
  // face *orientation* at the extremes can: a real bottom face is
  // anti-parallel to the top; a bent wall's face is perpendicular to it.
  if (thickness !== null && thickness > 0) {
    const band = thickness * 0.15;
    let hasParallelFarFace = false;
    for (const brepFace of best.mesh.brep_faces || []) {
      const tris = faceTriangleRange(best.mesh, brepFace);
      if (tris.length === 0) continue;
      let faceArea = 0;
      let refNormal = null;
      let planar = true;
      let depthSum = 0;
      for (const [a, b, c] of tris) {
        const { normal, area: triArea } = triangleNormalAndArea(a, b, c);
        if (normal.x === 0 && normal.y === 0 && normal.z === 0) continue;
        if (!refNormal) refNormal = normal;
        else if (normal.x * refNormal.x + normal.y * refNormal.y + normal.z * refNormal.z < 0.999) planar = false;
        faceArea += triArea;
        for (const p of [a, b, c]) {
          depthSum += (p.x - origin.x) * best.normal.x + (p.y - origin.y) * best.normal.y + (p.z - origin.z) * best.normal.z;
        }
      }
      if (!planar || !refNormal || faceArea < best.area * 0.2) continue;
      const avgDepth = depthSum / (tris.length * 3);
      const alignment = refNormal.x * best.normal.x + refNormal.y * best.normal.y + refNormal.z * best.normal.z;
      const nearMin = avgDepth <= minD + band;
      const nearMax = avgDepth >= maxD - band;
      if ((nearMin || nearMax) && alignment < -0.9) { hasParallelFarFace = true; break; }
    }
    if (!hasParallelFarFace) {
      throw new Error(
        `This part has no face parallel to its flat face at the far end of the measured thickness ` +
        `(${thickness.toFixed(3)}") - likely a bent flange or wall being measured as material thickness, not a ` +
        `genuine opposite face. Check this is a flat pattern, not an already-formed/bent part.`
      );
    }
  }

  // A genuine routed sheet has a distinctly thin axis. Without this guard,
  // a thick solid with a large planar face can produce a superficially valid
  // perimeter program while omitting features on the other faces. This is a
  // rejection, rather than a guess at a different machining operation.
  const minProfileX = Math.min(...outerPoints.map((p) => p.x));
  const maxProfileX = Math.max(...outerPoints.map((p) => p.x));
  const minProfileY = Math.min(...outerPoints.map((p) => p.y));
  const maxProfileY = Math.max(...outerPoints.map((p) => p.y));
  const minProfileSpan = Math.min(maxProfileX - minProfileX, maxProfileY - minProfileY);
  if (thickness !== null && minProfileSpan > 0 && thickness > minProfileSpan * MAX_ROUTING_THICKNESS_TO_MIN_PROFILE_SPAN) {
    throw new Error(
      `This part is too thick for the sheet-profile router operation: measured thickness ${thickness.toFixed(3)}" ` +
      `is over ${(MAX_ROUTING_THICKNESS_TO_MIN_PROFILE_SPAN * 100).toFixed(0)}% of its smaller profile span ${minProfileSpan.toFixed(3)}". ` +
      'Use a thin flat pattern, or a milling/turning operation for a solid part.'
    );
  }

  return { contours, thickness, frame: { origin: best.point, normal: best.normal, u, v, materialSign } };
}

/**
 * Transforms raw STEP mesh vertices into the routing 3D sim's scene
 * coordinates, for the "show the source part" ghost overlay
 * (docs/toolpath-simulation-plan.md Phase 5). Takes the `frame` that
 * extractRoutingContoursFromMeshes already returned for this same file -
 * pass it straight through - so the ghost part can never disagree with the
 * contours actually fed to generateRoutingGcode.
 *
 * scene x/y = the face-plane u/v basis, matching the routing G-code's own
 * X/Y directly (project() in this file uses the exact same u/v dot
 * products for the 2D contour points). scene z = depth into the material,
 * negative - matches both the sim's "Z is depth, negative into the
 * material" scene convention and routing.js's own Z0-at-the-face
 * convention.
 *
 * @returns {Array<{position: Float32Array, index: Uint32Array|null}>}
 */
export function transformMeshesForRoutingScene(meshes, frame) {
  const { origin, normal, u, v, materialSign } = frame;
  return meshes.map((mesh) => {
    const src = mesh.attributes.position.array;
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      const dx = src[i] - origin.x;
      const dy = src[i + 1] - origin.y;
      const dz = src[i + 2] - origin.z;
      const d = dx * normal.x + dy * normal.y + dz * normal.z;
      out[i] = dx * u.x + dy * u.y + dz * u.z;
      out[i + 1] = dx * v.x + dy * v.y + dz * v.z;
      out[i + 2] = -materialSign * d;
    }
    return { position: out, index: mesh.index?.array || null };
  });
}

// Minimum face area, as a fraction of the largest wall candidate found, to
// count as a real tube wall rather than a small chamfer/fillet/machining
// relief sliver that happens to be flat and roughly the right orientation.
const MIN_TUBE_WALL_AREA_FRACTION = 0.3;
// How aligned a face's normal must be with a cross-section axis (dot
// product, 1.0 = perfect) to count as that axis's wall - generous enough for
// real STEP tessellation noise, tight enough to reject anything not close to
// axis-aligned.
const TUBE_WALL_ALIGNMENT_THRESHOLD = 0.9;
// Real drilled holes tessellate as a clean circle - each boundary point sits
// within this fraction of the mean radius from center. A slot, keyway, or
// other non-round feature would read well outside this and must be rejected
// rather than silently treated as "a hole of the average radius," which
// would program the wrong tool/position for indexed drilling.
const MAX_HOLE_RADIUS_VARIATION = 0.15;

/**
 * Tube stock (rectangular/square tube): finds the tube's long axis and
 * outer cross-section, then the up to 4 flat side walls (faces whose normal
 * is perpendicular to the long axis), and traces each wall's own hole
 * pattern the same way extractRoutingContoursFromMeshes traces a flat
 * plate's holes (a hole is just an inner boundary loop of the wall's own
 * face tessellation - no separate cylindrical-surface detection needed).
 *
 * Scope, deliberately: axis-aligned rectangular/square tube only (the STEP
 * file's own X/Y/Z, not an arbitrary rotation - matches how turning's axis
 * detection also tries X/Y/Z directly rather than solving for an arbitrary
 * orientation), round holes only (see MAX_HOLE_RADIUS_VARIATION), drilled
 * straight through a single wall (not through both walls of the tube at
 * once, not angled). Round tube and non-round hole features are rejected,
 * not guessed at - this feeds indexed-drilling G-code for a real machine,
 * same reasoning as every other rejection-over-guessing check in this file.
 *
 * Returns { lengthAxis, tubeLength, crossSection: {a, b} (outer width along
 * the two cross-section axes), walls: [{ angleDeg, holes: [{position,
 * diameter}, ...] }, ...] } - walls sorted by angleDeg ascending, holes
 * within a wall sorted by position ascending. angleDeg is a rotary-axis
 * angle around lengthAxis (0/90/180/270 for a square tube's 4 faces,
 * measured so the two cross-section axes are 0deg and 90deg respectively -
 * ready to feed straight into tubestock.js's indexed drilling without the
 * caller needing to know which world axis was which.
 */
export function extractTubeFeaturesFromMeshes(meshes) {
  const bbox = meshesBoundingBox(meshes);
  const spans = {
    x: bbox.maxX - bbox.minX,
    y: bbox.maxY - bbox.minY,
    z: bbox.maxZ - bbox.minZ
  };
  const axes = ['x', 'y', 'z'];
  const lengthAxis = axes.reduce((a, b) => (spans[b] > spans[a] ? b : a));
  const [axisA, axisB] = axes.filter((a) => a !== lengthAxis);
  const li = AXIS_INDEX[lengthAxis], ai = AXIS_INDEX[axisA], bi = AXIS_INDEX[axisB];
  const lengthMinByAxis = { x: bbox.minX, y: bbox.minY, z: bbox.minZ };
  const tubeLength = spans[lengthAxis];
  if (!Number.isFinite(tubeLength) || tubeLength <= 0) {
    throw new Error('STEP geometry has no usable extent for tube stock');
  }

  // Work on the single largest mesh by vertex count - same reasoning as
  // extractRoutingContoursFromMeshes scoping thickness to best.mesh: a real
  // STEP export can legitimately bundle small unrelated hardware (fasteners)
  // alongside the actual tube body in separate meshes.
  let tubeMesh = null;
  for (const mesh of meshes) {
    const count = mesh.attributes.position.array.length;
    if (!tubeMesh || count > tubeMesh.attributes.position.array.length) tubeMesh = mesh;
  }
  if (!tubeMesh) throw new Error('No geometry found');

  const unitAxis = (axis) => ({ x: axis === 'x' ? 1 : 0, y: axis === 'y' ? 1 : 0, z: axis === 'z' ? 1 : 0 });
  const normalA = unitAxis(axisA), normalB = unitAxis(axisB);

  // Collect every planar face whose normal is dominated by +-axisA or
  // +-axisB (a side wall), keeping only the largest-area candidate per
  // direction - a chamfer or machining relief along an edge can also be
  // flat and axis-aligned but is never the real wall.
  const wallByDirection = new Map(); // key: 'A+'|'A-'|'B+'|'B-' -> { area, tris, normal }
  for (const brepFace of tubeMesh.brep_faces || []) {
    const tris = faceTriangleRange(tubeMesh, brepFace);
    if (tris.length === 0) continue;
    let area = 0;
    let refNormal = null;
    let planar = true;
    for (const [a, b, c] of tris) {
      const { normal, area: triArea } = triangleNormalAndArea(a, b, c);
      if (normal.x === 0 && normal.y === 0 && normal.z === 0) continue;
      if (!refNormal) refNormal = normal;
      else if (normal.x * refNormal.x + normal.y * refNormal.y + normal.z * refNormal.z < 0.999) { planar = false; break; }
      area += triArea;
    }
    if (!planar || !refNormal) continue;

    const alongA = refNormal.x * normalA.x + refNormal.y * normalA.y + refNormal.z * normalA.z;
    const alongB = refNormal.x * normalB.x + refNormal.y * normalB.y + refNormal.z * normalB.z;
    let key = null;
    if (Math.abs(alongA) >= TUBE_WALL_ALIGNMENT_THRESHOLD) key = alongA > 0 ? 'A+' : 'A-';
    else if (Math.abs(alongB) >= TUBE_WALL_ALIGNMENT_THRESHOLD) key = alongB > 0 ? 'B+' : 'B-';
    if (!key) continue; // end cap (aligned with lengthAxis) or an odd-angled face - not a side wall

    const existing = wallByDirection.get(key);
    if (!existing || area > existing.area) wallByDirection.set(key, { area, tris, normal: refNormal });
  }

  const maxWallArea = Math.max(0, ...[...wallByDirection.values()].map((w) => w.area));
  const walls = [];
  for (const [key, wall] of wallByDirection.entries()) {
    if (wall.area < maxWallArea * MIN_TUBE_WALL_AREA_FRACTION) continue;

    const origin = { x: bbox.minX, y: bbox.minY, z: bbox.minZ };
    // Wall-local 2D basis: u = along tube length, v = across the wall's own
    // width (the OTHER cross-section axis, not the one this wall's normal
    // points along).
    const isAWall = key[0] === 'A';
    const uAxis = unitAxis(lengthAxis);
    const vAxis = isAWall ? normalB : normalA;
    const wallWidth = isAWall ? spans[axisB] : spans[axisA];
    const loops = traceBoundaryLoops(wall.tris, (pt) => project(pt, origin, uAxis, vAxis));
    if (loops.length === 0) continue;

    const withArea = loops.map((points) => ({ points, area: Math.abs(signedArea(points)) }));
    withArea.sort((a, b) => b.area - a.area);
    // First (largest) loop is the wall's own outer rectangle - not a hole.
    const holeLoops = withArea.slice(1);

    const holes = holeLoops.map(({ points }) => {
      let cu = 0, cv = 0;
      for (const p of points) { cu += p.x; cv += p.y; }
      cu /= points.length; cv /= points.length;
      const radii = points.map((p) => Math.hypot(p.x - cu, p.y - cv));
      const meanRadius = radii.reduce((s, r) => s + r, 0) / radii.length;
      const maxDeviation = Math.max(...radii.map((r) => Math.abs(r - meanRadius) / meanRadius));
      if (maxDeviation > MAX_HOLE_RADIUS_VARIATION) {
        throw new Error(
          `A feature on this tube isn't round (radius varies ${(maxDeviation * 100).toFixed(0)}% around its boundary) - ` +
          `likely a slot, keyway, or other non-circular cutout that indexed round-hole drilling can't represent. ` +
          `Check this part only has round holes through its walls.`
        );
      }
      return {
        position: cu - lengthMinByAxis[lengthAxis],
        // Signed offset from the WALL's own centerline (not the loop's raw
        // v-coordinate) - real bug found against a real AndyMark 2"x1" tube
        // fixture (am-5180): the wide (2") face has multiple holes at the
        // SAME position along the tube but different lateral offsets across
        // its width (a real side-by-side hole pair, not a duplicate) - a
        // narrower fixture built by hand never exercised more than one hole
        // per position and never caught that this field was being computed
        // (cv) and then silently dropped, which would have driven every
        // hole on a wide face to the exact same G-code XY, redrilling one
        // spot instead of drilling each real hole.
        lateralOffset: cv - wallWidth / 2,
        diameter: meanRadius * 2
      };
    });
    holes.sort((a, b) => (a.position - b.position) || (a.lateralOffset - b.lateralOffset));

    const angleRad = Math.atan2(
      isAWall ? 0 : (key[1] === '+' ? 1 : -1),
      isAWall ? (key[1] === '+' ? 1 : -1) : 0
    );
    const angleDeg = ((angleRad * 180) / Math.PI + 360) % 360;
    walls.push({ angleDeg, holes });
  }

  if (walls.length === 0) {
    throw new Error(
      `No flat side walls found along this part's length axis - is this round tube, or a cross-section this ` +
      `axis-aligned rectangular-tube extractor can't handle?`
    );
  }
  walls.sort((a, b) => a.angleDeg - b.angleDeg);

  return {
    lengthAxis,
    tubeLength,
    crossSection: { a: spans[axisA], b: spans[axisB] },
    walls
  };
}
