<script>
  import { createEventDispatcher } from 'svelte';
  import { Home, Hammer, Package, Move3d, Wrench, Receipt, Coins, User, Briefcase, ChevronDown, Camera, Cpu, Target, FileText } from 'lucide-svelte';

  export let header_tabs = [];
  const dispatch = createEventDispatcher();

  // Icon map matching the main layout
  const iconMap = {
    manufacture: Hammer,
    kitting: Package,
    cad: Move3d,
    build: Wrench,
    purchasing: Receipt,
    notescout: Coins,
    teamview: Coins,
    pitscout: Camera,
    'scouting-admin': Briefcase,
    scoutingadmin: Briefcase,
    autocam: Cpu,
    strategy: Target,
    'gcode-converter': FileText,
    home: Home,
    profile: User,
    admin: Briefcase
  };

  function inferKey(item) {
    if (!item) return null;
    if (typeof item === 'string') return item;
    if (item.key) return String(item.key);
    if (!item.label) return null;
    const lab = String(item.label).toLowerCase();
    for (const k of Object.keys(iconMap)) {
      if (lab.includes(k)) return k;
    }
    return lab.replace(/[^a-z0-9]/g, '');
  }

  function displayLabel(item) {
    if (!item) return '';
    let lab = '';
    if (typeof item === 'string') lab = String(item);
    else if (item.label) lab = String(item.label);
    else if (item.key) lab = String(item.key);
    lab = lab.trim();
    if (!lab) return '';
    if (lab.toLowerCase() === 'cad') return 'CAD';
    return lab.replace(/^(.)/, (m) => m.toUpperCase());
  }

  // Drag payloads use this shape; we stringify into dataTransfer
  // { fromType: 'top'|'child', idx, folderIdx, childIdx }

  let draggedOver = null;

  function dragStart(event, payload) {
    event.dataTransfer.setData('application/json', JSON.stringify(payload));
    event.dataTransfer.effectAllowed = 'move';
  }

  function allowDrop(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }

  function dropOnIndex(event, idx) {
    event.preventDefault();
    draggedOver = null;
    try {
      const payload = JSON.parse(event.dataTransfer.getData('application/json'));
      dispatch('drop', { payload, target: { type: 'index', idx } });
    } catch (e) { /* ignore */ }
  }

  function dropOnFolder(event, folderIdx) {
    event.preventDefault();
    draggedOver = null;
    try {
      const payload = JSON.parse(event.dataTransfer.getData('application/json'));
      dispatch('drop', { payload, target: { type: 'folder', folderIdx } });
    } catch (e) { /* ignore */ }
  }

  function dropOnEnd(event) {
    event.preventDefault();
    draggedOver = null;
    try {
      const payload = JSON.parse(event.dataTransfer.getData('application/json'));
      dispatch('drop', { payload, target: { type: 'end' } });
    } catch (e) { /* ignore */ }
  }

  function handleDragOver(id) {
    draggedOver = id;
  }

  function handleDragLeave() {
    draggedOver = null;
  }

</script>

