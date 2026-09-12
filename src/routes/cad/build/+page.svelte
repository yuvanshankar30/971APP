<script>
  import { onMount } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { toastActions } from '$lib/toast.js';
  import { userStore, loadUserFromUUID, upsertProfileIfMissing, setUserUUID } from '$lib/stores/user.js';
  import { Settings, Package, Wrench, CheckCircle, Clock, ExternalLink, DollarSign } from 'lucide-svelte';
  import { goto } from '$app/navigation';
  import { formatPacificDate } from '$lib/timezone.js';
  import { getSeasonBucket, getCurrentSeasonBucket, getAllSeasonBuckets, passesSeasonFilter } from '$lib/frcSeason.js';
  import SeasonFilter from '$lib/components/SeasonFilter.svelte';

  let user = null;
  let loading = true;
  let builds = [];
  let filterSeason = getCurrentSeasonBucket()?.value || '';
  let budgets = []; // Budgets for build groups and individual builds
  let buildStats = {
    total: 0,
    pending: 0,
    manufacturing: 0,
    ready_to_assemble: 0,
    assembled: 0
  };
  // UI state for project grouping
  let projectOpen = {};
  let groupedBuilds = {};
  let editingProjectName = {};
  let tempProjectName = {};

  // Drag-and-drop handlers
  function onDragStart(e, build) {
    try {
      e.dataTransfer.setData('text/plain', String(build.id));
      e.dataTransfer.setData('application/json', JSON.stringify({ sourcePid: build.project_id || '__NO_PROJECT__' }));
      e.dataTransfer.effectAllowed = 'move';
    } catch (err) { }
  }

  async function dropOnBuild(e, targetBuild) {
    e.preventDefault();
    e.stopPropagation();
    const draggedId = e.dataTransfer.getData('text/plain');
    if (!draggedId || draggedId === String(targetBuild.id)) return;
    // Always form a new project container for the two builds
    const newPid = `Project-${Math.floor(Math.random()*90000)+10000}`;
    try {
      const { error } = await supabase.from('builds').update({ project_id: newPid }).in('id', [draggedId, targetBuild.id]);
      if (error) throw error;
      await loadBuilds();
      projectOpen = { ...projectOpen, [newPid]: true };
      editingProjectName = { ...editingProjectName, [newPid]: true };
      tempProjectName = { ...tempProjectName, [newPid]: newPid };
    } catch (err) {
      console.error('Failed creating project container:', err);
      toastActions.show('Failed to create project container: ' + (err?.message || err));
    }
  }

  async function dropOnProject(e, pid) {
    e.preventDefault();
    e.stopPropagation();
    const draggedId = e.dataTransfer.getData('text/plain');
    if (!draggedId) return;
    try {
      const { error } = await supabase.from('builds').update({ project_id: pid }).eq('id', draggedId);
      if (error) throw error;
      await loadBuilds();
      projectOpen = { ...projectOpen, [pid]: true };
    } catch (err) {
      console.error('Failed assigning build to project:', err);
      toastActions.show('Failed to assign build to project: ' + (err?.message || err));
    }
  }

  function allowDrop(e) { e.preventDefault(); }

  // Inline project name editing
  function startEditProjectName(pid) {
    if (pid === '__NO_PROJECT__') return; // don't edit unassigned
    editingProjectName = { ...editingProjectName, [pid]: true };
    tempProjectName = { ...tempProjectName, [pid]: pid };
    projectOpen = { ...projectOpen, [pid]: true };
  }

  async function saveProjectName(oldPid) {
    const newName = (tempProjectName[oldPid] || '').trim();
    if (!newName || newName === oldPid) {
      editingProjectName = { ...editingProjectName, [oldPid]: false };
      return;
    }
    try {
      const { error } = await supabase.from('builds').update({ project_id: newName }).eq('project_id', oldPid);
      if (error) throw error;
      await loadBuilds();
    } catch (err) {
      console.error('Failed renaming project:', err);
      toastActions.show('Failed renaming project: ' + (err?.message || err));
    }
  }

  onMount(async () => {
    // Hydrate from UUID and keep local var in sync
    const unsub = userStore.subscribe((v) => { user = v; });
    await loadUserFromUUID(supabase);

    // Check authentication
    const { data: { session } } = await supabase.auth.getSession();
    if (!session && !user) {
      goto('/');
      return;
    }
    if (session?.user?.id) {
      setUserUUID(session.user.id);
      await upsertProfileIfMissing(supabase, {
        id: session.user.id,
        email: session.user.email,
        name: session.user.user_metadata?.full_name || (session.user.email ? session.user.email.split('@')[0] : '')
      });
      await loadUserFromUUID(supabase);
    }

    await loadBuilds();
    await loadBudgets();
    loading = false;
  });

  // Load budgets for build groups and individual builds
  async function loadBudgets() {
    try {
      const { data, error } = await supabase
        .from('purchasing_budgets')
        .select('*')
        .in('scope_type', ['build', 'build_group', 'subsystem']);
      if (error) throw error;
      budgets = data || [];
    } catch (e) {
      console.warn('Failed to load budgets:', e);
      budgets = [];
    }
  }

  // Get budget for a build group (project_id)
  function getBudgetForBuildGroup(projectId) {
    return budgets.find(b => b.scope_type === 'build_group' && b.scope_value === projectId);
  }

  // Get budget for a specific build
  function getBudgetForBuild(build) {
    // Check for build-specific budget first
    const buildLabel = `${build.subsystems?.name || 'Project'}-${build.release_name || ''}`;
    const buildBudget = budgets.find(b => b.scope_type === 'build' && b.scope_value === buildLabel);
    if (buildBudget) return buildBudget;
    // Check for subsystem budget
    return budgets.find(b => b.scope_type === 'subsystem' && b.scope_value === build.subsystem_id);
  }

  async function loadBuilds() {
    try {
      const { data, error } = await supabase
        .from('builds')
        .select(`
          *,
          subsystems(name, onshape_url)
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;
      builds = data || [];
      
      // Enrich each build with its BOM/parts/purchasing/kitting. Run all builds
      // in parallel — this was previously a sequential loop (N builds × up to 4
      // queries each), which was the main cause of slow Build-tab load times.
      await Promise.all(builds.map(async (build) => {
        try {
          // Load BOM snapshot for this build
          const { data: bomData, error: bomErr } = await supabase
            .from('build_bom')
            .select('*')
            .eq('build_id', build.id)
            .order('created_at', { ascending: true });

          let bomSnapshot = [];
          if (!bomErr && bomData) {
            bomSnapshot = bomData;
          }

          // Get BOM rows that have been added to the build
          const addedBomRows = bomSnapshot.filter(row => row.added === true);

          // Collect all related IDs from added BOM rows
          const partsIds = addedBomRows.filter(row => row.parts_id).map(row => row.parts_id);
          const purchasingIds = addedBomRows.filter(row => row.purchasing_id).map(row => row.purchasing_id);
          const kittingIds = addedBomRows.filter(row => row.kitting_id).map(row => row.kitting_id);

          // Fetch actual created items only (no placeholders)
          let partsData = [];
          let purchasingData = [];
          let kittingData = [];

          if (partsIds.length > 0) {
            const { data, error: partsError } = await supabase
              .from('parts')
              .select('*')
              .in('id', partsIds);
            if (!partsError) partsData = data || [];
          }

          if (purchasingIds.length > 0) {
            const { data, error: purchasingError } = await supabase
              .from('purchasing')
              .select('*')
              .in('id', purchasingIds);
            if (!purchasingError) purchasingData = data || [];
          }

          if (kittingIds.length > 0) {
            const { data, error: kittingError } = await supabase
              .from('kitting')
              .select('*')
              .in('id', kittingIds);
            if (!kittingError) kittingData = data || [];
          }

          // Create placeholder entries only for BOM rows that were explicitly added
          // to the build (row.added === true). This ensures progress and cost
          // calculations only measure items the user chose to include.
          const allBomRows = (bomSnapshot || []).filter(r => r.added === true);

          const pendingParts = allBomRows.filter(row =>
            row.part_type === 'manufactured' && !row.parts_id
          ).map(row => ({
            _bom: true,
            bom_id: row.id,
            name: row.part_name,
            part_number: row.part_number || null,
            quantity: row.quantity || 1,
            material: row.material || '',
            workflow: row.workflow || 'mill',
            status: 'needs_approval',
            stock_assignment: row.stock_assignment || null
          }));

          const pendingPurchasing = allBomRows.filter(row =>
            row.part_type === 'COTS' && (row.workflow || 'purchase') === 'purchase' && !row.purchasing_id
          ).map(row => ({
            _bom: true,
            bom_id: row.id,
            name: row.part_name,
            part_number: row.part_number || null,
            quantity: row.quantity || 1,
            material: row.material || '',
            workflow: 'purchase',
            status: 'needs_approval'
          }));

          const pendingKitting = allBomRows.filter(row =>
            row.part_type === 'COTS' && row.workflow === 'kit' && !row.kitting_id
          ).map(row => ({
            _bom: true,
            bom_id: row.id,
            name: row.part_name,
            part_number: row.part_number || null,
            quantity: row.quantity || 1,
            material: row.material || '',
            workflow: 'kit',
            status: 'needs_approval'
          }));

          // Merge placeholders with actual created rows (actuals only fetched for added BOM rows)
          const mergedParts = [...(partsData || []), ...(pendingParts || [])];
          const mergedPurchasing = [...(purchasingData || []), ...(pendingPurchasing || [])];
          const mergedKitting = [...(kittingData || []), ...(pendingKitting || [])];

          build.parts = mergedParts;
          build.purchasing = mergedPurchasing;
          build.kitting = mergedKitting;

          // Compute purchasing cost for this build from merged purchasing rows
          try {
            build.totalPurchasingCost = (mergedPurchasing || []).reduce((sum, p) => {
              const unit = (p.final_price ?? p.price) || 0;
              const qty = p.quantity || 1;
              return sum + (Number(unit) * Number(qty));
            }, 0);
          } catch (e) { build.totalPurchasingCost = 0; }
        } catch (e) {
          console.error(`Error loading parts for build ${build.id}:`, e);
          build.parts = [];
          build.purchasing = [];
          build.kitting = [];
          build.totalPurchasingCost = 0;
        }
      }));

      // Calculate stats and update build statuses
      buildStats = {
        total: builds.length,
        pending: 0,
        manufacturing: 0,
        ready_to_assemble: 0,
        assembled: 0
      };

      // Recalculate and normalize build statuses based on current part states
      for (const build of builds) {
        if (build.status !== 'assembled') {
          const allParts = [...(build.parts || []), ...(build.purchasing || []), ...(build.kitting || [])];
          const hasParts = allParts.length > 0;
          const allComplete = hasParts && allParts.every(p => p.status === 'complete' || p.status === 'delivered' || p.status === 'kitted');
          const anyStarted = hasParts && allParts.some(p => ['in-progress','cammed','ordered','delivered','complete','manufactured','kitted'].includes(p.status));
          let newStatus = 'pending';
            if (allComplete) newStatus = 'ready_to_assemble';
            else if (anyStarted) newStatus = 'manufacturing';
          if (newStatus !== build.status) {
            const { error: updErr } = await supabase.from('builds').update({ status: newStatus }).eq('id', build.id);
            if (!updErr) build.status = newStatus;
          }
        }
        if (build.status === 'pending') buildStats.pending++;
        else if (build.status === 'manufacturing') buildStats.manufacturing++;
        else if (build.status === 'ready_to_assemble') buildStats.ready_to_assemble++;
        else if (build.status === 'assembled') buildStats.assembled++;
      }
      // Build grouping by project_id for UI
      groupedBuilds = {};
      for (const b of builds) {
        const pid = b.project_id || '__NO_PROJECT__';
        if (!groupedBuilds[pid]) groupedBuilds[pid] = [];
        groupedBuilds[pid].push(b);
      }
      // Initialize UI state for each project container after grouping
      for (const pid of Object.keys(groupedBuilds)) {
        // default all project containers to open so cards are visible
        if (projectOpen[pid] === undefined) projectOpen[pid] = true;
        if (editingProjectName[pid] === undefined) editingProjectName[pid] = false;
        if (tempProjectName[pid] === undefined) tempProjectName[pid] = pid;
      }
      // reassign shallow copies so Svelte notices changes to nested objects
      projectOpen = { ...projectOpen };
      editingProjectName = { ...editingProjectName };
      tempProjectName = { ...tempProjectName };

    } catch (error) {
      console.error('Error loading builds:', error);
    }
  }

  async function markAsAssembled(buildId) {
    try {
      const { error } = await supabase
        .from('builds')
        .update({ 
          status: 'assembled',
          assembled_at: new Date().toISOString(),
          assembled_by: user.id
        })
        .eq('id', buildId);

      if (error) throw error;
      await loadBuilds();
    } catch (error) {
      console.error('Error marking as assembled:', error);
      toastActions.show('Failed to mark as assembled');
    }
  }
  // Calculate progress based on BOM rows (each row counts as one part regardless of quantity)
  function getBuildProgress(build) {
    const allParts = [...(build.parts || []), ...(build.purchasing || []), ...(build.kitting || [])];
    if (allParts.length === 0) {
      return {
        percent: 0,
        manufactured: 0,
        total: 0,
        status: 'No parts',
        mfgPercent: 0,
        purPercent: 0,
        kitPercent: 0,
        mfgCount: { complete: 0, total: 0 },
        purCount: { complete: 0, total: 0 },
        kitCount: { complete: 0, total: 0 }
      };
    }

    // For row-based progress we treat each item in the merged lists as one row
    // (this matches the BOM rows shown to users). Ignore per-row quantity.
    const manufactured = allParts.filter(item => item.status === 'complete' || item.status === 'delivered' || item.status === 'kitted').length;
    const inProgress = allParts.filter(item => item.status === 'in-progress' || item.status === 'cammed' || item.status === 'ordered').length;

    let status = 'Requested';
    if (manufactured === allParts.length) status = 'Ready to Assemble';
    else if (inProgress > 0 || manufactured > 0) status = 'Manufacturing';

    // Derive per-workflow row counts (row-based)
    const mfgParts = allParts.filter(p => (p.workflow || '').toString() !== 'purchase' && (p.workflow || '').toString() !== 'kit');
    const purParts = allParts.filter(p => (p.workflow || '').toString() === 'purchase');
    const kitParts = allParts.filter(p => (p.workflow || '').toString() === 'kit');

    const mfgComplete = mfgParts.filter(p => p.status === 'complete' || p.status === 'manufactured').length;
    const purComplete = purParts.filter(p => p.status === 'delivered').length;
    const kitComplete = kitParts.filter(p => p.status === 'kitted').length;

    return {
      percent: Math.round((manufactured / allParts.length) * 100),
      manufactured,
      total: allParts.length,
      inProgress,
      status,
      mfgPercent: mfgParts.length ? Math.round((mfgComplete / mfgParts.length) * 100) : 0,
      purPercent: purParts.length ? Math.round((purComplete / purParts.length) * 100) : 0,
      kitPercent: kitParts.length ? Math.round((kitComplete / kitParts.length) * 100) : 0,
      mfgCount: { complete: mfgComplete, total: mfgParts.length },
      purCount: { complete: purComplete, total: purParts.length },
      kitCount: { complete: kitComplete, total: kitParts.length }
    };
  }

  $: seasonOptions = getAllSeasonBuckets(builds);
</script>

<svelte:head>
  <title>Build Center - Spartans Hub</title>
</svelte:head>

{#if loading}
  <div class="loading-container">
    <div class="loading-spinner"></div>
    <p>Loading...</p>
  </div>
{:else if user}
  <div class="build-container">
    <div class="page-header">
      <div class="header-content">
        <Settings size={32} />
        <div>
          <h1>Build Center</h1>
          <p>Manage build configurations and assembly processes</p>
        </div>
      </div>
    </div>

    <!-- Build Statistics -->
    <div class="stats-grid">
      <div class="stat-card">
        <Package size={24} />
        <div class="stat-info">
          <h3>{buildStats.total}</h3>
          <p>Total Builds</p>
        </div>
      </div>
      <div class="stat-card">
        <Clock size={24} />
        <div class="stat-info">
          <h3>{buildStats.pending}</h3>
          <p>Pending</p>
        </div>
      </div>
      <div class="stat-card">
        <Wrench size={24} />
        <div class="stat-info">
          <h3>{buildStats.manufacturing}</h3>
          <p>Manufacturing</p>
        </div>
      </div>
      <div class="stat-card">
        <CheckCircle size={24} />
        <div class="stat-info">
          <h3>{buildStats.ready_to_assemble}</h3>
          <p>Ready to Assemble</p>
        </div>
      </div>
      <div class="stat-card">
        <CheckCircle size={24} />
        <div class="stat-info">
          <h3>{buildStats.assembled}</h3>
          <p>Assembled</p>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="filters">
        <SeasonFilter options={seasonOptions} bind:value={filterSeason} />
      </div>
    </div>

    <!-- Active Builds grouped by Project -->
    <div class="build-sections">
      <section class="section">
        <h2>All Builds</h2>
        {#if builds.length > 0}
          {#each Object.keys(groupedBuilds) as pid}
            {@const human = pid === '__NO_PROJECT__' ? 'Unassigned' : pid}
            {@const projectBuilds = (groupedBuilds[pid] || []).filter((b) => passesSeasonFilter(b.created_at, filterSeason))}
            {@const projectTotalCost = projectBuilds.reduce((s,b) => s + (b.totalPurchasingCost || 0), 0)}
            {@const projectPartsCount = projectBuilds.reduce((s,b) => s + (((b.parts||[]).length || 0) + ((b.purchasing||[]).length || 0) + ((b.kitting||[]).length || 0)), 0)}
            {@const groupBudget = getBudgetForBuildGroup(pid)}
            <div class="project-container" role="group" on:drop={(e) => dropOnProject(e, pid)} on:dragover={allowDrop} on:dragenter={allowDrop}>
              <div class="project-header" on:click={() => { if (pid !== '__NO_PROJECT__') projectOpen = { ...projectOpen, [pid]: !projectOpen[pid] }; }} on:keydown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && pid !== '__NO_PROJECT__') { projectOpen = { ...projectOpen, [pid]: !projectOpen[pid] }; } }} role="button" tabindex="0">
                <div class="project-header-left">
                  <strong class="project-name">{human}</strong>
                  <div class="project-meta">{projectBuilds.length} builds • {projectPartsCount} parts • Total cost: ${projectTotalCost.toFixed(2)}</div>
                  {#if groupBudget}
                    {@const spent = projectTotalCost}
                    {@const percent = Math.min((spent / groupBudget.amount) * 100, 100)}
                    <div class="budget-indicator">
                      <DollarSign size={14} />
                      <div class="budget-progress-track">
                        <div 
                          class="budget-progress-fill" 
                          class:over={spent > groupBudget.amount}
                          style="width: {percent}%"
                        ></div>
                      </div>
                      <span class="budget-text" class:over-budget={spent > groupBudget.amount}>
                        ${spent.toFixed(0)} / ${Number(groupBudget.amount).toLocaleString()}
                      </span>
                    </div>
                  {/if}
                </div>
                <div class="project-actions">
                  {#if pid === '__NO_PROJECT__'}
                    <span class="muted">Unassigned</span>
                  {:else}
                    {#if editingProjectName[pid]}
                      <input class="form-input" bind:value={tempProjectName[pid]} on:keydown={(e) => { if (e.key === 'Enter') saveProjectName(pid); }} />
                      <button class="btn btn-sm" on:click={() => saveProjectName(pid)}>Save</button>
                      <button class="btn btn-sm" on:click={() => { editingProjectName[pid] = false; }}>Cancel</button>
                    {:else}
                      <button class="btn btn-sm" on:click|stopPropagation={() => startEditProjectName(pid)}>Rename</button>
                    {/if}
                  {/if}
                </div>
              </div>
              {#if projectOpen[pid]}
                    <div class="builds-grid">
                  {#each projectBuilds as build}
                    {@const progress = getBuildProgress(build)}
        <div class="build-card status-{build.status}"
          draggable="true"
          on:dragstart|stopPropagation={(e) => onDragStart(e, build)}
          on:drop|stopPropagation={(e) => dropOnBuild(e, build)}
          on:dragover|stopPropagation={allowDrop}
          on:dragenter|stopPropagation={allowDrop}
          on:click={() => goto(`/cad/build/${build.id}`)}
          on:keydown={(e) => e.key === 'Enter' && goto(`/cad/build/${build.id}`)}
          role="button"
          tabindex="0">
                      <div class="build-header">
                        <div class="icon-wrap"><Package size={18} /></div>
                        <div class="build-info">
                          <h3>{build.subsystems?.name || 'Unknown'} · {build.release_name}</h3>
                          <p>Build #{build.build_hash?.split('_')[1] || 'N/A'}</p>
                        </div>
                        <span class="status-badge status-{build.status}">
                          {#if build.status === 'pending'}
                            <Clock size={14} /> Pending
                          {:else if build.status === 'manufacturing'}
                            <Wrench size={14} /> in progress
                          {:else if build.status === 'ready_to_assemble'}
                            <CheckCircle size={14} /> Ready
                          {:else if build.status === 'assembled'}
                            <CheckCircle size={14} /> Assembled
                          {/if}
                        </span>
                      </div>

                      <div class="progress-section">
                        <div class="progress-row">
                          <span class="progress-label">Manufacturing</span>
                          <div class="progress-bar small">
                            <div class="progress-fill mfg" style="width: {progress.mfgPercent}%"></div>
                          </div>
                          <span class="progress-count">{progress.mfgCount.complete}/{progress.mfgCount.total}</span>
                        </div>
                        <div class="progress-row">
                          <span class="progress-label">Purchasing</span>
                          <div class="progress-bar small">
                            <div class="progress-fill pur" style="width: {progress.purPercent}%"></div>
                          </div>
                          <span class="progress-count">{progress.purCount.complete}/{progress.purCount.total}</span>
                        </div>
                        <div class="progress-row">
                          <span class="progress-label">Kitting</span>
                          <div class="progress-bar small">
                            <div class="progress-fill kit" style="width: {progress.kitPercent}%"></div>
                          </div>
                          <span class="progress-count">{progress.kitCount.complete}/{progress.kitCount.total}</span>
                        </div>
                      </div>

                      <div class="build-details">
                        <div class="meta">
                          <span>{progress.manufactured}/{progress.total} parts</span>
                          <span>•</span>
                          <span>{progress.percent}%</span>
                          <span>|</span>
                          <span>Qty x{Math.max(1, Math.round(Number(build.quantity || 1)))}</span>
                          <span>•</span>
                          <span>
                            Created {formatPacificDate(build.created_at)}
                            {#if getSeasonBucket(build.created_at)}
                              <span class="tag season-tag {getSeasonBucket(build.created_at).isOffseason ? 'tag-offseason' : 'tag-season'}">
                                {getSeasonBucket(build.created_at).label}
                              </span>
                            {/if}
                          </span>
                        </div>
                        <div style="margin-top:0.5rem; display:flex; gap:0.5rem; align-items:center;">
                          <div class="cost-badge">Cost: ${ (build.totalPurchasingCost || 0).toFixed(2) }</div>
                        </div>
                        {#if getBudgetForBuild(build)}
                          {@const buildBudget = getBudgetForBuild(build)}
                          {@const spent = build.totalPurchasingCost || 0}
                          {@const budgetPercent = Math.min((spent / buildBudget.amount) * 100, 100)}
                          <div class="build-budget-indicator">
                            <DollarSign size={12} />
                            <div class="budget-progress-track small">
                              <div 
                                class="budget-progress-fill" 
                                class:over={spent > buildBudget.amount}
                                style="width: {budgetPercent}%"
                              ></div>
                            </div>
                            <span class="budget-text small" class:over-budget={spent > buildBudget.amount}>
                              ${spent.toFixed(0)} / ${Number(buildBudget.amount).toLocaleString()}
                            </span>
                          </div>
                        {/if}
                      </div>

                      <div class="build-actions">
                        <a href="/cad/build/{build.id}" class="btn btn-primary btn-sm">
                          <ExternalLink size={14} />
                          View Details
                        </a>
                        {#if build.subsystems?.onshape_url}
                          <a href={build.subsystems.onshape_url} target="_blank" class="btn btn-secondary btn-sm">
                            <ExternalLink size={14} />
                            View CAD
                          </a>
                        {/if}
                        {#if build.status !== 'assembled'}
                          {@const progress = getBuildProgress(build)}
                          {#if progress.status === 'Ready'}
                            <button class="btn btn-success btn-sm" on:click|stopPropagation={() => markAsAssembled(build.id)}>
                              <CheckCircle size={14} />
                              Build Finished
                            </button>
                          {/if}
                        {/if}
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
      {:else}        <div class="empty-state">
          <Package size={48} />
          <h3>No Builds Yet</h3>
          <p>Builds are automatically created when you add parts from CAD subsystem BOMs.</p>
          <p>To create your first build:</p>
          <ol style="text-align: left; margin: 1rem 0;">
            <li>Go to a CAD subsystem</li>
            <li>Generate or view a BOM</li>
            <li>Add parts to manufacturing or purchasing</li>
            <li>A build will be created automatically</li>
          </ol>
          <a href="/cad" class="btn btn-primary btn-sm">
            Go to CAD Subsystems
          </a>
        </div>
      {/if}
    </section>
  </div>
</div>
{:else}
  <div class="error-container">
    <p>Please log in to access the Build Center.</p>
  </div>
{/if}

<style>
  .build-container { max-width: 1400px; margin: 0 auto; padding: 0 var(--space-4) var(--space-4); }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: var(--gap-3);
    margin-bottom: var(--space-3);
  }

  .stat-card { padding: var(--space-3); }

  .stat-info h3 {
    margin: 0;
    color: var(--secondary);
    font-size: var(--font-xl);
  }

  .stat-info p {
    margin: var(--space-1) 0 0 0;
    color: var(--neutral-500);
    font-size: var(--font-xs);
  }

  .build-sections {
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
  }

  .section { background: var(--primary); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-4); box-shadow: var(--shadow-sm); }

  .section h2 {
    margin: 0 0 var(--space-3) 0;
    color: var(--secondary);
    font-size: var(--font-xl);
  }

  .builds-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: var(--gap-4);
  }

  .project-container { border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-2); margin-bottom: var(--space-4); background: var(--color-white); }
  .project-header { display: flex; align-items: flex-start; justify-content: space-between; padding: var(--space-2); cursor: pointer; gap: var(--gap-3); }
  .project-header-left { flex: 1; min-width: 0; }
  .project-name { font-size: var(--font-base); }
  .project-meta { color: var(--neutral-500); font-size: var(--font-xs); }
  .project-builds { padding: var(--space-2) var(--space-1); }
  .cost-badge { background: var(--neutral-100); padding: var(--space-1) var(--space-2); border-radius: var(--radius-lg); font-weight: 600; }
  .assign-project .form-input { max-width: 140px; }

  /* Budget indicators */
  .budget-indicator { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem; }
  .budget-progress-track { flex: 1; max-width: 200px; height: 6px; background: var(--neutral-200); border-radius: 99px; overflow: hidden; }
  .budget-progress-track.small { height: 4px; max-width: 120px; }
  .budget-progress-fill { height: 100%; background: var(--brand-gold-strong); border-radius: 99px; transition: width 0.3s ease; }
  .budget-progress-fill.over { background: var(--red-strong); }
  .budget-text { font-size: 0.75rem; color: var(--neutral-600); white-space: nowrap; }
  .budget-text.small { font-size: 0.7rem; }
  .budget-text.over-budget { color: var(--red-strong); font-weight: 600; }
  .build-budget-indicator { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.5rem; }

  .build-card { 
    padding: var(--space-3); 
    border-radius: var(--radius-xl); 
    border: 1px solid var(--neutral-300) !important; 
    background: var(--neutral-100) !important; 
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1); 
  }

  .build-header { display: flex; align-items: center; gap: var(--gap-3); margin-bottom: var(--space-3); flex-wrap: wrap; }
  .icon-wrap { width: var(--control-height); height: var(--control-height); border-radius: var(--radius-lg); background: var(--neutral-100); display: inline-flex; align-items: center; justify-content: center; color: var(--neutral-500); border: 1px solid var(--neutral-300); }

  .build-info {
    flex: 1;
    min-width: 0;
  }

  .build-info h3 { margin: 0; color: var(--secondary); font-size: var(--font-base); font-weight: 600; }

  .build-info p {
    margin: var(--space-1) 0 0 0;
    color: var(--neutral-500);
    font-size: var(--font-xs);
  }

  .status-badge { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.3rem 0.6rem; border-radius: 4px; font-size: 0.78rem; font-weight: 600; border: 1px solid transparent; margin-left: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; box-sizing: border-box; }
  .status-badge.status-pending { background: var(--brand-gold-soft); color: var(--brand-gold-strong); border-color: var(--brand-gold-soft); }
  .status-badge.status-manufacturing { background: var(--blue-soft); color: var(--blue-base); border-color: var(--blue-soft); }
  .status-badge.status-ready_to_assemble { background: var(--green-soft); color: var(--green-strong); border-color: var(--green-soft); }
  .status-badge.status-assembled { background: var(--green-soft); color: var(--green-strong); border-color: var(--green-soft); }

  .progress-bar { margin-bottom: 0.75rem; }
  .progress-section { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 0.5rem; }
  .progress-row { display: grid; grid-template-columns: 110px 1fr auto; align-items: center; gap: 0.5rem; }
  .progress-label { font-size: 0.8rem; color: var(--neutral-500); }
  .progress-count { font-size: 0.8rem; color: var(--neutral-500); }

  .build-details .meta { display: flex; gap: 0.5rem; flex-wrap: wrap; color: var(--neutral-500); font-size: 0.85rem; }

  .build-actions {
    display: flex;
    gap: 0.75rem;
    margin-top: 1rem;
    flex-wrap: wrap;
  }

  @media (max-width: 768px) {
    .build-container { margin: 0; padding: 0 var(--space-2); }
    .page-header { padding: 0.75rem; }
    .header-content { flex-direction: column; align-items: flex-start; text-align: left; }
    .header-content h1 { font-size: 1.5rem; }
    .section { padding: 0.75rem; }
    .build-header { flex-direction: column; align-items: flex-start; gap: 0.75rem; }
    .build-status { align-self: flex-start; }
    
    .stats-grid {
      grid-template-columns: repeat(2, 1fr);
      gap: var(--gap-2);
    }
    
    .stat-card {
      padding: var(--space-2);
    }
    
    .stat-info h3 {
      font-size: var(--font-lg);
    }
    
    .builds-grid {
      grid-template-columns: 1fr;
    }
    
    .project-header {
      flex-direction: column;
      align-items: flex-start;
      gap: var(--gap-2);
    }
    
    .project-actions {
      width: 100%;
      display: flex;
      gap: var(--gap-2);
    }
    
    .project-actions .form-input {
      flex: 1;
    }
    
    .progress-row {
      grid-template-columns: 80px 1fr 40px;
    }
    
    .progress-label {
      font-size: 0.7rem;
    }
    
    .build-actions {
      flex-direction: column;
    }
    
    .build-actions .btn {
      width: 100%;
      justify-content: center;
    }
  }
  
  @media (max-width: 480px) {
    .stats-grid {
      grid-template-columns: 1fr;
    }
    
    .build-card {
      padding: var(--space-2);
    }
    
    .build-info h3 {
      font-size: 0.9rem;
    }
    
    .status-badge {
      font-size: 0.7rem;
      padding: 0.2rem 0.4rem;
    }
    
    .section h2 {
      font-size: var(--font-lg);
    }
  }
</style>
