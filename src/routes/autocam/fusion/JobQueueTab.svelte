<script>
  import { requestConfirmation } from '$lib/confirmation.js';
  import { onMount } from 'svelte';
  import { toastActions } from '$lib/toast.js';
  import { fetchFusionJobs, cancelFusionJob, deleteFusionJob } from '$lib/fusionCam.js';
  import { formatPacificDateTimeWithZone } from '$lib/timezone.js';
  import { ListChecks, X, Download, Trash2 } from 'lucide-svelte';

  let jobs = [];
  let loading = true;

  const STATUS_LABELS = {
    queued: 'Queued - waiting for a Runner',
    claimed: 'Claimed by a Runner',
    processing: 'Processing in Fusion 360',
    completed: 'Completed',
    failed: 'Failed',
    rejected: 'Rejected'
  };

  // showLoading=false for refreshes after an action, and for the polling
  // interval below - flipping loading back to true replaced the whole table
  // with a loading state and back, a jarring flash. With the 10s poll this
  // was firing on every tick a job was active, not just after an action.
  // Only the initial mount needs it.
  async function load(showLoading = true) {
    if (showLoading) loading = true;
    try {
      jobs = await fetchFusionJobs();
    } catch (e) {
      toastActions.show(e.message || 'Failed to load jobs');
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    load();
    // Active jobs (queued/claimed/processing) can change outside this tab -
    // a Runner claims/completes them independently - so poll while any are active.
    const interval = setInterval(() => {
      if (jobs.some((j) => ['queued', 'claimed', 'processing'].includes(j.status))) load(false);
    }, 10000);
    return () => clearInterval(interval);
  });

  async function handleCancel(job) {
    if (!await requestConfirmation({ title: 'Cancel job', message: `Cancel job "${job.name || job.id}"?`, confirmLabel: 'Cancel job', danger: true })) return;
    try {
      await cancelFusionJob(job.id);
      await load(false);
    } catch (e) {
      toastActions.show(e.message || 'Failed to cancel job');
    }
  }

  async function handleDelete(job) {
    if (!await requestConfirmation({
      title: 'Delete Fusion job',
      message: `Permanently delete "${job.name || job.id}" and its saved NC output?`,
      confirmLabel: 'Delete job',
      danger: true
    })) return;
    try {
      await deleteFusionJob(job.id);
      jobs = jobs.filter((item) => item.id !== job.id);
    } catch (e) {
      toastActions.show(e.message || 'Failed to delete job');
      await load(false);
    }
  }

  function jobKind(job) {
    return job.params?.fusionJobKind || 'unknown';
  }

  function downloadNcFile(file) {
    const binary = atob(file.contentBase64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name.split('/').at(-1) || 'fusion-output.nc';
    a.click();
    URL.revokeObjectURL(url);
  }
</script>

{#if loading}
  <p>Loading jobs...</p>
{:else if jobs.length === 0}
  <p class="empty-state">No Fusion CAM jobs yet - queue one from the Plates or Box Tubes tab.</p>
{:else}
  <div class="cam-list">
    {#each jobs as job (job.id)}
      <div class="card cam-list-item">
        <div class="cam-list-header">
          <strong><ListChecks size={16} /> {job.name || `Job ${job.id.slice(0, 8)}`}</strong>
          <span>
            {#if job.params?.fusionGroupingMode === 'grouped'}<span class="tag">Grouped</span>{/if}
            <span class="tag status-{job.status}">{STATUS_LABELS[job.status] || job.status}</span>
          </span>
        </div>
        <p class="cam-form-hint">
          {jobKind(job)} - plate {job.params?.fusionPlateSnapshot?.name || job.params?.plateId || 'n/a'}
          - {job.cam_machines?.name || 'no machine assigned'}
          - {job.cam_tools?.name || 'no tool assigned'}
          - queued {formatPacificDateTimeWithZone(job.created_at)}
          {#if job.claimed_by} - claimed by {job.claimed_by}{/if}
        </p>
        {#if job.params?.fusionPlateSnapshot?.assignments?.length}
          <p class="cam-form-hint">
            Parts: {job.params.fusionPlateSnapshot.assignments.map((part) => `${part.quantity}x ${part.name || part.part_id}`).join(', ')}
          </p>
        {/if}
        {#if job.status === 'failed' && job.errors?.length}
          <p class="cam-form-hint error-text">{job.errors.join('; ')}</p>
        {/if}
        <div class="cam-list-actions">
          {#if job.status === 'completed' && job.fusion_nc_files?.length}
            {#each job.fusion_nc_files as file}
              <button class="btn btn-secondary btn-sm" title={`${file.name} · SHA-256 ${file.sha256}`} on:click={() => downloadNcFile(file)}>
                <Download size={14} /> {file.name} ({file.size} bytes)
              </button>
            {/each}
          {/if}
          {#if ['queued', 'completed', 'failed', 'rejected'].includes(job.status)}
            <button class="btn btn-ghost btn-sm" on:click={() => handleDelete(job)}>
              <Trash2 size={14} /> Delete
            </button>
          {/if}
          {#if ['queued', 'claimed', 'processing'].includes(job.status)}
            <button class="btn btn-ghost btn-sm" on:click={() => handleCancel(job)}>
              <X size={14} /> Cancel
            </button>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .cam-list { display: flex; flex-direction: column; gap: 0.75rem; }
  .cam-list-item { padding: 1rem; }
  .cam-list-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .cam-list-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  .empty-state { color: var(--text-muted, #888); padding: 2rem 0; text-align: center; }
  .error-text { color: var(--danger, #e05252); }
  .cam-form-hint { color: var(--text-muted, #888); font-size: 0.85rem; margin: 0.25rem 0 0; }

  /* Status tags were previously unstyled (no .status-* rule existed anywhere,
     so every job looked identical regardless of state). Matches Valor's own
     plate-ready/plate-cooking convention: green when done, gold while
     actively running, red on failure. */
  .status-queued { background: var(--muted-bg, #eee); color: var(--text-muted, #888); }
  .status-claimed { background: rgba(47, 129, 247, 0.14); color: var(--accent, #2f81f7); }
  .status-processing { background: rgba(230, 221, 94, 0.16); color: #b18f1d; }
  .status-completed { background: rgba(46, 160, 67, 0.16); color: var(--success, #2ea043); }
  .status-failed,
  .status-rejected { background: rgba(248, 81, 73, 0.14); color: var(--danger, #f85149); }
</style>
