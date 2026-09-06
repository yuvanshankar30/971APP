<script>
  import { onMount, onDestroy } from 'svelte';
  import { fetchStepMeshes, occtMeshesToBufferGeometries } from '$lib/stepMeshLoader.js';

  // Renders an interactive 3D view of a part. Two sources:
  //  - Onshape parts: export to STL through the app's Onshape API.
  //  - Uploaded STEP files: download from storage and parse client-side (occt).
  export let part;                 // needs onshape_* ids for the Onshape path
  export let stepFileName = null;  // storage path in 'manufacturing-files' for uploaded STEP

  let container;
  let loading = true;
  let loadingMsg = 'Loading 3D model…';
  let error = null;
  let depthInches = null;

  let renderer, scene, camera, controls, frameId, resizeObserver;
  let disposed = false;

  const isOnshape = part?.source_type === 'onshape_api';

  function onshapeStlUrl(p) {
    const params = new URLSearchParams({
      action: 'download-stl',
      documentId: p.onshape_document_id,
      elementId: p.onshape_element_id,
      partId: p.onshape_part_id,
      wvm: p.onshape_wvm || 'w',
      wvmId: p.onshape_wvmid
    });
    return `/api/onshape?${params}`;
  }

  // Build a single STL geometry (Onshape path).
  async function loadOnshapeGeometry(THREE, STLLoader) {
    loadingMsg = 'Loading 3D model from Onshape…';
    const res = await fetch(onshapeStlUrl(part));
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Failed to load model (HTTP ${res.status})`);
    }
    const buffer = await res.arrayBuffer();
    const geometry = new STLLoader().parse(buffer);
    geometry.computeVertexNormals();
    return [geometry];
  }

  // Parse an uploaded STEP file into geometries (client-side, occt-import-js).
  async function loadStepGeometries(THREE) {
    loadingMsg = 'Parsing STEP file…';
    const meshes = await fetchStepMeshes(stepFileName);
    return occtMeshesToBufferGeometries(THREE, meshes);
  }

  onMount(() => {
    let cancelled = false;
    (async () => {
      try {
        const THREE = await import('three');
        const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');

        let geometries;
        if (isOnshape) {
          const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
          geometries = await loadOnshapeGeometry(THREE, STLLoader);
        } else if (stepFileName) {
          geometries = await loadStepGeometries(THREE);
        } else {
          throw new Error('No CAD source available for this part.');
        }
        if (cancelled || disposed) return;

        const width = container.clientWidth || 600;
        const height = container.clientHeight || 400;

        const isDark = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'modern-dark';
        scene = new THREE.Scene();
        scene.background = new THREE.Color(isDark ? 0x131109 : 0xf3f4f6);
        camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000000);

        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        container.appendChild(renderer.domElement);

        // Gray, not the brand-gold accent color - this is the actual stock
        // material being viewed, not a highlight/accent element. Matches
        // the same gray + metalness/roughness the 3D toolpath simulator
        // uses for its own stock (autocam/components/ToolpathSimulator.svelte's
        // createStockMaterial) so a part looks the same color whether it's
        // open here or in the toolpath sim.
        const material = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.75, roughness: 0.42 });
        const group = new THREE.Group();
        for (const geometry of geometries) {
          group.add(new THREE.Mesh(geometry, material));
        }
        // Center the group on the origin.
        const box = new THREE.Box3().setFromObject(group);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const spans = [size.x, size.y, size.z].filter((span) => Number.isFinite(span) && span > 1e-6);
        depthInches = spans.length ? Math.min(...spans) : null;
        group.position.sub(center);
        scene.add(group);

        // Frame the camera based on the bounding sphere.
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const r = sphere.radius || 100;
        const dist = r * 2.6;
        camera.position.set(dist, dist * 0.8, dist);
        camera.lookAt(0, 0, 0);

        scene.add(new THREE.AmbientLight(0xffffff, 0.7));
        const key = new THREE.DirectionalLight(0xffffff, 0.9);
        key.position.set(1, 1, 1);
        scene.add(key);
        const fill = new THREE.DirectionalLight(0xffffff, 0.4);
        fill.position.set(-1, -0.5, -1);
        scene.add(fill);

        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.1;

        const animate = () => {
          if (disposed) return;
          frameId = requestAnimationFrame(animate);
          controls.update();
          renderer.render(scene, camera);
        };
        animate();

        resizeObserver = new ResizeObserver(() => {
          if (!renderer || !camera || !container) return;
          const w = container.clientWidth;
          const h = container.clientHeight;
          if (w === 0 || h === 0) return;
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
        });
        resizeObserver.observe(container);

        loading = false;
      } catch (e) {
        console.error('CAD viewer error:', e);
        error = e?.message || 'Could not load the 3D model.';
        loading = false;
      }
    })();

    return () => { cancelled = true; };
  });

  onDestroy(() => {
    disposed = true;
    if (frameId) cancelAnimationFrame(frameId);
    resizeObserver?.disconnect();
    controls?.dispose?.();
    renderer?.dispose?.();
    if (renderer?.domElement?.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
  });
</script>

<div class="cad-viewer" bind:this={container}>
  {#if depthInches}
    <div class="cad-depth" title="Smallest bounding-box dimension of the CAD model">
      <span>Thickness / depth</span>
      <strong>{depthInches.toFixed(depthInches < 0.1 ? 4 : 3)} in</strong>
    </div>
  {/if}
  {#if loading}
    <div class="cad-viewer-overlay">
      <div class="spinner"></div>
      <span>{loadingMsg}</span>
    </div>
  {:else if error}
    <div class="cad-viewer-overlay cad-viewer-error">
      <span>⚠️ {error}</span>
    </div>
  {/if}
</div>

<style>
  .cad-viewer {
    position: relative;
    width: 100%;
    height: 60vh;
    min-height: 320px;
    border-radius: var(--radius-sm, 4px);
    overflow: hidden;
    background: var(--surface-2, #f3f4f6);
  }

  .cad-depth {
    position: absolute;
    left: 0.75rem;
    bottom: 0.75rem;
    z-index: 1;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding: 0.45rem 0.6rem;
    border: 1px solid color-mix(in srgb, var(--border, #d1d5db) 85%, transparent);
    border-radius: var(--radius-sm, 4px);
    background: color-mix(in srgb, var(--surface, #fff) 92%, transparent);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.14);
    color: var(--text-muted, #6b7280);
    font-size: 0.7rem;
    line-height: 1.15;
    pointer-events: none;
  }

  .cad-depth strong {
    color: var(--text, #111827);
    font-size: 0.9rem;
  }

  .cad-viewer-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    color: var(--text-muted, #6b7280);
    font-size: 0.9rem;
    text-align: center;
    padding: 1rem;
  }

  .cad-viewer-error { color: var(--red-strong, #991b1b); }

  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--border, #d1d5db);
    border-top-color: var(--accent, #f1c331);
    border-radius: 50%;
    animation: cad-spin 0.8s linear infinite;
  }

  @keyframes cad-spin { to { transform: rotate(360deg); } }
</style>
