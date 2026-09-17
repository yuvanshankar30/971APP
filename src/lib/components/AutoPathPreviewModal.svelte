<script>
  import { createEventDispatcher } from 'svelte';
  import { X } from 'lucide-svelte';
  import RebuiltFieldMap from './RebuiltFieldMap.svelte';

  // path: { name, alliance, path: [[x,y],...] } - a saved_auto_paths row.
  export let path = null;

  const dispatch = createEventDispatcher();
  function close() { dispatch('close'); }
  function handleKeydown(e) { if (e.key === 'Escape') close(); }
</script>

{#if path}
  <div
    class="modal-backdrop"
    role="button"
    tabindex="0"
    on:click|self={close}
    on:keydown={(e) => { if (e.key === 'Escape') close(); handleKeydown(e); }}
  >
    <div class="modal auto-path-modal" role="dialog" aria-modal="true" aria-label={`Autonomous path: ${path.name || 'Untitled'}`} on:click|stopPropagation>
      <div class="modal-header">
        <h3>{path.name || 'Autonomous path'}</h3>
        <button type="button" class="modal-close-button" aria-label="Close" on:click={close}><X size={18} /></button>
      </div>
      <div class="modal-body">
        <p class="path-meta">{path.alliance || 'Alliance not recorded'} alliance · {path.path?.length || 0} path points</p>
        <RebuiltFieldMap alliance={path.alliance === 'red' ? 'red' : 'blue'} path={path.path || []} readonly />
      </div>
    </div>
  </div>
{/if}

<style>
  .auto-path-modal { --modal-width: 760px; }
  .path-meta { margin: 0 0 var(--space-2); color: var(--text-muted); font-size: 0.85rem; }
</style>
