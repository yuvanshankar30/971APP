<script>
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { supabase } from '$lib/supabase.js';
  import { page } from '$app/stores';
  import { requestConfirmation } from '$lib/confirmation.js';
  import { buildDuplicatePartPayload } from '$lib/parts_helpers.js';
  import { ArrowLeft, Search, Download, Upload, Box, Copy, X, Folder, Scissors } from 'lucide-svelte';
  import { formatPacificDate } from '$lib/timezone.js';
  import { passesTeamFilter } from '$lib/frcTeams.js';
  import TeamFilter from '$lib/components/TeamFilter.svelte';
  import CadViewer from '$lib/components/CadViewer.svelte';
  import { getSeasonBucket, getCurrentSeasonBucket, getAllSeasonBuckets, passesSeasonFilter } from '$lib/frcSeason.js';
  import SeasonFilter from '$lib/components/SeasonFilter.svelte';
  import ManufactureLoadingOverlay from '../ManufactureLoadingOverlay.svelte';

  let parts = [];
  let filteredParts = [];
  let loading = true;
  let searchTerm = '';
  let filterWorkflow = '';
  let filterSeason = getCurrentSeasonBucket()?.value || '';
  let show971 = true;
  let show9584 = true;
  let duplicatingPartIds = new Set();

  const workflows = [
    { value: 'laser-cut', label: 'Laser Cut' },
    { value: 'router', label: 'Router' },
    { value: 'lathe', label: 'Lathe' },
    { value: 'mill', label: 'Mill' },
    { value: '3d-print', label: '3D Print' }
  ];

  onMount(loadParts);

  async function loadParts() {
    const { data, error } = await supabase
      .from('parts')
      .select('*')
      .eq('status', 'complete')
      .order('updated_at', { ascending: false });
    parts = !error ? (data || []) : [];
    loading = false;
  }

  function setDuplicating(partId, isDuplicating) {
    const next = new Set(duplicatingPartIds);
    if (isDuplicating) next.add(partId);
    else next.delete(partId);
    duplicatingPartIds = next;
  }

  async function duplicateToTodo(part) {
    if (duplicatingPartIds.has(part.id)) return;
    const confirmed = await requestConfirmation({
      title: 'Duplicate to ToDo',
      message: `Create a new pending request from "${part.name}"? The completed part will stay in history.`,
      confirmLabel: 'Duplicate to ToDo'
    });
    if (!confirmed) return;

    setDuplicating(part.id, true);
    try {
      const { data, error } = await supabase
        .from('parts')
        .insert(buildDuplicatePartPayload(part))
        .select('id')
        .single();
      if (error) throw error;
      await goto(`/manufacture?part=${data.id}`);
    } catch (error) {
      console.error('Failed to duplicate completed part', error);
      alert(`Could not duplicate this part: ${error.message || error}`);
    } finally {
      setDuplicating(part.id, false);
    }
  }

  function formatDate(dateString) { return formatPacificDate(dateString); }

  // CAD viewer (uploaded STEP files only) — mirrors the manufacture hub.
  function getFileMeta(part) {
    try { return JSON.parse(part.file_url || '{}') || {}; } catch { return {}; }
  }
  function getStepFileName(part) {
    const meta = getFileMeta(part);
    if (meta.step_file) return meta.step_file;
    if (part.file_name && /\.(step|stp)$/i.test(part.file_name)) return part.file_name;
    return null;
  }
  function canViewCad(part) {
    return !!getStepFileName(part);
  }

  let showCadModal = false;
  let cadViewerPart = null;
  function openCadViewer(part) { cadViewerPart = part; showCadModal = true; }
  function closeCadViewer() { showCadModal = false; cadViewerPart = null; }

  // Download the uploaded STEP file for a part from storage.
  async function downloadCadFile(part) {
    const fileName = getStepFileName(part);
    if (!fileName) return;
    try {
      let { data, error } = await supabase.storage.from('manufacturing-files').createSignedUrl(fileName, 60);
      if (error || !data?.signedUrl) {
        const retry = await supabase.storage.from('manufacturing-files').createSignedUrl(decodeURIComponent(fileName), 60);
        data = retry.data; error = retry.error;
      }
      if (error || !data?.signedUrl) throw error || new Error('File not found in storage');
      window.open(data.signedUrl, '_blank');
    } catch (e) {
      console.error('Failed to download CAD file', e);
      alert('Failed to download CAD file');
    }
  }

  $: filteredParts = parts.filter(p => {
    const matchesSearch = !searchTerm ||
      (p.name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (p.material || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (p.requester || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (p.project_id || '').toLowerCase().includes(searchTerm.toLowerCase());
    const matchesWorkflow = !filterWorkflow || p.workflow === filterWorkflow;
    const matchesTeam = passesTeamFilter(p.frc_team, show971, show9584);
    const matchesSeason = passesSeasonFilter(p.created_at, filterSeason);
    return matchesSearch && matchesWorkflow && matchesTeam && matchesSeason;
  });

  $: seasonOptions = getAllSeasonBuckets(parts);
</script>

<svelte:head><title>Completed Parts</title></svelte:head>

<div class="completed-page-container">
<header class="completed-command-bar">
  <div class="completed-command-title">
    <div class="completed-heading-row">
      <h1>Manufacturing</h1>
      <span class="completed-total">{parts.length} completed parts</span>
    </div>
  </div>
  <div class="page-actions">
    <a href="/manufacture" class="btn btn-secondary">
      <ArrowLeft size={16} />
      Work Queue
    </a>
    <a href="/jprog" class="btn btn-secondary">
      <Scissors size={16} />
      JProg
    </a>
    <a href="/manufacture/files" class="btn btn-secondary">
      <Folder size={16} />
      Files
    </a>
    <a href="/manufacture/create" class="btn btn-primary" style="text-decoration:none;display:inline-flex;align-items:center;gap:8px;">
      <Upload size={16} />
      Create New Part
    </a>
  </div>
</header>

<div class="completed-workspace">
  <aside class="completed-rail" aria-label="Completed parts controls">
    <nav class="completed-navigation" aria-label="Manufacturing sections">
      <a href="/manufacture" class:active={$page.url.pathname === '/manufacture'}>Work Queue</a>
      <a href="/manufacture/completed" class:active={$page.url.pathname === '/manufacture/completed'}>Completed</a>
    </nav>

    <section class="completed-filter-section" aria-labelledby="completed-filter-heading">
      <span id="completed-filter-heading" class="completed-section-label">Filter Parts</span>
      <div class="completed-search">
        <Search size={15} aria-hidden="true" />
        <input id="completed-search" class="form-input" placeholder="Search parts" aria-label="Search completed parts" bind:value={searchTerm} />
      </div>
    <div class="form-group">
      <label class="form-label" for="completed-workflow">Workflow</label>
      <select id="completed-workflow" class="form-select" bind:value={filterWorkflow}>
        <option value="">All Workflows</option>
        {#each workflows as w}
          <option value={w.value}>{w.label}</option>
        {/each}
      </select>
    </div>
    <SeasonFilter options={seasonOptions} bind:value={filterSeason} />
      <div class="completed-team-filter">
        <TeamFilter bind:show971 bind:show9584 />
      </div>
    </section>
  </aside>

  <section class="completed-work-surface" aria-label="Completed parts">
    <div class="completed-surface-header">
      <div>
        <span class="completed-section-label">Completed</span>
        <h2>{filteredParts.length} parts</h2>
      </div>
      {#if filterWorkflow || searchTerm}
        <button class="btn btn-secondary btn-sm" on:click={() => { searchTerm = ''; filterWorkflow = ''; }}>
          <X size={14} /> Clear filters
        </button>
      {/if}
    </div>

{#if loading}
  <div class="completed-empty-state"><ManufactureLoadingOverlay compact inline label="Loading completed parts" /></div>
{:else if filteredParts.length === 0}
  <div class="completed-empty-state"><p>No completed parts found.</p></div>
{:else}
  <div class="table-container completed-table-container">
    <table class="table completed-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Material</th>
          <th>Workflow</th>
          <th class="mono">Project ID</th>
          <th>Qty</th>
          <th>Bin / Delivery</th>
          <th>Completed</th>
          <th>CAD</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each filteredParts as part (part.id)}
          <tr>
            <td><strong>{part.name}</strong></td>
            <td class="text-muted">{part.material || '-'}</td>
            <td class="text-muted">{part.workflow}</td>
            <td class="mono">{part.project_id}</td>
            <td>{part.quantity || 1}</td>
            <td>{part.kitting_bin ? part.kitting_bin : (part.delivered ? 'Delivered' : '-')}</td>
            <td>
              {formatDate(part.updated_at || part.created_at)}
              {#if getSeasonBucket(part.created_at)}
                <span class="tag season-tag {getSeasonBucket(part.created_at).isOffseason ? 'tag-offseason' : 'tag-season'}">
                  {getSeasonBucket(part.created_at).label}
                </span>
              {/if}
            </td>
            <td>
              {#if canViewCad(part)}
                <button type="button" class="view-cad-link" title="View 3D model" on:click={() => openCadViewer(part)}>
                  <Box size={13} /> View CAD
                </button>
              {:else}
                <span class="text-muted">—</span>
              {/if}
            </td>
            <td>
              <button
                type="button"
                class="btn btn-secondary btn-sm duplicate-button"
                on:click={() => duplicateToTodo(part)}
                disabled={duplicatingPartIds.has(part.id)}
              >
                <Copy size={14} /> {duplicatingPartIds.has(part.id) ? 'Duplicating...' : 'Duplicate to ToDo'}
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <div class="mobile-completed-list">
    {#each filteredParts as part (part.id)}
      <div class="card mobile-completed-card">
        <div><strong>{part.name}</strong></div>
        <div>Material: {part.material || '-'}</div>
        <div class="text-muted">{part.workflow}</div>
        <div class="mono">{part.project_id}</div>
        <div>Qty: {part.quantity || 1}</div>
        <div>{part.kitting_bin ? part.kitting_bin : (part.delivered ? 'Delivered' : '-')}</div>
        <div>
          {formatDate(part.updated_at || part.created_at)}
          {#if getSeasonBucket(part.created_at)}
            <span class="tag season-tag {getSeasonBucket(part.created_at).isOffseason ? 'tag-offseason' : 'tag-season'}">
              {getSeasonBucket(part.created_at).label}
            </span>
          {/if}
        </div>
        {#if canViewCad(part)}
          <button type="button" class="view-cad-link" title="View 3D model" on:click={() => openCadViewer(part)}>
            <Box size={13} /> View CAD
          </button>
        {/if}
        <button
          type="button"
          class="btn btn-secondary btn-sm duplicate-button"
          on:click={() => duplicateToTodo(part)}
          disabled={duplicatingPartIds.has(part.id)}
        >
          <Copy size={14} /> {duplicatingPartIds.has(part.id) ? 'Duplicating...' : 'Duplicate to ToDo'}
        </button>
      </div>
    {/each}
  </div>
{/if}
</section>
</div>
</div>

<!-- CAD 3D Viewer Modal -->
{#if showCadModal && cadViewerPart}
  <div
    class="modal-backdrop"
    on:click|self={closeCadViewer}
    role="button"
    tabindex="0"
    on:keydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeCadViewer(); } }}
  >
    <div class="modal cad-modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h3>{cadViewerPart.name || '3D Model'}</h3>
        <div class="cad-modal-header-actions">
          <button type="button" class="cad-download-btn" aria-label="Download STEP file" title="Download STEP file" on:click={() => downloadCadFile(cadViewerPart)}>
            <Download size={18} />
          </button>
          <button type="button" class="modal-close-button" aria-label="Close dialog" on:click={closeCadViewer}>
            <X size={18} />
          </button>
        </div>
      </div>
      <div class="modal-body">
        <CadViewer part={cadViewerPart} stepFileName={getStepFileName(cadViewerPart)} />
        <p class="cad-modal-hint">Drag to rotate · scroll to zoom · right-drag to pan</p>
      </div>
    </div>
  </div>
{/if}

<style>
  .completed-page-container {
    box-sizing: border-box;
    width: 100vw;
    margin-left: calc(50% - 50vw);
    margin-right: calc(50% - 50vw);
    padding: 0 clamp(var(--space-3), 2vw, var(--space-5)) var(--space-5);
  }

  .completed-command-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3) 0;
    border-bottom: 2px solid var(--text);
  }

  .completed-heading-row {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-3);
  }

  .completed-command-bar h1,
  .completed-surface-header h2 {
    margin: 0;
    color: var(--text);
    font-size: var(--font-xl);
    line-height: 1.1;
  }

  .completed-total {
    color: var(--text-muted);
    font-size: var(--font-sm);
  }

  .completed-workspace {
    display: grid;
    grid-template-columns: 13.5rem minmax(0, 1fr);
    align-items: start;
    gap: var(--space-4);
    width: 100%;
  }

  .completed-rail {
    position: sticky;
    top: var(--space-3);
    margin-top: 3.6rem;
    display: grid;
    gap: var(--space-4);
    padding-right: var(--space-4);
    border-right: 1px solid var(--border);
  }

  .completed-navigation,
  .completed-filter-section {
    display: grid;
    gap: var(--gap-1);
  }

  .completed-navigation {
    padding-bottom: var(--space-3);
    border-bottom: 1px solid var(--border);
  }

  .completed-navigation a {
    display: flex;
    align-items: center;
    min-height: var(--control-height);
    padding: 0 var(--space-2);
    color: var(--text-secondary);
    font-size: var(--font-sm);
    text-decoration: none;
  }

  .completed-navigation a:hover { color: var(--text); background: var(--surface-2); }
  .completed-navigation a.active { color: var(--text); font-weight: 650; box-shadow: inset 3px 0 0 var(--brand-gold-strong); background: var(--accent-subtle); }

  .completed-filter-section {
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }

  .completed-section-label {
    color: var(--text-muted);
    font-size: var(--font-xs);
    font-weight: 650;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .completed-search {
    position: relative;
    display: flex;
    align-items: center;
  }

  .completed-search :global(svg) {
    position: absolute;
    left: var(--space-2);
    color: var(--text-muted);
    pointer-events: none;
  }

  .completed-search .form-input { width: 100%; padding-left: 1.9rem; }
  .completed-filter-section .form-group { display: grid; gap: var(--space-1); margin: 0; }
  .completed-filter-section .form-label { margin: 0; font-size: var(--font-xs); }
  .completed-filter-section .form-select { width: 100%; }
  .completed-team-filter { margin-top: var(--space-2); padding-top: var(--space-3); border-top: 1px solid var(--border); }

  .completed-work-surface {
    width: 100%;
    min-width: 0;
    border-top: 1px solid var(--border);
  }

  .completed-surface-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    min-height: 3.6rem;
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border);
  }

  .completed-surface-header h2 { margin-top: 0.1rem; font-size: var(--font-lg); }
  .completed-empty-state { display: flex; align-items: center; min-height: 14rem; padding: var(--space-5); color: var(--text-muted); border-bottom: 1px solid var(--border); }

  .completed-table-container { width: 100%; }
  .completed-table { width: 100%; font-size: var(--font-sm); }
  .completed-table thead th { background: var(--background); color: var(--text); }
  .completed-table tbody tr { background: var(--surface-1); }
  .completed-table tbody tr:hover { background: var(--surface-1); }

  @media (max-width: 1080px) {
    .completed-workspace { grid-template-columns: 12rem minmax(0, 1fr); gap: var(--space-3); }
    .completed-rail { padding-right: var(--space-3); }
  }

  @media (max-width: 900px) {
    .completed-command-bar { align-items: flex-start; flex-direction: column; }
    .completed-workspace { grid-template-columns: 1fr; }
    .completed-rail { position: static; margin-top: 0; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); padding: 0 0 var(--space-3); border-right: 0; border-bottom: 1px solid var(--border); }
    .completed-navigation { border-bottom: 0; padding-bottom: 0; }
    .completed-filter-section { padding-top: 0; border-top: 0; }
  }

  @media (max-width: 768px) {
    .completed-page-container { width: auto; margin: 0; padding: 0; }
    .completed-command-bar { padding: var(--space-3); }
    .completed-rail { display: block; padding: 0 var(--space-3) var(--space-3); }
    .completed-navigation { display: flex; margin: 0 calc(-1 * var(--space-3)) var(--space-3); padding: 0 var(--space-3) var(--space-2); overflow-x: auto; border-bottom: 1px solid var(--border); }
    .completed-navigation a { flex: 0 0 auto; }
    .completed-work-surface { border-top: 0; }
    .completed-surface-header { padding: var(--space-2) var(--space-3); }
  }

  .view-cad-link {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    background: none;
    border: none;
    padding: 0;
    font-size: var(--font-xs, 0.75rem);
    font-weight: 600;
    color: var(--accent-strong, #1d4ed8);
    text-decoration: underline;
    cursor: pointer;
    white-space: nowrap;
  }
  .view-cad-link:hover { opacity: 0.8; }

  .duplicate-button {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    white-space: nowrap;
  }

  .cad-modal { width: min(900px, 95vw); max-width: 95vw; }
  .cad-modal-header-actions { display: inline-flex; align-items: center; gap: 0.25rem; }
  .cad-download-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    padding: 0.25rem;
    border-radius: var(--radius-sm, 4px);
    color: var(--accent-strong, #1d4ed8);
    cursor: pointer;
  }
  .cad-download-btn:hover { background: var(--surface-2, #f3f4f6); }
  .cad-modal-hint {
    margin: 0.5rem 0 0 0;
    text-align: center;
    font-size: var(--font-xs, 0.75rem);
    color: var(--text-muted, #6b7280);
  }

  .mobile-completed-list {
    display: none;
  }

  .mobile-completed-card {
    display: grid;
    gap: var(--gap-1);
  }

  @media (max-width: 768px) {
    .table-container {
      display: none;
    }

    .mobile-completed-list {
      display: grid;
      gap: var(--gap-3);
    }
  }
</style>
