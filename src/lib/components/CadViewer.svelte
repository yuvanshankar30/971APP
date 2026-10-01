<script>
  import { onMount, onDestroy } from 'svelte';
  import { fetchStepMeshes, occtMeshesToBufferGeometries } from '$lib/stepMeshLoader.js';

  // Renders an interactive 3D view of a part. Two sources:
  //  - Onshape parts: export to STL through the app's Onshape API.
  //  - Uploaded STEP files: download from storage and parse client-side (occt).
  export let part;                 // needs onshape_* ids for the Onshape path
  export let stepFileName = null;  // storage path in 'manufacturing-files' for uploaded STEP
  // A non-interactive, low-cost render used as a part-list thumbnail. It
  // still parses the real STEP model, so it never drifts from the uploaded
  // geometry like a hand-maintained image would.
  export let thumbnail = false;

  let container;
  let loading = true;
  let loadingMsg = 'Loading 3D model…';
  let error = null;

  let renderer, scene, camera, controls, frameId, resizeObserver, visibilityObserver;
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

  // A thumbnail parses its own STEP file client-side through occt-import-js,
  // which is far too much work to do for a whole list at once: the
  // manufacture page carries hundreds of router and lathe parts alongside
  // the 3D prints, and mounting every row's viewer would download and parse
  // all of them before the operator has scrolled to any. Wait until the row
  // is actually on screen. The full-size viewer opens one model deliberately,
  // so it still loads immediately.
  function whenVisible(element) {
    if (!thumbnail || typeof IntersectionObserver === 'undefined') return Promise.resolve();
    return new Promise((resolve) => {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          resolve();
        }
      }, { rootMargin: '200px' });
      observer.observe(element);
      visibilityObserver = observer;
    });
  }

  onMount(() => {
    let cancelled = false;
    (async () => {
      try {
        await whenVisible(container);
        if (cancelled || disposed) return;
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
        // Keep the viewport close to the part's neutral gray instead of using a
        // near-black dark-mode background. The former high-contrast pairing
        // made specular shadows swallow up smaller faces and holes.
        scene.background = new THREE.Color(isDark ? 0x2b2d31 : 0xe7e9ed);
        camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000000);

        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(thumbnail ? 1 : Math.min(window.devicePixelRatio, 2));
        container.appendChild(renderer.domElement);

        // Use a matte neutral finish instead of a highly reflective metal.
        // Softer lighting preserves the small faces, pockets, and holes that
        // get lost in hard specular highlights and shadows.
        const material = new THREE.MeshStandardMaterial({ color: 0xaeb4bc, metalness: 0.18, roughness: 0.68 });
        const group = new THREE.Group();
        for (const geometry of geometries) {
          group.add(new THREE.Mesh(geometry, material));
        }
        // Center the group on the origin.
        const box = new THREE.Box3().setFromObject(group);
        const center = box.getCenter(new THREE.Vector3());
        group.position.sub(center);
        scene.add(group);

        // Frame the camera based on the bounding sphere.
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const r = sphere.radius || 100;
        const dist = r * 2.6;
        camera.position.set(dist, dist * 0.8, dist);
        camera.lookAt(0, 0, 0);

        scene.add(new THREE.HemisphereLight(0xffffff, 0x7b818a, 1.15));
        const key = new THREE.DirectionalLight(0xffffff, 0.65);
        key.position.set(1, 1, 1);
        scene.add(key);
        const fill = new THREE.DirectionalLight(0xffffff, 0.55);
        fill.position.set(-1, -0.5, -1);
        scene.add(fill);

        if (!thumbnail) {
          controls = new OrbitControls(camera, renderer.domElement);
          controls.enableDamping = true;
          controls.dampingFactor = 0.1;
        }

        const animate = () => {
          if (disposed) return;
          frameId = requestAnimationFrame(animate);
          controls.update();
          renderer.render(scene, camera);
        };
        if (thumbnail) renderer.render(scene, camera);
        else animate();

        resizeObserver = new ResizeObserver(() => {
          if (!renderer || !camera || !container) return;
          const w = container.clientWidth;
          const h = container.clientHeight;
          if (w === 0 || h === 0) return;
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
          if (thumbnail) renderer.render(scene, camera);
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
    visibilityObserver?.disconnect();
    controls?.dispose?.();
    renderer?.dispose?.();
    if (renderer?.domElement?.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
  });
</script>

<div class="cad-viewer" class:cad-viewer-thumbnail={thumbnail} bind:this={container}>
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

  .cad-viewer-thumbnail {
    height: 4.25rem;
    min-height: 4.25rem;
    border-radius: var(--radius-sm, 4px);
  }

  .cad-viewer-thumbnail .cad-viewer-overlay {
    gap: 0.25rem;
    padding: 0.25rem;
    font-size: 0.65rem;
  }

  .cad-viewer-thumbnail .spinner {
    width: 16px;
    height: 16px;
    border-width: 2px;
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
