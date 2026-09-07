<script>
  import { requestConfirmation } from '$lib/confirmation.js';
  import { onMount } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { toastActions } from '$lib/toast.js';
  import { fetchFusionJobs, fetchFusionJobUpdates, fetchFusionJobNcFiles, cancelFusionJob, deleteFusionJob } from '$lib/fusionCam.js';
  import { formatPacificDateTimeWithZone } from '$lib/timezone.js';
  import { ListChecks, X, Download, Trash2, Upload, AlertTriangle, ChevronDown } from 'lucide-svelte';

  let jobs = [];
  let loading = true;

  // Where a job's G-code lands when someone presses "Post to Files" below -
  // the same "manufacturing-drive" bucket /manufacture/files browses. A copy
  // goes to each folder: "gcode" is where operators actually pull programs
  // from, "AutoCAM" is the generated-output folder, so neither audience has
  // to know about the other's. This is intentionally a manual action; the
  // runner never posts completed jobs automatically.
  const FILES_BUCKET = 'manufacturing-drive';
  const FILES_TARGET_FOLDERS = ['gcode', 'AutoCAM'];

  let postModalJob = null;
  let postFileName = '';
  let posting = false;
  let errorModalJob = null;
  let openFilesJobId = null;
  let refreshing = false;

  // Python tracebacks are many lines of stack frames ending in the one line
  // that actually says what went wrong (ExceptionType: message) - showing
  // the whole thing inline, on every job row, buried the useful part in
  // noise. This pulls out just that last line for the row; the full trace
  // is still one click away for whoever needs to actually debug it.
  function errorSummary(job) {
    const text = (job.errors || []).join('\n').trim();
    if (!text) return '';
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.at(-1) || text;
  }

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

  async function refreshActiveJobs() {
    if (refreshing || document.hidden) return;
    const activeIds = jobs.filter((job) => ['queued', 'claimed', 'processing'].includes(job.status)).map((job) => job.id);
    if (!activeIds.length) return;
    refreshing = true;
    try {
      const updates = await fetchFusionJobUpdates(activeIds);
      const updatesById = new Map(updates.map((update) => [update.id, update]));
      jobs = jobs.map((job) => updatesById.has(job.id) ? { ...job, ...updatesById.get(job.id) } : job);
    } catch (e) {
      console.error('Failed to refresh active Fusion jobs', e);
    } finally {
      refreshing = false;
    }
  }

  onMount(() => {
    load();
    // Active jobs (queued/claimed/processing) can change outside this tab -
    // a Runner claims/completes them independently - so poll while any are active.
    const interval = setInterval(refreshActiveJobs, 10000);
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

  function machiningTimeLabel(job) {
    const seconds = Number(job?.stats?.total_machining_time);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const minutes = Math.round(seconds / 60);
    if (minutes < 1) return 'under a minute';
    if (minutes < 60) return `about ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return rem ? `about ${hours}h ${rem}m` : `about ${hours}h`;
  }

  async function ensureNcFiles(job) {
    if (Array.isArray(job.fusion_nc_files)) return job.fusion_nc_files;
    const files = await fetchFusionJobNcFiles(job.id);
    job.fusion_nc_files = files;
    jobs = jobs.map((item) => item.id === job.id ? { ...item, fusion_nc_files: files } : item);
    return files;
  }

  async function toggleFiles(job) {
    if (openFilesJobId === job.id) {
      openFilesJobId = null;
      return;
    }
    try {
      const files = await ensureNcFiles(job);
      if (!files.length) return toastActions.show('This job has no G-code files');
      openFilesJobId = job.id;
    } catch (e) {
      toastActions.show(e.message || 'Failed to load G-code files');
    }
  }

  async function openPostModal(job) {
    try {
      const files = await ensureNcFiles(job);
      if (!files.length) return toastActions.show('This job has no G-code to post');
    } catch (e) {
      return toastActions.show(e.message || 'Failed to load G-code files');
    }
    postModalJob = job;
    postFileName = (job.name || `Job${job.id.slice(0, 8)}`).replace(/\s+/g, '');
  }

  function closePostModal() {
    postModalJob = null;
  }

  // Uploads every NC file this job produced into one shared folder in the
  // Files tab, named from the text the user typed - one file gets that
  // name exactly; more than one gets it with -1, -2, etc. so multiple
  // operations don't collide.
  async function confirmPost() {
    const job = postModalJob;
    const baseName = postFileName.trim().replace(/\s+/g, '');
    if (!baseName) {
      toastActions.show('Enter a file name');
      return;
    }
    const files = job.fusion_nc_files || [];
    if (!files.length) {
      toastActions.show('This job has no G-code to post');
      return;
    }
    posting = true;
    try {
      for (const [index, file] of files.entries()) {
        const suffix = files.length === 1 ? '' : `-${index + 1}`;
        const binary = atob(file.contentBase64);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        for (const folder of FILES_TARGET_FOLDERS) {
          const path = `${folder}/${baseName}${suffix}.ngc`;
          const { error } = await supabase.storage
            .from(FILES_BUCKET)
            .upload(path, new Blob([bytes]), { upsert: true, contentType: 'text/plain' });
          if (error) throw error;
        }
      }
      toastActions.show(`Posted to Files / ${FILES_TARGET_FOLDERS.join(' and / ')}`);
      closePostModal();
    } catch (e) {
      toastActions.show(e.message || 'Failed to post to Files');
    } finally {
      posting = false;
    }
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
        {#if job.status === 'completed' && machiningTimeLabel(job)}
          <p class="cam-form-hint" title="Estimated time to cut this on the machine, not counting load/unload">
            Machining time: {machiningTimeLabel(job)}
          </p>
        {/if}
        {#if job.status === 'failed' && job.errors?.length}
          <button type="button" class="job-error-button" on:click={() => (errorModalJob = job)}>
            <AlertTriangle size={14} /> {errorSummary(job)}
          </button>
        {/if}
        <div class="cam-list-actions">
          {#if job.status === 'completed' && jobKind(job) !== 'plate:arrange'}
            <div class="files-dropdown">
              <button type="button" class="btn btn-secondary btn-sm" on:click={() => toggleFiles(job)}>
                <Download size={14} /> {Array.isArray(job.fusion_nc_files) ? `${job.fusion_nc_files.length} file${job.fusion_nc_files.length === 1 ? '' : 's'}` : 'Files'} <ChevronDown size={13} />
              </button>
              {#if openFilesJobId === job.id}
                <div class="files-dropdown-menu">
                  {#each job.fusion_nc_files as file}
                    <button type="button" class="files-dropdown-item" title={`SHA-256 ${file.sha256}`} on:click={() => downloadNcFile(file)}>
                      <span class="file-name">{file.name}</span>
                      <span class="file-size">{file.size} bytes</span>
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
            <button class="btn btn-secondary btn-sm" title="Copy this job's G-code into Files / {FILES_TARGET_FOLDERS.join(' and / ')}" on:click={() => openPostModal(job)}>
              <Upload size={14} /> Post to Files
            </button>
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

{#if errorModalJob}
  <div class="modal-overlay" role="presentation" on:click={() => (errorModalJob = null)}>
    <div class="modal error-modal" role="dialog" aria-labelledby="error-modal-title" on:click|stopPropagation>
      <div class="modal-header">
        <h3 id="error-modal-title">{errorModalJob.name || `Job ${errorModalJob.id.slice(0, 8)}`}</h3>
        <button type="button" class="btn btn-ghost btn-sm" title="Close" on:click={() => (errorModalJob = null)}><X size={16} /></button>
      </div>
      <div class="modal-body">
        <pre class="job-error-detail">{(errorModalJob.errors || []).join('\n\n')}</pre>
      </div>
    </div>
  </div>
{/if}

{#if postModalJob}
  <div class="modal-overlay" role="presentation" on:click={closePostModal}>
    <div class="modal post-modal" role="dialog" aria-labelledby="post-modal-title" on:click|stopPropagation>
      <div class="modal-header">
        <h3 id="post-modal-title">Post to Files</h3>
        <button type="button" class="btn btn-ghost btn-sm" title="Close" on:click={closePostModal}><X size={16} /></button>
      </div>
      <div class="modal-body">
        <p class="cam-form-hint">
          Copies this job's G-code into Files / {FILES_TARGET_FOLDERS.join(' and / ')}, where anyone can grab it.
          {#if postModalJob.fusion_nc_files?.length > 1}This job has {postModalJob.fusion_nc_files.length} files - each gets this name with -1, -2, etc.{/if}
        </p>
        <div class="form-group">
          <label class="form-label" for="post-file-name">File name</label>
          <input
            id="post-file-name"
            class="form-input"
            value={postFileName}
            on:input={(e) => (postFileName = e.currentTarget.value.replace(/\s+/g, ''))}
            on:keydown={(e) => { if (e.key === 'Enter') confirmPost(); }}
          />
        </div>
      </div>
      <div class="modal-footer-actions">
        <button class="btn btn-ghost" type="button" on:click={closePostModal}>Cancel</button>
        <button class="btn btn-primary" type="button" disabled={posting} on:click={confirmPost}>
          <Upload size={14} /> {posting ? 'Posting…' : 'Post'}
        </button>
      </div>
    </div>
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

  .job-error-button {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: none;
    border: none;
    padding: 0;
    margin-top: 0.35rem;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.85rem;
    color: var(--danger, #e05252);
    text-align: left;
    max-width: 100%;
  }
  .job-error-button:hover { text-decoration: underline; }
  .job-error-button :global(svg) { flex-shrink: 0; }
  .error-modal { width: min(800px, 92vw); }
  .job-error-detail {
    background: var(--surface-2, var(--background));
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.75rem;
    max-height: 60vh;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--font-mono, monospace);
    font-size: 0.8rem;
    margin: 0;
  }

  .files-dropdown { position: relative; }
  .files-dropdown-menu {
    position: absolute;
    top: calc(100% + 0.25rem);
    left: 0;
    z-index: 20;
    min-width: 16rem;
    max-height: 16rem;
    overflow-y: auto;
    background: var(--surface-1, #fff);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 6px);
    box-shadow: var(--shadow-md, 0 4px 12px rgba(0, 0, 0, 0.12));
    display: flex;
    flex-direction: column;
    padding: 0.25rem;
  }
  .files-dropdown-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    background: none;
    border: none;
    padding: 0.4rem 0.5rem;
    border-radius: var(--radius-sm, 4px);
    cursor: pointer;
    font-size: 0.85rem;
    color: var(--text);
    text-align: left;
  }
  .files-dropdown-item:hover { background: var(--surface-2); }
  .files-dropdown-item .file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .files-dropdown-item .file-size { color: var(--text-muted); font-size: 0.75rem; flex-shrink: 0; }
</style>
