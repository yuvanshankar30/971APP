<script>
  import { createEventDispatcher } from 'svelte';
  import { Folder, FolderPlus, File, Trash2, Pencil, ChevronRight, X, RefreshCw, ExternalLink, Upload, Check } from 'lucide-svelte';
  import { listOutputRepoEntries, createOutputRepoFolder, deleteOutputRepoEntry, renameOutputRepoEntry, uploadOutputRepoFile } from '$lib/jprog_output_manage.js';
  import { requestConfirmation } from '$lib/confirmation.js';
  import { toastActions } from '$lib/toast.js';

  const dispatch = createEventDispatcher();

  export let repositoryUrl = '';

  let path = '';
  let entries = [];
  let loading = false;
  let busy = false;
  let renamingPath = null;
  let renameValue = '';
  let creatingFolder = false;
  let newFolderName = '';

  $: breadcrumbs = [{ label: 'Output', path: '' }, ...path.split('/').filter(Boolean).map((part, index, all) => ({
    label: part,
    path: all.slice(0, index + 1).join('/')
  }))];

  async function load(nextPath = path) {
    loading = true;
    try {
      entries = await listOutputRepoEntries(nextPath);
      path = nextPath;
    } catch (error) {
      toastActions.show(error.message || 'Could not load that folder');
    } finally {
      loading = false;
    }
  }

  function openEntry(entry) {
    if (entry.type === 'dir') load(entry.path);
  }

  function close() {
    dispatch('close');
  }

  async function handleFileUpload(event) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    busy = true;
    try {
      await uploadOutputRepoFile(path ? `${path}/${file.name}` : file.name, file);
      await load();
      toastActions.show(`Uploaded ${file.name}`);
    } catch (error) {
      toastActions.show(error.message || 'Could not upload that file');
    } finally {
      busy = false;
    }
  }

  async function startNewFolder() {
    creatingFolder = true;
    newFolderName = '';
  }

  async function confirmNewFolder() {
    const name = newFolderName.trim();
    if (!name) { creatingFolder = false; return; }
    busy = true;
    try {
      await createOutputRepoFolder(path ? `${path}/${name}` : name);
      creatingFolder = false;
      await load();
      toastActions.show(`Created ${name}`);
    } catch (error) {
      toastActions.show(error.message || 'Could not create that folder');
    } finally {
      busy = false;
    }
  }

  async function removeEntry(entry) {
    const confirmed = await requestConfirmation({
      title: `Delete ${entry.name}?`,
      message: entry.type === 'dir'
        ? `This deletes every file inside ${entry.name} from the GitHub repository. This cannot be undone.`
        : `This deletes ${entry.name} from the GitHub repository. This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true
    });
    if (!confirmed) return;
    busy = true;
    try {
      await deleteOutputRepoEntry(entry.path);
      await load();
      toastActions.show(`Deleted ${entry.name}`);
    } catch (error) {
      toastActions.show(error.message || 'Could not delete that item');
    } finally {
      busy = false;
    }
  }

  function startRename(entry) {
    renamingPath = entry.path;
    renameValue = entry.name;
  }

  function cancelRename() {
    renamingPath = null;
    renameValue = '';
  }

  async function confirmRename(entry) {
    const name = renameValue.trim();
    if (!name || name === entry.name) { cancelRename(); return; }
    const parent = entry.path.slice(0, entry.path.length - entry.name.length);
    busy = true;
    try {
      await renameOutputRepoEntry(entry.path, `${parent}${name}`);
      cancelRename();
      await load();
      toastActions.show(`Renamed to ${name}`);
    } catch (error) {
      toastActions.show(error.message || 'Could not rename that item');
    } finally {
      busy = false;
    }
  }

  load('');
</script>

<div class="scrim" role="presentation" on:click|self={close}>
  <div class="modal output-editor-modal" role="dialog" aria-label="Output repository editor">
    <button type="button" class="modal-close" title="Close" on:click={close}><X size={18} /></button>
    <h2>Output Repository</h2>
    <div class="output-editor-toolbar">
      <nav class="output-editor-breadcrumbs" aria-label="Folder path">
        {#each breadcrumbs as crumb, index}
          {#if index > 0}<ChevronRight size={13} />{/if}
          <button type="button" on:click={() => load(crumb.path)}>{crumb.label}</button>
        {/each}
      </nav>
      <div class="row">
        <button type="button" class="btn btn-secondary btn-sm" on:click={() => load()} disabled={loading}><RefreshCw size={14} /> Reload</button>
        <button type="button" class="btn btn-secondary btn-sm" on:click={startNewFolder} disabled={busy}><FolderPlus size={14} /> New folder</button>
        <label class="btn btn-secondary btn-sm">
          <Upload size={14} /> Upload file
          <input type="file" on:change={handleFileUpload} disabled={busy} />
        </label>
        {#if repositoryUrl}
          <a class="btn btn-secondary btn-sm" href={`${repositoryUrl}/tree/main/${path}`} target="_blank" rel="noreferrer"><ExternalLink size={14} /> View on GitHub</a>
        {/if}
      </div>
    </div>

    {#if creatingFolder}
      <div class="output-editor-new-folder">
        <input
          aria-label="New folder name"
          placeholder="Folder name"
          bind:value={newFolderName}
          on:keydown={(event) => { if (event.key === 'Enter') confirmNewFolder(); if (event.key === 'Escape') creatingFolder = false; }}
          autofocus
        />
        <button type="button" class="btn btn-primary btn-sm" on:click={confirmNewFolder} disabled={busy}>Create</button>
        <button type="button" class="btn btn-secondary btn-sm" on:click={() => (creatingFolder = false)}>Cancel</button>
      </div>
    {/if}

    <div class="output-editor-list">
      {#if loading}
        <p class="hint">Loading...</p>
      {:else if !entries.length}
        <p class="hint">This folder is empty.</p>
      {:else}
        {#each entries as entry (entry.path)}
          <div class="output-editor-row">
            {#if entry.type === 'dir'}<Folder size={16} />{:else}<File size={16} />{/if}
            {#if renamingPath === entry.path}
              <input
                aria-label={`Rename ${entry.name}`}
                bind:value={renameValue}
                on:keydown={(event) => { if (event.key === 'Enter') confirmRename(entry); if (event.key === 'Escape') cancelRename(); }}
                autofocus
              />
              <button type="button" class="icon-button" title="Save name" on:click={() => confirmRename(entry)}><Check size={15} /></button>
              <button type="button" class="icon-button" title="Cancel rename" on:click={cancelRename}><X size={15} /></button>
            {:else}
              {#if entry.type === 'dir'}
                <button type="button" class="output-editor-entry-name" on:click={() => openEntry(entry)}>{entry.name}</button>
              {:else}
                <span class="output-editor-entry-name">{entry.name}</span>
              {/if}
              <button type="button" class="icon-button" title={`Rename ${entry.name}`} on:click={() => startRename(entry)} disabled={busy}><Pencil size={15} /></button>
              <button type="button" class="icon-button danger" title={`Delete ${entry.name}`} on:click={() => removeEntry(entry)} disabled={busy}><Trash2 size={15} /></button>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  /* +page.svelte defines .scrim/.modal/.modal-close in its own scoped
     <style> block rather than globally in app.css - as a separate
     component, this file gets none of that scoping, so it needs its own
     copy of the same base rules (confirmed live: without these, the modal
     rendered unstyled in normal document flow at the bottom of the page
     instead of as a centered fixed overlay). */
  .scrim { position: fixed; inset: 0; background: #10182899; display: grid; place-items: center; z-index: 10; }
  .modal { position: relative; background: var(--surface-1); padding: 22px; display: grid; gap: 14px; border-radius: 8px; max-height: calc(100vh - 32px); overflow: auto; }
  .modal h2 { margin: 0; }
  .modal-close { position: absolute; right: 12px; top: 12px; border: 0; background: none; color: inherit; cursor: pointer; }
  .output-editor-modal { width: min(760px, 90vw); height: 70vh; display: flex; flex-direction: column; }
  .output-editor-toolbar { display: flex; align-items: center; justify-content: center; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
  .output-editor-breadcrumbs { display: flex; align-items: center; gap: 0.25rem; flex-wrap: wrap; }
  .output-editor-breadcrumbs button { background: none; border: none; color: var(--text); cursor: pointer; padding: 0.15rem 0.25rem; font-size: 0.9rem; }
  .output-editor-breadcrumbs button:hover { text-decoration: underline; }
  .output-editor-toolbar input[type="file"] { display: none; }
  .output-editor-new-folder { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; }
  .output-editor-new-folder input { flex: 1; }
  .output-editor-list { flex: 1; overflow-y: auto; display: grid; align-content: start; gap: 0.35rem; }
  .output-editor-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.5rem; border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .output-editor-entry-name { flex: 1; text-align: left; background: none; border: none; color: var(--text); cursor: default; font-size: 0.9rem; padding: 0; }
  button.output-editor-entry-name { cursor: pointer; }
  button.output-editor-entry-name:hover { text-decoration: underline; }
  .output-editor-row input { flex: 1; }
  .row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
</style>
