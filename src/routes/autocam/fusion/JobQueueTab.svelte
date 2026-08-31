<script>
  import { requestConfirmation } from '$lib/confirmation.js';
  import { onMount } from 'svelte';
  import { toastActions } from '$lib/toast.js';
  import { fetchFusionJobs, cancelFusionJob } from '$lib/fusionCam.js';
  import { formatPacificDateTimeWithZone } from '$lib/timezone.js';
  import { ListChecks, X, Download } from 'lucide-svelte';

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

  async function load() {
    loading = true;
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
      if (jobs.some((j) => ['queued', 'claimed', 'processing'].includes(j.status))) load();
    }, 10000);
    return () => clearInterval(interval);
  });

  async function handleCancel(job) {
    if (!await requestConfirmation({ title: 'Cancel job', message: `Cancel job "${job.name || job.id}"?`, confirmLabel: 'Cancel job', danger: true })) return;
    try {
      await cancelFusionJob(job.id);
      await load();
    } catch (e) {
      toastActions.show(e.message || 'Failed to cancel job');
    }
  }

  function jobKind(job) {
    return job.params?.fusionJobKind || 'unknown';
  }

  function downloadGcode(job) {
    if (!job.gcode) return;
    const blob = new Blob([job.gcode], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = job.gcode_file_name || 'output.ngc';
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
    {#each jobs as job}
      <div class="card cam-list-item">
        <div class="cam-list-header">
          <strong><ListChecks size={16} /> {job.name || `Job ${job.id.slice(0, 8)}`}</strong>
          <span class="tag status-{job.status}">{STATUS_LABELS[job.status] || job.status}</span>
        </div>
        <p class="cam-form-hint">
          {jobKind(job)} - {job.cam_machines?.name || 'no machine assigned'} - queued {formatPacificDateTimeWithZone(job.created_at)}
          {#if job.claimed_by} - claimed by {job.claimed_by}{/if}
        </p>
        {#if job.status === 'failed' && job.errors?.length}
          <p class="cam-form-hint error-text">{job.errors.join('; ')}</p>
        {/if}
        <div class="cam-list-actions">
          {#if job.status === 'completed' && job.gcode}
            <button class="btn btn-secondary btn-sm" on:click={() => downloadGcode(job)}>
              <Download size={14} /> Download G-code
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
