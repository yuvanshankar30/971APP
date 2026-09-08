import { supabase } from '$lib/supabase.js';

/**
 * Fetches a STEP file from Supabase storage and parses it into raw mesh
 * data via occt-import-js (client-side WASM). Shared between
 * CadViewer.svelte (generic part viewer) and ToolpathSimulator.svelte
 * (AutoCAM's "show the source part" ghost overlay - see
 * autocam/docs/toolpath-simulation-plan.md Phase 5) - previously each had
 * its own copy of this fetch-and-parse logic.
 *
 * Returns occt's own raw mesh shape unwrapped - [{attributes:{position,
 * normal?}, index, brep_faces}, ...] - not THREE.BufferGeometry, so a
 * caller that needs to transform vertices first (see
 * autocam/stepProfile.js's scene-transform helpers, which consume exactly
 * this shape - it's the same one extractTurningProfileFromMeshes/
 * extractRoutingContoursFromMeshes already operate on) can do that before
 * building geometry. Use occtMeshesToBufferGeometries below for the
 * simple "just show it" path.
 */
export async function fetchStepMeshes(stepFileName) {
  if (!stepFileName) throw new Error('No STEP file attached.');

  const { data, error: signErr } = await supabase.storage
    .from('manufacturing-files')
    .createSignedUrl(stepFileName, 120);
  let signedUrl = data?.signedUrl;
  if (signErr || !signedUrl) {
    // Filenames are sometimes URL-encoded - retry decoded.
    const retry = await supabase.storage
      .from('manufacturing-files')
      .createSignedUrl(decodeURIComponent(stepFileName), 120);
    if (retry.error || !retry.data?.signedUrl) {
      throw new Error('Could not locate the STEP file in storage.');
    }
    signedUrl = retry.data.signedUrl;
  }

  const fileRes = await fetch(signedUrl);
  if (!fileRes.ok) throw new Error(`Failed to download STEP file (HTTP ${fileRes.status})`);
  return readStepMeshes(new Uint8Array(await fileRes.arrayBuffer()));
}

/**
 * Parses STEP bytes already held by the browser.  Kept separate from the
 * storage download above so an Add Part form can inspect a freshly picked
 * local file before it is uploaded and its stock category is chosen.
 */
export async function readStepMeshes(bytes) {
  if (!bytes?.length) throw new Error('Could not read solid geometry from this STEP file.');

  const occtimportjs = (await import('occt-import-js')).default;
  const wasmUrl = (await import('occt-import-js/dist/occt-import-js.wasm?url')).default;
  const occt = await occtimportjs({ locateFile: () => wasmUrl });

  // linearUnit: 'inch' matches autocam/stepProfile.js's own server-side
  // readStepMeshes() exactly - without it, occt-import-js falls back to its
  // own default unit interpretation, which does not reliably match the
  // inches every AutoCAM generator (turning.js/routing.js) and the 3D sim's
  // scene coordinates already assume. Real bug this fixes: the ghost-part
  // overlay (ToolpathSimulator.svelte, ~Phase 5) rendered a STEP part many
  // times too large relative to the simulated stock before this was added.
  const result = occt.ReadStepFile(bytes, { linearUnit: 'inch' });
  if (!result?.success || !result.meshes?.length) {
    throw new Error('Could not read solid geometry from this STEP file.');
  }
  return result.meshes;
}

/** Wraps raw occt mesh data (see fetchStepMeshes) into THREE.BufferGeometry. */
export function occtMeshesToBufferGeometries(THREE, meshes) {
  return meshes.map((m) => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
    if (m.attributes.normal) {
      geom.setAttribute('normal', new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
    }
    if (m.index) geom.setIndex(new THREE.Uint32BufferAttribute(m.index.array, 1));
    if (!m.attributes.normal) geom.computeVertexNormals();
    return geom;
  });
}
