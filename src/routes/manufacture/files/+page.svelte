<script>
  import { onMount } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { isJprogOutputPath, jprogOutputUploadPath, publishJprogOutput } from '$lib/jprog_output.js';
  import {
    listOutputRepoEntries,
    createOutputRepoFolder,
    deleteOutputRepoEntry,
    renameOutputRepoEntry
  } from '$lib/jprog_output_manage.js';
  import { page } from '$app/stores';
  import { toastActions } from '$lib/toast.js';
  import { requestConfirmation } from '$lib/confirmation.js';
  import { Folder, FolderPlus, Upload, Download, Trash2, File as FileIcon, Home, Pencil, Check, X } from 'lucide-svelte';

  const BUCKET = 'manufacturing-drive';
  // Supabase's own dashboard convention for representing an otherwise-empty
  // folder in object storage (which has no real concept of a folder, only
  // "/"-delimited object paths) - a hidden placeholder object inside it, so
  // list() has something to report at that prefix before any real file
  // exists there. Filtered out of the UI below, never shown as a "file."
  const EMPTY_FOLDER_MARKER = '.emptyFolderPlaceholder';

  // '' = root, otherwise "a/b/c" (no leading/trailing slash). Seeded from
  // ?path= so a link elsewhere (e.g. the "BOM Files" shortcut on /cad) can
  // deep-link straight into a folder instead of always opening at root.
  let currentPath = $page.url.searchParams.get('path') || '';
  let entries = [];
  let loading = true;
  let uploading = false;
  let newFolderName = '';
  let showNewFolderInput = false;
  let fileInput;
  // Full path (relative to the bucket root) of the entry currently being
  // renamed, or '' when nothing is - only one row can be renamed at a time.
  let renamingPath = '';
  let renameValue = '';
  // Bulk-select-and-delete, keyed by entry name within the CURRENT folder
  // only - cleared on every navigation (see load()) since a name is only
  // meaningful relative to whatever folder it was selected in.
  let selectedNames = new Set();
  let bulkDeleting = false;

  $: breadcrumbs = currentPath ? currentPath.split('/') : [];

  function joinPath(prefix, name) {
    return prefix ? `${prefix}/${name}` : name;
  }

  const isJprogOutput = isJprogOutputPath;

  // This bucket's own listing was never the source of truth for
  // JustinProgOutput - that folder is a real GitHub repo (see
  // OutputEditorModal.svelte, JProg's own "Output Repository" editor,
  // which already reads/writes it live). This view showed a stale,
  // separate Supabase Storage copy that only ever changed when something
  // uploaded through THIS page's own upload button - a dated folder added
  // by any other means (JProg itself, or a machine-local sync script)
  // never appeared here at all. Every JustinProgOutput action below reads
  // and writes the real repo directly instead.
  const JPROG_OUTPUT_ROOT = 'JustinProgOutput';
  function isInJprogOutputRepo(path) {
    return path === JPROG_OUTPUT_ROOT || path.startsWith(`${JPROG_OUTPUT_ROOT}/`);
  }
  function githubRelativePath(path) {
    return path === JPROG_OUTPUT_ROOT ? '' : path.slice(JPROG_OUTPUT_ROOT.length + 1);
  }
  // Matches this page's own isFolder() convention (id === null/undefined
  // means folder) so the GitHub-backed listing renders through the exact
  // same template as the Supabase-backed one.
  function toEntryShape(githubEntry) {
    return {
      name: githubEntry.name,
      id: githubEntry.type === 'dir' ? null : githubEntry.path,
      metadata: { size: githubEntry.size }
    };
  }

  async function load() {
    loading = true;
    selectedNames = new Set();
    try {
      if (isInJprogOutputRepo(currentPath)) {
        const githubEntries = await listOutputRepoEntries(githubRelativePath(currentPath));
        entries = githubEntries.map(toEntryShape);
      } else {
        const { data, error } = await supabase.storage.from(BUCKET).list(currentPath, {
          sortBy: { column: 'name', order: 'asc' }
        });
        if (error) throw error;
        entries = (data || []).filter((e) => e.name !== EMPTY_FOLDER_MARKER);
      }
    } catch (e) {
      toastActions.show(e.message || 'Failed to load files');
      entries = [];
    } finally {
      loading = false;
    }
  }

  // Creates `path` (with the same empty-placeholder convention as
  // handleCreateFolder) if it doesn't already show up in its parent's
  // listing - a link that deep-links here via ?path= (the "BOM Files"
  // shortcut on /cad) shouldn't land on an empty "does not exist" view the
  // very first time anyone visits it.
  async function ensureFolderExists(path) {
    if (!path) return;
    const segments = path.split('/');
    const name = segments.pop();
    const parent = segments.join('/');
    try {
      const { data } = await supabase.storage.from(BUCKET).list(parent);
      const exists = (data || []).some((e) => e.name === name);
      if (!exists) {
        await supabase.storage.from(BUCKET).upload(joinPath(path, EMPTY_FOLDER_MARKER), new Blob(['']));
      }
    } catch (e) {
      console.warn('Failed to ensure folder exists:', path, e);
    }
  }

  onMount(async () => {
    if (currentPath) await ensureFolderExists(currentPath);
    await load();
  });

  // Storage's list() has no "type" field - a folder shows up as an entry
  // with id === null (no metadata, since it isn't a real object itself,
  // just an implied prefix); a real uploaded file always has an id.
  function isFolder(entry) {
    return entry.id === null || entry.id === undefined;
  }

  function openFolder(entry) {
    currentPath = joinPath(currentPath, entry.name);
    load();
  }

  function goToBreadcrumb(index) {
    // index === -1 means "Home" (root)
    currentPath = index < 0 ? '' : breadcrumbs.slice(0, index + 1).join('/');
    load();
  }

  async function handleCreateFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    if (/[\\/]/.test(name)) {
      toastActions.show('Folder name can\'t contain / or \\');
      return;
    }
    try {
      if (isInJprogOutputRepo(currentPath)) {
        await createOutputRepoFolder(githubRelativePath(joinPath(currentPath, name)));
      } else {
        const { error } = await supabase.storage
          .from(BUCKET)
          .upload(joinPath(joinPath(currentPath, name), EMPTY_FOLDER_MARKER), new Blob(['']));
        if (error) throw error;
      }
      newFolderName = '';
      showNewFolderInput = false;
      await load();
      toastActions.show('Folder created');
    } catch (e) {
      toastActions.show(e.message || 'Failed to create folder');
    }
  }

  async function handleUpload(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    uploading = true;
    try {
      for (const file of files) {
        const storagePath = jprogOutputUploadPath(currentPath, file.name) || joinPath(currentPath, file.name);
        const { error } = await supabase.storage
          .from(BUCKET)
          .upload(storagePath, file, { upsert: true });
        if (error) throw error;
        if (isJprogOutput(storagePath)) await publishJprogOutput(storagePath, await file.text());
      }
      toastActions.show(`Uploaded ${files.length} file${files.length === 1 ? '' : 's'}`);
    } catch (e) {
      toastActions.show(e.message || 'Upload failed');
    } finally {
      uploading = false;
      if (fileInput) fileInput.value = '';
      await load();
    }
  }

  // Fetches the file itself and saves it via a blob URL instead of
  // navigating anywhere - no new tab, no visible redirect through
  // Supabase's storage domain, and it sidesteps the popup-blocking some
  // browsers apply to a window.open() that isn't in the same tick as the
  // click (which the previous new-tab-based approach ran into).
  async function handleDownload(entry) {
    try {
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(joinPath(currentPath, entry.name), 300);
      if (error || !data?.signedUrl) throw error || new Error('Could not create download link');
      const response = await fetch(data.signedUrl);
      if (!response.ok) throw new Error('Failed to fetch file');
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = entry.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(blobUrl);
    } catch (e) {
      toastActions.show(e.message || 'Download failed');
    }
  }

  async function handleDeleteFile(entry) {
    if (!await requestConfirmation({ title: 'Delete file', message: `Delete "${entry.name}"?`, confirmLabel: 'Delete', danger: true })) return;
    try {
      if (isInJprogOutputRepo(currentPath)) {
        await deleteOutputRepoEntry(githubRelativePath(joinPath(currentPath, entry.name)));
      } else {
        const { error } = await supabase.storage.from(BUCKET).remove([joinPath(currentPath, entry.name)]);
        if (error) throw error;
      }
      await load();
      toastActions.show('File deleted');
    } catch (e) {
      toastActions.show(e.message || 'Failed to delete file');
    }
  }

  // Storage's list() only sees one level at a time, so deleting a folder
  // means walking every level under it first to collect every real object
  // path (including nested placeholders), then removing them all at once -
  // remove() doesn't accept a bare prefix.
  async function listAllPaths(prefix) {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix);
    if (error) throw error;
    const paths = [];
    for (const entry of data || []) {
      const fullPath = joinPath(prefix, entry.name);
      if (isFolder(entry)) {
        paths.push(...await listAllPaths(fullPath));
      } else {
        paths.push(fullPath);
      }
    }
    return paths;
  }

  async function handleDeleteFolder(entry) {
    if (!await requestConfirmation({ title: 'Delete folder', message: `Delete "${entry.name}" and everything inside it? This can't be undone.`, confirmLabel: 'Delete', danger: true })) return;
    try {
      const folderPath = joinPath(currentPath, entry.name);
      if (isInJprogOutputRepo(currentPath)) {
        await deleteOutputRepoEntry(githubRelativePath(folderPath));
      } else {
        const paths = await listAllPaths(folderPath);
        if (paths.length) {
          const { error } = await supabase.storage.from(BUCKET).remove(paths);
          if (error) throw error;
        }
      }
      await load();
      toastActions.show('Folder deleted');
    } catch (e) {
      toastActions.show(e.message || 'Failed to delete folder');
    }
  }

  function toggleEntrySelected(entry) {
    const next = new Set(selectedNames);
    if (next.has(entry.name)) next.delete(entry.name); else next.add(entry.name);
    selectedNames = next;
  }

  function toggleSelectAll() {
    selectedNames = selectedNames.size === entries.length ? new Set() : new Set(entries.map((e) => e.name));
  }

  async function handleBulkDelete() {
    const selected = entries.filter((e) => selectedNames.has(e.name));
    if (!selected.length) return;
    if (!await requestConfirmation({
      title: 'Delete selected',
      message: `Delete ${selected.length} selected item${selected.length === 1 ? '' : 's'}? Any selected folder is deleted along with everything inside it. This can't be undone.`,
      confirmLabel: 'Delete',
      danger: true
    })) return;
    bulkDeleting = true;
    try {
      if (isInJprogOutputRepo(currentPath)) {
        for (const entry of selected) {
          await deleteOutputRepoEntry(githubRelativePath(joinPath(currentPath, entry.name)));
        }
      } else {
        const paths = [];
        for (const entry of selected) {
          const entryPath = joinPath(currentPath, entry.name);
          if (isFolder(entry)) {
            paths.push(...await listAllPaths(entryPath));
          } else {
            paths.push(entryPath);
          }
        }
        if (paths.length) {
          const { error } = await supabase.storage.from(BUCKET).remove(paths);
          if (error) throw error;
        }
      }
      selectedNames = new Set();
      await load();
      toastActions.show(`Deleted ${selected.length} item${selected.length === 1 ? '' : 's'}`);
    } catch (e) {
      toastActions.show(e.message || 'Failed to delete selected items');
    } finally {
      bulkDeleting = false;
    }
  }

  function startRename(entry) {
    renamingPath = joinPath(currentPath, entry.name);
    renameValue = entry.name;
  }

  function cancelRename() {
    renamingPath = '';
    renameValue = '';
  }

  function validateNewName(name) {
    if (!name) return 'Name cannot be empty';
    if (/[\\/]/.test(name)) return 'Name can\'t contain / or \\';
    return null;
  }

  async function handleRenameFile(entry) {
    const name = renameValue.trim();
    const error = validateNewName(name);
    if (error) {
      toastActions.show(error);
      return;
    }
    if (name === entry.name) {
      cancelRename();
      return;
    }
    try {
      if (isInJprogOutputRepo(currentPath)) {
        await renameOutputRepoEntry(
          githubRelativePath(joinPath(currentPath, entry.name)),
          githubRelativePath(joinPath(currentPath, name))
        );
      } else {
        const { error: moveError } = await supabase.storage
          .from(BUCKET)
          .move(joinPath(currentPath, entry.name), joinPath(currentPath, name));
        if (moveError) throw moveError;
        const destination = joinPath(currentPath, name);
        if (isJprogOutput(destination)) {
          const { data, error: downloadError } = await supabase.storage.from(BUCKET).download(destination);
          if (downloadError) throw downloadError;
          await publishJprogOutput(destination, await data.text());
        }
      }
      cancelRename();
      await load();
      toastActions.show('File renamed');
    } catch (e) {
      toastActions.show(e.message || 'Failed to rename file');
    }
  }

  // Storage has no native folder rename - a "folder" is only ever an implied
  // path prefix, so renaming one means moving every real object underneath
  // it (found via the same recursive listAllPaths() delete already uses)
  // from the old prefix to the new one, one at a time.
  async function handleRenameFolder(entry) {
    const name = renameValue.trim();
    const error = validateNewName(name);
    if (error) {
      toastActions.show(error);
      return;
    }
    if (name === entry.name) {
      cancelRename();
      return;
    }
    try {
      const oldPrefix = joinPath(currentPath, entry.name);
      const newPrefix = joinPath(currentPath, name);
      if (isInJprogOutputRepo(currentPath)) {
        await renameOutputRepoEntry(githubRelativePath(oldPrefix), githubRelativePath(newPrefix));
      } else {
        const paths = await listAllPaths(oldPrefix);
        for (const path of paths) {
          const relative = path.slice(oldPrefix.length); // keeps the leading "/..."
          const { error: moveError } = await supabase.storage.from(BUCKET).move(path, `${newPrefix}${relative}`);
          if (moveError) throw moveError;
        }
      }
      cancelRename();
      await load();
      toastActions.show('Folder renamed');
    } catch (e) {
      toastActions.show(e.message || 'Failed to rename folder');
    }
  }

  function autofocus(node) {
    node.focus();
    node.select();
  }

  function formatSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatAddedAt(entry) {
    const value = entry?.created_at || entry?.updated_at;
    return value ? new Date(value).toLocaleString() : 'Unknown date';
  }
