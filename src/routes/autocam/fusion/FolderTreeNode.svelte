<script>
  import { ChevronRight, ChevronDown, Folder } from 'lucide-svelte';

  export let node; // { name, path, children: [] }
  export let selectedPath = '';
  export let onSelect = () => {};
  export let depth = 0;

  let expanded = depth < 2; // AutoCAM and its immediate children start open; deeper folders start collapsed
  $: hasChildren = node.children?.length > 0;
  $: isSelected = node.path === selectedPath;
</script>

<div class="folder-node">
  <button
    type="button"
    class="folder-row"
    class:selected={isSelected}
    style="padding-left: {depth * 1.1}rem"
    on:click={() => onSelect(node.path)}
  >
    {#if hasChildren}
      <span class="folder-toggle" role="button" tabindex="-1" on:click|stopPropagation={() => (expanded = !expanded)}>
        {#if expanded}<ChevronDown size={13} />{:else}<ChevronRight size={13} />{/if}
      </span>
    {:else}
      <span class="folder-toggle folder-toggle-spacer"></span>
    {/if}
    <Folder size={14} />
    <span class="folder-name">{node.name || '(root)'}</span>
  </button>
  {#if hasChildren && expanded}
    {#each node.children as child (child.path)}
      <svelte:self node={child} {selectedPath} {onSelect} depth={depth + 1} />
    {/each}
  {/if}
</div>

<style>
  .folder-node { display: flex; flex-direction: column; }
  .folder-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    padding: 0.3rem 0.5rem;
    border-radius: var(--radius-sm, 6px);
    cursor: pointer;
    color: var(--text);
    font-size: 0.85rem;
  }
  .folder-row:hover { background: var(--surface-2); }
  .folder-row.selected { background: var(--accent-soft, rgba(47, 129, 247, 0.14)); color: var(--accent); font-weight: 600; }
  .folder-toggle { display: inline-flex; align-items: center; justify-content: center; width: 14px; flex-shrink: 0; }
  .folder-toggle-spacer { width: 14px; }
  .folder-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