<nav class="header-preview" on:dragover={allowDrop} on:drop={dropOnEnd} on:dragleave={handleDragLeave} aria-label="Header preview">
  <div class="preview-brand">
    <Briefcase size={20} />
    <span>Spartans Hub</span>
  </div>

  <div class="preview-home">
    <Home size={16} />
    <span>Home</span>
  </div>

  {#if header_tabs && header_tabs.length > 0}
    <div class="hp-list">
      {#each header_tabs as item, idx}
        <div 
          class="hp-item" 
          class:drag-over={draggedOver === `item-${idx}`}
          role="listitem"
          on:dragover|preventDefault={(e)=>{allowDrop(e); handleDragOver(`item-${idx}`);}} 
          on:dragleave={handleDragLeave}
          on:drop={(e)=>dropOnIndex(e, idx)}
        >
          <div 
            class="hp-main" 
            role="button" 
            tabindex="0" 
            draggable="true" 
            on:dragstart={(e) => dragStart(e, { fromType: 'top', idx })}
            class:folder-main={item.type === 'folder'}
          >
            {#if item.type === 'folder'}
              <div class="hp-folder">
                <span class="hp-label hp-folder-label">{displayLabel(item)}</span>
                <ChevronDown size={12} class="hp-caret" />
                <div class="hp-dropdown">
                  {#if Array.isArray(item.children) && item.children.length > 0}
                    <div class="hp-dropdown-list">
                      {#each item.children as child, cidx}
                        <div 
                          class="hp-child" 
                          role="button"
                          tabindex="0"
                          draggable="true" 
                          on:dragstart={(e) => dragStart(e, { fromType: 'child', folderIdx: idx, childIdx: cidx })}
                        >
                          <svelte:component this={iconMap[child.key ?? inferKey(child)] ?? Home} size={14} />
                          <span>{displayLabel(child)}</span>
                        </div>
                      {/each}
                    </div>
                  {:else}
                    <div class="muted">(empty folder)</div>
                  {/if}
                </div>
              </div>
            {:else}
              <div class="hp-tab">
                <svelte:component this={iconMap[item.key ?? inferKey(item)] ?? Home} size={16} />
                <span class="hp-label">{displayLabel(item)}</span>
              </div>
            {/if}
          </div>
          <!-- allow dropping into folder children area -->
          {#if item.type === 'folder'}
            <div 
              class="hp-folder-drop" 
              class:drag-over={draggedOver === `folder-${idx}`}
              role="region" 
              aria-label={"Drop zone for " + displayLabel(item)}
              on:dragover|preventDefault={(e)=>{allowDrop(e); handleDragOver(`folder-${idx}`);}} 
              on:dragleave={handleDragLeave}
              on:drop={(e)=>dropOnFolder(e, idx)}
            >
              <span class="drop-hint">Drop here to add to folder</span>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {:else}
    <div class="muted no-custom">No custom tabs — using defaults</div>
  {/if}
</nav>

<style>
  .header-preview { 
    display: flex; 
    align-items: stretch; 
    gap: var(--gap-2); 
    padding: var(--space-3) var(--space-4); 
    background: var(--primary); 
    border: 1px solid var(--border); 
    border-radius: var(--radius-lg); 
    min-height: 56px;
    overflow-x: auto;
  }

  .preview-brand {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    color: var(--secondary);
    font-weight: 700;
    padding: var(--space-2) var(--space-3);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .preview-home {
    display: flex;
    align-items: center;
    gap: var(--gap-1);
    padding: var(--space-2) var(--space-3);
    color: var(--secondary);
    background: transparent;
    border-radius: var(--radius-sm);
    white-space: nowrap;
    flex-shrink: 0;
    font-size: var(--font-xs);
  }

  .hp-list { 
    display: flex; 
    gap: var(--gap-1); 
    align-items: stretch;
    flex: 1;
  }

  .hp-item { 
    position: relative; 
    display: flex;
    flex-direction: column;
  }

  .hp-item.drag-over .hp-main {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(255, 215, 0, 0.3);
  }

  .hp-main { 
    padding: var(--space-2) var(--space-3); 
    background: var(--card); 
    border: 2px solid transparent; 
    border-radius: var(--radius-lg); 
    cursor: grab; 
    transition: all .15s ease;
    display: flex;
    align-items: center;
    user-select: none;
  }

  .hp-main:active {
    cursor: grabbing;
  }

  .hp-main:focus { 
    outline: none; 
    border-color: var(--accent);
  }

  .hp-tab, .hp-folder {
    display: flex;
    align-items: center;
    gap: var(--gap-1);
    white-space: nowrap;
  }

  .hp-label { 
    color: var(--secondary);
    font-weight: 500; 
    font-size: var(--font-xs);
  }

  :global(.hp-caret) { 
    opacity: 0.6; 
    margin-left: var(--space-1);
    font-size: var(--font-xs);
  }

  .hp-folder-label { color: var(--secondary); font-weight: 500; font-size: var(--font-xs); }

  .hp-dropdown { 
    display: none; 
    position: absolute; 
    top: calc(100% + 6px); 
    left: 0; 
    background: var(--card); 
    border: 1px solid var(--border); 
    padding: var(--space-1); 
    border-radius: var(--radius-lg); 
    z-index: 40; 
    min-width: 180px;
    box-shadow: 0 8px 20px rgba(0,0,0,0.06);
  }

  .hp-folder:hover .hp-dropdown { 
    display: block; 
  }

  .hp-dropdown-list {
    display: flex;
    flex-direction: column;
    gap: var(--gap-1);
  }

  .hp-child {
    display: flex;
    align-items: center;
    gap: var(--gap-1);
    padding: var(--space-2) var(--space-3);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: grab;
    font-size: var(--font-xs);
    color: var(--text);
    font-weight: 500;
  }

  .hp-child:active {
    cursor: grabbing;
  }

  .hp-folder-drop { 
    margin-top: var(--space-2); 
    text-align: center; 
    font-size: var(--font-xs); 
    padding: var(--space-1) var(--space-2); 
    border: 2px dashed var(--border); 
    border-radius: var(--radius-lg);
    background: var(--background);
    transition: all .15s ease;
    opacity: 0.6;
  }

  .hp-folder-drop:hover,
  .hp-folder-drop.drag-over { 
    border-color: var(--accent);
    background: rgba(255, 215, 0, 0.1);
    opacity: 1;
  }

  .drop-hint {
    color: var(--muted);
    font-size: var(--font-xs);
  }

  .header-preview .muted { 
    color: var(--muted); 
    font-size: var(--font-xs);
    padding: var(--space-2);
  }

  .no-custom {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }
</style>