</script>

<svelte:head><title>Files | Manufacturing</title></svelte:head>

<div class="page-header">
  <h1>Files</h1>
  <div class="page-actions">
    <button class="btn btn-secondary" on:click={() => (showNewFolderInput = !showNewFolderInput)}>
      <FolderPlus size={16} /> New Folder
    </button>
    <button class="btn btn-primary" disabled={uploading} on:click={() => fileInput?.click()}>
      <Upload size={16} /> {uploading ? 'Uploading...' : 'Upload'}
    </button>
    <input bind:this={fileInput} type="file" multiple style="display:none" on:change={handleUpload} />
  </div>
</div>

<div class="subtabs">
  <a href="/manufacture" class:active={$page.url.pathname === '/manufacture'}>ToDo</a>
  <a href="/manufacture/completed" class:active={$page.url.pathname === '/manufacture/completed'}>Completed</a>
  <a href="/manufacture/router" class:active={$page.url.pathname === '/manufacture/router'}>Router</a>
  <a href="/manufacture/post-processing" class:active={$page.url.pathname === '/manufacture/post-processing'}>Post Processing</a>
  <a href="/manufacture/bins" class:active={$page.url.pathname === '/manufacture/bins'}>Bins</a>
  <a href="/manufacture/gcode-converter" class:active={$page.url.pathname === '/manufacture/gcode-converter'}>G-code Converter</a>
  <a href="/manufacture/files" class:active={$page.url.pathname === '/manufacture/files'}>Files</a>
