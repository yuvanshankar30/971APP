<script>
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { supabase } from '$lib/supabase.js';
  import { page } from '$app/stores';
  import { requestConfirmation } from '$lib/confirmation.js';
  import { buildDuplicatePartPayload } from '$lib/parts_helpers.js';
  import { Download, Upload, Box, Copy, X } from 'lucide-svelte';
  import { formatPacificDate } from '$lib/timezone.js';
  import { passesTeamFilter } from '$lib/frcTeams.js';
  import TeamFilter from '$lib/components/TeamFilter.svelte';
  import CadViewer from '$lib/components/CadViewer.svelte';
  import { getSeasonBucket, getCurrentSeasonBucket, getAllSeasonBuckets, passesSeasonFilter } from '$lib/frcSeason.js';
  import SeasonFilter from '$lib/components/SeasonFilter.svelte';

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

<div class="page-header">
  <h1>Completed Parts</h1>
  <div class="page-actions">
    <a href="/manufacture/create" class="btn btn-primary" style="text-decoration:none;display:inline-flex;align-items:center;gap:8px;">
      <Upload size={16} />
      Create New Part
    </a>
  </div>
  
</div>
<div class="card">
  <div class="subtabs subtabs-in-card">
    <a href="/manufacture" class:active={$page.url.pathname === '/manufacture'}>ToDo</a>
    <a href="/manufacture/completed" class:active={$page.url.pathname === '/manufacture/completed'}>Completed</a>
    <a href="/manufacture/router" class:active={$page.url.pathname === '/manufacture/router'}>Router</a>
    <a href="/manufacture/post-processing" class:active={$page.url.pathname === '/manufacture/post-processing'}>Post Processing</a>
    <a href="/manufacture/files" class:active={$page.url.pathname === '/manufacture/files'}>Files</a>
  </div>

  <div class="filters" style="--filters-columns: 2fr 1fr 1fr;">
    <div class="form-group">
      <label class="form-label" for="completed-search">Search</label>
      <input id="completed-search" class="form-input" placeholder="Search by name, material, requester, or project ID..." bind:value={searchTerm} />
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
  </div>
  <div style="margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid var(--border);">
    <TeamFilter bind:show971 bind:show9584 />
  </div>
</div>

{#if loading}
  <div class="card"><p>Loading...</p></div>
{:else if filteredParts.length === 0}
  <div class="card"><p>No completed parts found.</p></div>
{:else}
  <div class="table-container">
    <table class="table">
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
  /* Same fix as /manufacture's own ToDo page: the sub-tabs used to sit in
     their own separately-margined block above the filters card, reading as
     a dead gap between two stacked containers. Now inside the same card. */
  .subtabs-in-card {
    margin: 0 0 var(--space-3);
    padding-bottom: var(--space-3);
    border-bottom: 1px solid var(--border);
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
