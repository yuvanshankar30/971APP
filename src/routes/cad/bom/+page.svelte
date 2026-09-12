<script>
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { supabase } from '$lib/supabase.js';
  import { toastActions } from '$lib/toast.js';
  import { userStore, loadUserFromUUID, upsertProfileIfMissing, setUserUUID } from '$lib/stores/user.js';
  import { onShapeAPI } from '$lib/onshape.js';
  import { goto } from '$app/navigation';

  // URL params
  let subsystemId = $page.url.searchParams.get('subsystem');
  let versionId = $page.url.searchParams.get('version');

  // Auth/user/subsystem/version
  let user = null;
  let loading = true;
  let subsystem = null;
  let version = null;

  // BOM data
  let buildBOM = [];

  onMount(async () => {
    const unsub = userStore.subscribe((v) => {
      user = v;
    });
    await loadUserFromUUID(supabase);

    const { data: { session } } = await supabase.auth.getSession();
    if (!session && !user) {
      goto('/');
      return;
    }
    if (session?.user?.id) {
      try {
        setUserUUID(session.user.id);
        await upsertProfileIfMissing(supabase, {
          id: session.user.id,
          email: session.user.email,
          name: session.user.user_metadata?.full_name || (session.user.email ? session.user.email.split('@')[0] : '')
        });
        await loadUserFromUUID(supabase);
      } catch (e) {
        console.error('Error handling auth session:', e);
      }
    }
    await loadDataAndCreateBuild();
  });

  async function loadDataAndCreateBuild() {
    if (!subsystemId || !versionId) {
      toastActions.show('Missing subsystem or version ID');
      goto('/cad');
      return;
    }

    try {
      // Load subsystem
      const { data: subsystemData, error: subsystemError } = await supabase
        .from('subsystems')
        .select('*')
        .eq('id', subsystemId)
        .single();
      if (subsystemError) throw subsystemError;
      subsystem = subsystemData;

      // Resolve version name from Onshape
      if (subsystem.onshape_document_id) {
        try {
          const allVersions = await onShapeAPI.getDocumentVersions(subsystem.onshape_document_id);
          const currentVersion = allVersions.find(v => v.id === versionId);
          version = currentVersion
            ? { id: versionId, name: currentVersion.name || `Version ${versionId.substring(0, 8)}` }
            : { id: versionId, name: `Version ${versionId.substring(0, 8)}` };
        } catch (versionError) {
          console.error('Error fetching version name:', versionError);
          version = { id: versionId, name: `Version ${versionId.substring(0, 8)}` };
        }
      } else {
        version = { id: versionId, name: `Version ${versionId.substring(0, 8)}` };
      }

      // Load BOM and immediately create build
      await loadBOMAndCreateBuild();

    } catch (error) {
      console.error('Error loading data:', error);
      toastActions.show('Failed to load data: ' + error.message);
      goto('/cad');
    } finally {
      loading = false;
    }
  }

  async function loadBOMAndCreateBuild() {
    try {
      // Load BOM from Onshape
      const bom = await onShapeAPI.getAssemblyBOM(
        subsystem.onshape_document_id,
        subsystem.onshape_workspace_id,
        subsystem.onshape_element_id,
        version?.id || versionId
      );

      buildBOM = await onShapeAPI.analyzeBOM(bom, subsystem.onshape_workspace_id);
      if (!Array.isArray(buildBOM)) {
        console.warn('analyzeBOM did not return an array', buildBOM);
        buildBOM = [];
      }

      // If no BOM items, create empty build
      if (buildBOM.length === 0) {
        console.log('No BOM items found, creating empty build');
        await createEmptyBuild();
        return;
      }

      // Auto-assign stock for manufactured parts
      buildBOM.forEach((part) => {
        if (part.part_type === 'manufactured' && !part.stock_assignment) {
          // Simple auto-assignment - could be enhanced
          part.stock_assignment = '1/4" Aluminum';
        }
      });

      // Immediately create build with ALL BOM items
      await createBuildWithAllBOMItems();

    } catch (error) {
      console.error('Error loading BOM:', error);
      console.log('Creating build with mock data for testing...');

      // Create mock BOM for testing
      buildBOM = [
        {
          part_name: '18t HTD pulley',
          part_number: 'P002570',
          quantity: 4,
          part_type: 'manufactured',
          workflow: 'mill',
          material: 'Aluminum',
          onshape_part_id: 'mock_part_id_1',
          bounding_box_x: 0.05,
          bounding_box_y: 0.05,
          bounding_box_z: 0.01,
          stock_assignment: '1/4" Aluminum'
        }
      ];

      await createBuildWithAllBOMItems();
    }
  }

  async function createEmptyBuild() {
    // Use subsystem ID in build hash (not version) so builds can be rolled up across versions.
    // build_hash has a UNIQUE constraint, so - same as createBuildWithAllBOMItems below -
    // find the subsystem's existing rolled-up build first instead of blindly inserting a
    // second row with the same hash (that insert fails every time past the first build).
    const buildHash = `${subsystem.onshape_document_id}_${subsystem.id}`;

    const { data: existingBuild, error: existingError } = await supabase
      .from('builds')
      .select('id')
      .eq('build_hash', buildHash)
      .maybeSingle();

    if (existingError) throw existingError;

    if (existingBuild) {
      const { error: updateError } = await supabase
        .from('builds')
        .update({ release_id: version.id, release_name: version.name })
        .eq('id', existingBuild.id);
      if (updateError) throw updateError;
      goto(`/cad/build/${existingBuild.id}`);
      return;
    }

    const { data: newBuild, error: buildCreateError } = await supabase
      .from('builds')
      .insert([{
        subsystem_id: subsystem.id,
        release_id: version.id,
        release_name: version.name,
        build_hash: buildHash,
        status: 'pending',
        created_by: user.id
      }])
      .select()
      .single();

    if (buildCreateError) throw buildCreateError;

    // Redirect to build detail page
    goto(`/cad/build/${newBuild.id}`);
  }

  async function createBuildWithAllBOMItems() {
    // Use subsystem ID in build hash (not version) so builds can be rolled up across versions
    const buildHash = `${subsystem.onshape_document_id}_${subsystem.id}`;

    // Check if build already exists
    const { data: existingBuild, error: existingError } = await supabase
      .from('builds')
      .select('*')
      .eq('build_hash', buildHash)
      .maybeSingle();

    if (existingError) throw existingError;

    let build;
    if (existingBuild) {
      // Roll the newly-selected release into the subsystem's existing build instead
      // of silently redirecting with no change - previously this left the build's
      // release_id/release_name stuck on whatever version created it, and never
      // picked up parts newly added in a later OnShape release.
      const { data: updatedBuild, error: updateError } = await supabase
        .from('builds')
        .update({ release_id: version.id, release_name: version.name })
        .eq('id', existingBuild.id)
        .select()
        .single();
      if (updateError) throw updateError;
      build = updatedBuild;

      const { data: existingBomRows, error: existingBomError } = await supabase
        .from('build_bom')
        .select('part_number, part_name')
        .eq('build_id', build.id);
      if (existingBomError) throw existingBomError;

      const existingKeys = new Set(
        (existingBomRows || []).map((row) => row.part_number || row.part_name)
      );
      buildBOM = buildBOM.filter((item) => !existingKeys.has(item.part_number || item.part_name));

      if (buildBOM.length === 0) {
        // Nothing new introduced by this release - existing BOM rows (and any
        // progress already made against them) are left untouched.
        goto(`/cad/build/${build.id}`);
        return;
      }
    } else {
      // Create new build
      const { data: newBuild, error: buildCreateError } = await supabase
        .from('builds')
        .insert([{
          subsystem_id: subsystem.id,
          release_id: version.id,
          release_name: version.name,
          build_hash: buildHash,
          status: 'pending',
          created_by: user.id
        }])
        .select()
        .single();

      if (buildCreateError) throw buildCreateError;
      build = newBuild;
    }

    // Project ID format: {subsystem name} (version-independent for rollup)
    const project_id = subsystem.name;

    // Save BOM snapshot with relations (but don't create parts/purchasing yet)
    const bomRows = buildBOM.map((item) => ({
      build_id: build.id,
      part_name: item.part_name,
      part_number: item.part_number || null,
      quantity: item.quantity || 1,
      material: item.material || '',
      part_type: item.part_type,
      workflow: item.part_type === 'COTS' ? 'purchase' : (item.workflow || item.manufacturing_process || 'mill'),
      bounding_box_x: item.bounding_box_x ?? null,
      bounding_box_y: item.bounding_box_y ?? null,
      bounding_box_z: item.bounding_box_z ?? null,
      stock_assignment: item.stock_assignment,
      onshape_document_id: item.onshape_document_id || subsystem.onshape_document_id || null,
      onshape_element_id: item.onshape_element_id || item.onshape_part_studio_element_id || subsystem.onshape_element_id || null,
      onshape_part_id: item.onshape_part_id || null,
      onshape_wvm: item.onshape_wvm || 'v',
      onshape_wvmid: item.onshape_wvmid || version.id,
      status: 'pending', // Explicitly set status
      file_format: item.part_type === 'manufactured' ? 'step' : null, // Set file_format for manufactured parts
      is_onshape_part: !!(item.onshape_document_id || item.onshape_part_id), // Set is_onshape_part flag
      parts_id: null, // Don't create parts yet
      purchasing_id: null, // Don't create purchasing yet
      kitting_id: null, // Don't create kitting yet
      added: false // Items start as not added
    }));

    if (bomRows.length) {
      const { error } = await supabase.from('build_bom').insert(bomRows);
      if (error) {
        console.error('Failed to save BOM snapshot:', error?.message || error);
        console.error('Full error details:', JSON.stringify(error, null, 2));
        toastActions.show('Failed to save BOM data: ' + error.message);
      } else {
        console.log('Successfully saved BOM snapshot with', bomRows.length, 'items');
      }
    } else {
      console.log('No BOM rows to insert');
    }

    // Redirect to build detail page
    goto(`/cad/build/${build.id}`);
  }
</script>

<main class="bom-page">
  {#if loading}
    <div class="loading-container">
      <h2>Loading BOM...</h2>
      <p>Automatically creating build with all BOM items...</p>
      <div class="spinner"></div>
    </div>
  {:else}
    <div class="redirect-container">
      <h2>Build Created!</h2>
      <p>Redirecting to build details...</p>
    </div>
  {/if}
</main>

<style>
  .bom-page { padding: var(--space-7); max-width: 1200px; margin: 0 auto; }
  .redirect-container { text-align: center; padding: var(--space-8); }
  .redirect-container h2 { color: var(--text); margin-bottom: var(--space-4); }
  .redirect-container p { color: var(--text-secondary); margin-bottom: var(--space-7); }

  @media (max-width: 768px) {
    .bom-page {
      padding: var(--space-4);
    }

    .redirect-container {
      padding: var(--space-6) var(--space-3);
    }
  }

  @media (max-width: 480px) {
    .bom-page {
      padding: var(--space-3);
    }
  }
</style>