</div>

{#if showNewFolderInput}
  <div class="card new-folder-card">
    <input
      class="form-input"
      placeholder="Folder name"
      bind:value={newFolderName}
      on:keydown={(e) => e.key === 'Enter' && handleCreateFolder()}
    />
    <button class="btn btn-primary btn-sm" on:click={handleCreateFolder}>Create</button>
    <button class="btn btn-ghost btn-sm" on:click={() => { showNewFolderInput = false; newFolderName = ''; }}>Cancel</button>
  </div>
{/if}

<div class="breadcrumbs">
  <button class="crumb" on:click={() => goToBreadcrumb(-1)}><Home size={14} /> Home</button>
  {#each breadcrumbs as segment, i}
    <span class="crumb-sep">/</span>
    <button class="crumb" on:click={() => goToBreadcrumb(i)}>{segment}</button>
  {/each}
</div>

{#if loading}
  <p>Loading...</p>
{:else if entries.length === 0}
  <p class="empty-state">This folder is empty. Upload a file or create a folder to get started.</p>
{:else}
  <div class="bulk-select-bar">
    <label class="bulk-select-all">
      <input
        type="checkbox"
        checked={selectedNames.size > 0 && selectedNames.size === entries.length}
        indeterminate={selectedNames.size > 0 && selectedNames.size < entries.length}
        on:change={toggleSelectAll}
      />
      {selectedNames.size > 0 ? `${selectedNames.size} selected` : 'Select all'}
    </label>
    {#if selectedNames.size > 0}
      <button type="button" class="btn btn-ghost btn-sm" disabled={bulkDeleting} on:click={handleBulkDelete}>
        <Trash2 size={14} /> {bulkDeleting ? 'Deleting...' : `Delete ${selectedNames.size} selected`}
      </button>
    {/if}
  </div>
  <div class="card">
    <div class="file-list">
      {#each entries as entry}
        {@const isRenaming = renamingPath === joinPath(currentPath, entry.name)}
        <div class="file-row">
          {#if !isRenaming}
            <input
              type="checkbox"
              class="bulk-select-checkbox"
              checked={selectedNames.has(entry.name)}
              on:change={() => toggleEntrySelected(entry)}
              aria-label={`Select ${entry.name}`}
            />
          {/if}
          {#if isFolder(entry)}
            {#if isRenaming}
              <div class="file-row-main file-row-rename">
                <Folder size={18} />
                <input
                  class="form-input"
                  bind:value={renameValue}
                  on:keydown={(e) => { if (e.key === 'Enter') handleRenameFolder(entry); if (e.key === 'Escape') cancelRename(); }}
                  use:autofocus
                />
              </div>
              <div class="file-row-actions">
                <button class="btn btn-ghost btn-sm" on:click={() => handleRenameFolder(entry)}><Check size={14} /></button>
                <button class="btn btn-ghost btn-sm" on:click={cancelRename}><X size={14} /></button>
              </div>
            {:else}
              <button class="file-row-main" on:click={() => openFolder(entry)}>
                <Folder size={18} />
                <span class="file-name">{entry.name}</span>
              </button>
              <div class="file-row-actions">
                <button class="btn btn-ghost btn-sm" on:click={() => startRename(entry)}><Pencil size={14} /></button>
                <button class="btn btn-ghost btn-sm" on:click={() => handleDeleteFolder(entry)}><Trash2 size={14} /></button>
              </div>
            {/if}
          {:else if isRenaming}
            <div class="file-row-main file-row-rename">
              <FileIcon size={18} />
              <input
                class="form-input"
                bind:value={renameValue}
                on:keydown={(e) => { if (e.key === 'Enter') handleRenameFile(entry); if (e.key === 'Escape') cancelRename(); }}
                use:autofocus
              />
            </div>
            <div class="file-row-actions">
              <button class="btn btn-ghost btn-sm" on:click={() => handleRenameFile(entry)}><Check size={14} /></button>
              <button class="btn btn-ghost btn-sm" on:click={cancelRename}><X size={14} /></button>
            </div>
          {:else}
            <div class="file-row-main file-row-static">
              <FileIcon size={18} />
              <span class="file-name">{entry.name}</span>
              <span class="file-size">{formatSize(entry.metadata?.size)}</span>
              <span class="file-added">Added {formatAddedAt(entry)}</span>
            </div>
            <div class="file-row-actions">
              <button class="btn btn-ghost btn-sm" on:click={() => startRename(entry)}><Pencil size={14} /></button>
              <button class="btn btn-ghost btn-sm" on:click={() => handleDownload(entry)}><Download size={14} /></button>
              <button class="btn btn-ghost btn-sm" on:click={() => handleDeleteFile(entry)}><Trash2 size={14} /></button>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .new-folder-card { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 1rem; padding: 0.75rem 1rem; }
  .new-folder-card .form-input { flex: 1; max-width: 320px; }
  .breadcrumbs { display: flex; align-items: center; gap: 0.35rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .crumb { display: inline-flex; align-items: center; gap: 0.3rem; background: none; border: none; color: var(--text-muted, #888); cursor: pointer; padding: 0.15rem 0.3rem; border-radius: 4px; font-size: 0.9rem; }
  .crumb:hover { color: var(--text); background: var(--surface-2, rgba(255,255,255,0.06)); }
  .crumb-sep { color: var(--text-muted, #888); }
  .file-list { display: flex; flex-direction: column; }
  .file-row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.6rem 0.25rem; border-bottom: 1px solid var(--border, #333); }
  .bulk-select-checkbox { width: 1rem; height: 1rem; flex-shrink: 0; cursor: pointer; }
  .bulk-select-bar { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.5rem 0.75rem; margin-bottom: 0.75rem; border: 1px solid var(--border, #333); border-radius: 10px; background: var(--surface-2, rgba(255,255,255,0.04)); flex-wrap: wrap; }
  .bulk-select-all { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; font-weight: 500; color: var(--text-muted, #888); cursor: pointer; }
  .bulk-select-all input { width: 1rem; height: 1rem; cursor: pointer; }
  .file-row:last-child { border-bottom: none; }
  .file-row-main { display: flex; align-items: center; gap: 0.6rem; background: none; border: none; color: var(--text); cursor: pointer; padding: 0.25rem; flex: 1; min-width: 0; text-align: left; font-size: 0.95rem; }
  .file-row-static { cursor: default; }
  .file-row-rename { cursor: default; }
  .file-row-rename .form-input { flex: 1; min-width: 0; }
  .file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-size { color: var(--text-muted, #888); font-size: 0.8rem; flex-shrink: 0; margin-left: auto; }
  .file-added { color: var(--text-muted, #888); font-size: 0.78rem; flex-shrink: 0; }
  .file-row-actions { display: flex; gap: 0.35rem; flex-shrink: 0; }
  .empty-state { color: var(--text-muted, #888); padding: 2rem 0; text-align: center; }
</style>
