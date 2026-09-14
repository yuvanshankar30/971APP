<script>
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { supabase } from '$lib/supabase.js';
  import { userStore, loadUserFromUUID } from '$lib/stores/user.js';
  import { canUseNesting } from '$lib/permissions.js';
  import { toastActions } from '$lib/toast.js';
  import { requestConfirmation } from '$lib/confirmation.js';
  import { Plus, Save, Undo2, Redo2, RotateCw, RotateCcw, Download, Upload, Crosshair, MousePointer2, FolderOpen, Search, RefreshCw, Ruler, FileCode, Trash2, Copy, Settings, X } from 'lucide-svelte';
  import { listSheets, createSheet, getSheet, savePlacements, createCut, setActiveCut, recordEmission } from '$lib/nesting/db.js';
  import { listPartsLibrary, uploadPartFile, downloadText, uploadEmittedGcode } from '$lib/nesting/storage.js';
  import { clampPlacementToSheet, makePlacement, placementContains, sheetContains, rotatePlacement } from '$lib/nesting/sheetModel.js';
  import { screenToSheet, sheetToScreen, zoomAt } from '$lib/nesting/coords.js';
  import { createUndoStack } from '$lib/nesting/undoStack.js';
  import { parseGcodeDocument } from '$lib/nesting/gcodeDocument.js';
  import { emitNestingGcode } from '$lib/nesting/gcodeEmit.js';

  export let forcedScreen = null;
  export let sheetId = null;
  let canvas, ctx, sheets = [], sheet = null, placements = [], selectedId = null, loading = true, saving = false;
  let screen = forcedScreen || 'select', view = { scale: 28, originX: 80, originY: 520 }, drag = null, placing = null;
  let undo = createUndoStack([]), gcodePrograms = {}, partGroups = [], newSheet = { name: '', width: 48, height: 30, thickness: '0.125' };
  let showNewSheet = false, showLibrary = false, showEmit = false, showProgram = false, activeCutId = null, user = null, loadError = '';
  let sheetSearch = '', measure = [], measuring = false, aHeld = false, dialect = 'linuxcnc', emitName = '', emitSuffix = '', selectedProgram = null;
  $: selected = placements.find((item) => item.id === selectedId) || null;
  $: activeCut = sheet?.nesting_cuts?.find((cut) => cut.id === activeCutId) || null;
  $: visibleSheets = sheets.filter(item => item.name.toLowerCase().includes(sheetSearch.trim().toLowerCase()));
  $: availableSuffixes = [...new Set([
    ...(placements.some(item => item.kind === 'hole') ? ['holes'] : []),
    ...placements.flatMap(item => gcodePrograms[item.part_library_path]?.variants?.map(variant => variant.suffix) || partGroups.find(group => group.key === item.part_library_path)?.suffixes || [])
  ])].sort();

  onMount(() => {
    const unsubscribe = userStore.subscribe(value => user = value);
    const onKey = (event) => {
      if (screen !== 'edit' || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
      if (event.key.toLowerCase() === 'a') aHeld = event.type === 'keydown';
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redoChange() : undoChange(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelected(); }
      if (event.key.toLowerCase() === 'r' && selected) { event.preventDefault(); rotateSelected(); }
      if (event.key === 'Escape') { placing = null; measure = []; }
    };
    const onKeyUp = (event) => { if (event.key.toLowerCase() === 'a') aHeld = false; };
    window.addEventListener('keydown', onKey); window.addEventListener('keyup', onKeyUp);
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;
        user = user || { id: session.user.id };
        void loadUserFromUUID(supabase);
        if (!canUseNesting(user)) return;
        await refreshSheets();
        const id = sheetId || $page.params?.sheetId;
        if (id) await openSheet(id);
      } catch (error) {
        console.error('Failed to load sheet nesting:', error);
        loadError = error?.message || 'Could not load nesting sheets.';
      } finally { loading = false; }
    })();
    return () => { unsubscribe(); window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); };
  });

  async function refreshSheets() { sheets = await listSheets(); }
  async function openSheet(id) {
    sheet = await getSheet(id); activeCutId = sheet.active_cut_id || sheet.nesting_cuts?.[0]?.id;
    placements = structuredClone(sheet.nesting_cuts?.find(c => c.id === activeCutId)?.nesting_placements || []);
    undo = createUndoStack(placements); selectedId = null; screen = 'edit'; emitName = sheet.name; fitView(); await loadLibrary();
    if (!forcedScreen) goto(`/nesting/sheets/${id}`, { replaceState: true, keepFocus: true, noScroll: true });
  }
  function fitView() {
    if (!sheet) return;
    const width = canvas?.clientWidth || 900, height = canvas?.clientHeight || 600;
    const scale = Math.max(5, Math.min(48, Math.min((width - 100) / Number(sheet.width_in), (height - 100) / Number(sheet.height_in))));
    view = { scale, originX: 52, originY: height - 52 }; requestAnimationFrame(draw);
  }
  async function createNewSheet() {
    if (!newSheet.name.trim()) return toastActions.show('Name the sheet first');
    try { const made = await createSheet({ name: newSheet.name.trim(), width_in: newSheet.width, height_in: newSheet.height, thickness_key: newSheet.thickness, created_by: user?.id || null }); showNewSheet = false; await refreshSheets(); await openSheet(made.id); } catch (error) { toastActions.show(error.message); }
  }
  function commit(next) { placements = undo.commit(next); selectedId = selectedId && placements.some(p => p.id === selectedId) ? selectedId : null; draw(); }
  function undoChange() { placements = undo.undo(); draw(); }
  function redoChange() { placements = undo.redo(); draw(); }
  async function save() { if (!activeCutId) return; saving = true; try { await savePlacements(activeCutId, placements); updateActiveCutInMemory(); toastActions.show('Sheet saved'); } catch (error) { toastActions.show(error.message); } finally { saving = false; } }
  function updateActiveCutInMemory() { const cut = sheet?.nesting_cuts?.find(item => item.id === activeCutId); if (cut) cut.nesting_placements = structuredClone(placements); }
  async function addCut() {
    const name = `Cut ${(sheet.nesting_cuts?.length || 0) + 1}`;
    try { const cut = await createCut(sheet.id, name); sheet.nesting_cuts = [...sheet.nesting_cuts, { ...cut, nesting_placements: [] }]; activeCutId = cut.id; placements = []; undo = createUndoStack([]); await setActiveCut(sheet.id, cut.id); draw(); } catch (error) { toastActions.show(error.message); }
  }
  async function chooseCut(id) { await save(); activeCutId = id; placements = structuredClone(sheet.nesting_cuts.find(c => c.id === id)?.nesting_placements || []); undo = createUndoStack(placements); selectedId = null; await setActiveCut(sheet.id, id); draw(); }
  async function loadLibrary() {
    try {
      const files = (await listPartsLibrary()).filter(item => /\.(ngc|tap)$/i.test(item.name));
      const groups = new Map();
      for (const item of files) {
        const pieces = item.path.split('/');
        const folder = pieces.length > 2 ? pieces.slice(-2, -1)[0] : item.name.replace(/\.[^.]+$/, '');
        const key = `Nesting Parts Library/${folder}`;
        if (!groups.has(key)) groups.set(key, { key, label: folder, files: [], suffixes: [] });
        groups.get(key).files.push(item);
        const stem = item.name.replace(/\.[^.]+$/, ''), suffixIndex = stem.lastIndexOf('_');
        groups.get(key).suffixes.push(suffixIndex === -1 ? '' : stem.slice(suffixIndex + 1).toLowerCase());
      }
      partGroups = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
    } catch { partGroups = []; }
  }
  async function readPartGroup(group) {
    const variants = await Promise.all(group.files.map(async file => parseGcodeDocument(await downloadText(file.path), file.name)));
    const primary = variants[0], bounds = variants.reduce((largest, item) => item.bounds.width * item.bounds.height > largest.width * largest.height ? item.bounds : largest, primary.bounds);
    return { variants, bounds };
  }
  async function armStoredPart(group) {
    try {
      const program = await readPartGroup(group); gcodePrograms[group.key] = program;
      placing = { label: group.label, part_library_path: group.key, width_in: program.bounds.width, height_in: program.bounds.height };
      showLibrary = false; toastActions.show(`Hold A and click the sheet to place ${group.label}`);
    } catch (error) { toastActions.show(error.message); }
  }
  async function uploadParts(event) {
    const files = [...(event.currentTarget.files || [])]; if (!files.length) return;
    const firstStem = files[0].name.replace(/\.[^.]+$/, '');
    const partName = firstStem.replace(/_[^_]+$/, '') || firstStem;
    try {
      await Promise.all(files.map(file => uploadPartFile(file, partName)));
      const variants = await Promise.all(files.map(async file => parseGcodeDocument(await file.text(), file.name)));
      const primary = variants[0], bounds = variants.reduce((largest, item) => item.bounds.width * item.bounds.height > largest.width * largest.height ? item.bounds : largest, primary.bounds);
      const key = `Nesting Parts Library/${partName}`; gcodePrograms[key] = { variants, bounds };
      placing = { label: partName, part_library_path: key, width_in: bounds.width, height_in: bounds.height };
      await loadLibrary(); toastActions.show(`Uploaded ${files.length} program${files.length === 1 ? '' : 's'}; hold A and click to place`);
    } catch (error) { toastActions.show(error.message); }
    event.currentTarget.value = '';
  }
  function draw() {
    if (!canvas || !sheet) return;
    const rect = canvas.getBoundingClientRect(); canvas.width = rect.width * devicePixelRatio; canvas.height = rect.height * devicePixelRatio;
    ctx = canvas.getContext('2d'); ctx.scale(devicePixelRatio, devicePixelRatio); ctx.clearRect(0, 0, rect.width, rect.height);
    const a = sheetToScreen({ x: 0, y: 0 }, view), b = sheetToScreen({ x: Number(sheet.width_in), y: Number(sheet.height_in) }, view);
    ctx.fillStyle = '#f5f5f2'; ctx.fillRect(a.x, b.y, b.x - a.x, a.y - b.y); ctx.strokeStyle = '#667085'; ctx.lineWidth = 2; ctx.strokeRect(a.x, b.y, b.x - a.x, a.y - b.y);
    for (const p of placements) {
      const s = sheetToScreen(p, view); ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(-p.rotation);
      ctx.fillStyle = p.id === selectedId ? '#fbbf24' : p.kind === 'hole' ? '#22c55e' : '#3b82f6'; ctx.globalAlpha = .86;
      if (p.kind === 'hole') { ctx.beginPath(); ctx.arc(0, 0, Math.max(4, p.width_in * view.scale / 2), 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(-p.width_in * view.scale / 2, -p.height_in * view.scale / 2, p.width_in * view.scale, p.height_in * view.scale);
      ctx.globalAlpha = 1; ctx.fillStyle = '#101828'; ctx.font = '12px sans-serif'; if (p.kind !== 'hole') ctx.fillText(p.label, -p.width_in * view.scale / 2 + 5, 4); ctx.restore();
    }
    if (measure.length) {
      const points = measure.map(point => sheetToScreen(point, view)); ctx.strokeStyle = '#fbbf24'; ctx.fillStyle = '#fbbf24'; ctx.lineWidth = 2;
      for (const point of points) { ctx.beginPath(); ctx.arc(point.x, point.y, 4, 0, Math.PI * 2); ctx.fill(); }
      if (points.length === 2) { ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y); ctx.lineTo(points[1].x, points[1].y); ctx.stroke(); }
    }
  }
  function pointerDown(event) {
    if (!sheet) return;
    const rect = canvas.getBoundingClientRect(), point = screenToSheet({ x: event.clientX - rect.left, y: event.clientY - rect.top }, view);
    if (measuring || event.shiftKey) { measure = measure.length === 1 ? [...measure, point] : [point]; if (measure.length === 2) measuring = false; draw(); return; }
    if ((event.altKey || aHeld) && placing) {
      const item = clampPlacementToSheet(sheet, makePlacement({ ...placing, x: point.x, y: point.y }));
      if (!item) return toastActions.show('This part is larger than the selected sheet');
      commit([...placements, item]); selectedId = item.id; return;
    }
    const hit = [...placements].reverse().find(p => placementContains(p, point.x, point.y)); selectedId = hit?.id || null;
    drag = hit ? { id: hit.id, start: point, placement: structuredClone(hit) } : { pan: true, start: { x: event.clientX, y: event.clientY }, view: { ...view } }; draw();
  }
  function pointerMove(event) {
    if (!drag) return;
    if (drag.pan) { view = { ...view, originX: drag.view.originX + event.clientX - drag.start.x, originY: drag.view.originY + event.clientY - drag.start.y }; draw(); return; }
    const rect = canvas.getBoundingClientRect(), point = screenToSheet({ x: event.clientX - rect.left, y: event.clientY - rect.top }, view), dx = point.x - drag.start.x, dy = point.y - drag.start.y;
    placements = placements.map(p => p.id === drag.id ? { ...p, x: drag.placement.x + dx, y: drag.placement.y + dy } : p); draw();
  }
  function pointerUp() { if (drag && !drag.pan) { const moved = placements.find(item => item.id === drag.id); if (moved && !sheetContains(sheet, moved)) placements = placements.map(item => item.id === drag.id ? drag.placement : item); else undo.commit(placements); } drag = null; draw(); }
  function wheel(event) { event.preventDefault(); const r = canvas.getBoundingClientRect(); view = zoomAt(view, { x: event.clientX - r.left, y: event.clientY - r.top }, event.deltaY < 0 ? 1.12 : .89); draw(); }
  function placeHole() { placing = { kind: 'hole', label: 'Hole', width_in: .3, height_in: .3 }; measure = []; toastActions.show('Uses the selected sheet thickness hole program'); }
  function rotateSelected(turns = 1) { if (selected) commit(placements.map(p => p.id === selected.id ? rotatePlacement(p, turns) : p)); }
  function duplicateSelected() { if (!selected) return; const copy = makePlacement({ ...selected, id: undefined, x: selected.x + .5, y: selected.y + .5, label: `${selected.label} copy` }); if (!sheetContains(sheet, copy)) return toastActions.show('Duplicated placement would leave the sheet'); commit([...placements, copy]); selectedId = copy.id; }
  async function removeSelected() { if (!selected || !await requestConfirmation({ title: 'Delete placement', message: `Remove ${selected.label}?`, confirmLabel: 'Remove', danger: true })) return; commit(placements.filter(p => p.id !== selected.id)); }
  function inspectSelected() { const program = selected && gcodePrograms[selected.part_library_path]; if (!program) return toastActions.show('Reload the part library before inspecting this part'); selectedProgram = program; showProgram = true; }
  async function ensurePrograms() {
    for (const placement of placements.filter(item => item.kind === 'part' && !gcodePrograms[item.part_library_path])) {
      const group = partGroups.find(item => item.key === placement.part_library_path);
      if (!group) throw new Error(`Part library entry is missing for ${placement.label}`);
      gcodePrograms[placement.part_library_path] = await readPartGroup(group);
    }
  }
  async function emit() {
    try {
      await ensurePrograms();
      const suffixes = availableSuffixes.length ? availableSuffixes : [''];
      const targets = emitSuffix === 'all' ? suffixes : [emitSuffix || suffixes[0]];
      let count = 0;
      for (const suffix of targets) {
        const result = emitNestingGcode({ name: emitName || sheet.name, placements, programs: gcodePrograms, suffix, suffixCount: targets.length, dialect, thickness: sheet.thickness_key });
        if (!result.emitted) continue;
        const path = await uploadEmittedGcode(result.filename, result.text);
        await recordEmission({ cut_id: activeCutId, suffix, dialect, output_storage_path: path, tool_order: [] });
        const url = URL.createObjectURL(new Blob([result.text], { type: 'text/plain' })), link = document.createElement('a'); link.href = url; link.download = result.filename; link.click(); URL.revokeObjectURL(url); count += 1;
      }
      if (!count) throw new Error('No placed item has a program for the selected suffix.');
      showEmit = false; toastActions.show(`Emitted ${count} G-code file${count === 1 ? '' : 's'}`);
    } catch (error) { toastActions.show(error.message); }
  }
</script>

<svelte:head><title>Sheet Nesting</title></svelte:head>
{#if loading}<main class="nesting"><p>Loading sheet nesting...</p></main>
{:else if loadError}<main class="nesting"><h1>Sheet Nesting</h1><p>{loadError}</p><p>Reload this page. If the error persists after deployment, apply <code>migrations/20260914000000_nesting_system.sql</code>.</p></main>
{:else if !user}<main class="nesting"><h1>Sheet Nesting</h1><p>Sign in to use the nesting workspace.</p></main>
{:else if screen === 'settings'}
  <main class="nesting"><header><div><p class="eyebrow">Sheet Nesting</p><h1>Settings</h1></div><a class="btn btn-secondary" href="/nesting">Back to sheets</a></header><section class="settings-panel"><h2>Coordinate system</h2><p>Sheets use positive inch dimensions. The lower-left of each sheet is X0 Y0; the canvas handles screen-space inversion internally.</p><h2>Part library</h2><p>Upload all <code>.ngc</code> or <code>.tap</code> variants for a part at once. Their final underscore suffixes become emission groups, matching JProg's suffix workflow.</p><h2>Output</h2><p>Each emission is saved in the Manufacturing Files tab under <code>Jprog Output/YYYYMMDD/</code>. The day folder is created automatically when the first program is emitted.</p><h2>Hole programs</h2><p>Added holes use the bundled JProg thickness program and only emit with the <code>holes</code> suffix.</p><h2>Workflow boundary</h2><p>Nesting remains standalone. Emitting a program does not queue or update AutoCAM or Fusion.</p></section></main>
{:else if screen === 'select'}
  <main class="nesting"><header><div><p class="eyebrow">Manufacturing</p><h1>Sheet Nesting</h1></div><div class="header-actions"><button class="btn btn-secondary" on:click={() => screen = 'settings'}><Settings size={16}/> Settings</button><button class="btn btn-primary" on:click={() => showNewSheet = true}><Plus size={16}/> New sheet</button></div></header><label class="search"><Search size={17}/><input bind:value={sheetSearch} placeholder="Search sheets"/></label><section class="sheet-list">{#each visibleSheets as item}<button class="sheet-row" on:click={() => openSheet(item.id)}><strong>{item.name}</strong><span>{item.width_in} x {item.height_in} in · {item.thickness_key} in · {item.nesting_cuts?.length || 0} cuts</span></button>{:else}<p>No matching sheets.</p>{/each}</section></main>
{:else}
  <main class="workspace"><header class="workspace-header"><button class="btn btn-secondary" on:click={() => { screen = 'select'; goto('/nesting'); }}><FolderOpen size={16}/> Sheets</button><div><p class="eyebrow">{sheet?.name} · {sheet?.width_in} x {sheet?.height_in} in · {sheet?.thickness_key} in</p><h1>Sheet Nesting</h1></div><div class="header-actions"><button class="btn btn-secondary" on:click={fitView}><Crosshair size={16}/> Fit sheet</button><button class:active={measuring || measure.length} class="btn btn-secondary" on:click={() => { measuring = !measuring; if (measuring) measure = []; toastActions.show(measuring ? 'Click two points to measure' : 'Measurement cancelled'); }}><Ruler size={16}/> Measure</button><button class="btn btn-secondary" disabled={!undo.canUndo} on:click={undoChange}><Undo2 size={16}/> Undo</button><button class="btn btn-secondary" disabled={!undo.canRedo} on:click={redoChange}><Redo2 size={16}/> Redo</button><button class="btn btn-secondary" on:click={save}><Save size={16}/>{saving ? 'Saving' : 'Save'}</button><button class="btn btn-primary" on:click={() => { showEmit = true; emitSuffix = availableSuffixes.length === 1 ? availableSuffixes[0] : 'all'; }}><Download size={16}/> Emit G-code</button></div></header>
  <div class="workspace-body"><aside><section><label for="active-cut">Active cut</label><select id="active-cut" value={activeCutId} on:change={(e) => chooseCut(e.currentTarget.value)}>{#each sheet?.nesting_cuts || [] as cut}<option value={cut.id}>{cut.name}</option>{/each}</select><button class="text-button" on:click={addCut}><Plus size={15}/> Add cut</button></section><section><h2>Place</h2><label class="btn btn-secondary upload"><Upload size={16}/> Upload part program(s)<input type="file" accept=".ngc,.tap" multiple on:change={uploadParts}/></label><div class="row"><button class="btn btn-secondary" on:click={() => showLibrary = !showLibrary}><FolderOpen size={16}/> Library</button><button class="btn btn-secondary" on:click={loadLibrary}><RefreshCw size={16}/> Reload</button></div>{#if showLibrary}<div class="library">{#each partGroups as group}<button title={`${group.files.length} program file(s)`} on:click={() => armStoredPart(group)}>{group.label}<span>{group.files.length}</span></button>{:else}<span class="hint">No part folders found.</span>{/each}</div>{/if}<button class:active={placing?.kind === 'hole'} class="btn btn-secondary" on:click={placeHole}><Crosshair size={16}/> Add hole</button>{#if placing}<p class="hint">Hold <kbd>A</kbd> and click to place {placing.label}. Press Esc to cancel.</p>{/if}</section>{#if selected}<section><h2>Selection</h2><strong>{selected.label}</strong><div class="coordinate-grid"><label>X<input type="number" step="0.001" value={selected.x} on:change={(e) => commit(placements.map(item => item.id === selected.id ? { ...item, x: Number(e.currentTarget.value) } : item))}/></label><label>Y<input type="number" step="0.001" value={selected.y} on:change={(e) => commit(placements.map(item => item.id === selected.id ? { ...item, y: Number(e.currentTarget.value) } : item))}/></label></div><div class="selection-actions"><button class="btn btn-secondary" on:click={() => rotateSelected(-1)}><RotateCcw size={16}/> Rotate left</button><button class="btn btn-secondary" on:click={() => rotateSelected(1)}><RotateCw size={16}/> Rotate right</button><button class="btn btn-secondary" on:click={duplicateSelected}><Copy size={16}/> Duplicate</button>{#if selected.kind === 'part'}<button class="btn btn-secondary" on:click={inspectSelected}><FileCode size={16}/> Inspect G-code</button>{/if}<button class="btn btn-secondary danger" on:click={removeSelected}><Trash2 size={16}/> Delete</button></div></section>{/if}<section><h2>Measurement</h2>{#if measure.length === 2}<strong>{Math.hypot(measure[1].x - measure[0].x, measure[1].y - measure[0].y).toFixed(3)} in</strong><button class="text-button" on:click={() => { measure = []; draw(); }}>Clear measurement</button>{:else}<p class="hint">Select the ruler, then click two points.</p>{/if}</section></aside>
  <section class="canvas-wrap"><canvas bind:this={canvas} on:pointerdown={pointerDown} on:pointermove={pointerMove} on:pointerup={pointerUp} on:pointerleave={pointerUp} on:wheel={wheel}></canvas><div class="canvas-status"><MousePointer2 size={15}/> Drag to move/pan · Wheel to zoom · Hold A to place · R to rotate · Delete to remove</div></section></div></main>
{/if}
{#if showNewSheet}<div class="scrim"><form class="modal" on:submit|preventDefault={createNewSheet}><button type="button" class="modal-close" title="Close" on:click={() => showNewSheet = false}><X size={18}/></button><h2>New Sheet</h2><label>Name<input bind:value={newSheet.name} /></label><div class="two"><label>Width (in)<input type="number" min="1" bind:value={newSheet.width}/></label><label>Height (in)<input type="number" min="1" bind:value={newSheet.height}/></label></div><label>Thickness<select bind:value={newSheet.thickness}><option value="0.063">1/16 in</option><option value="0.09">0.090 in</option><option value="0.125">1/8 in</option><option value="0.1875">3/16 in</option><option value="0.25">1/4 in</option><option value="0.3125">5/16 in</option><option value="0.375">3/8 in</option><option value="0.5">1/2 in</option><option value="0.75">3/4 in</option></select></label><div class="row"><button type="button" class="btn btn-secondary" on:click={() => showNewSheet = false}>Cancel</button><button class="btn btn-primary">Create sheet</button></div></form></div>{/if}
{#if showEmit}<div class="scrim"><form class="modal" on:submit|preventDefault={emit}><button type="button" class="modal-close" title="Close" on:click={() => showEmit = false}><X size={18}/></button><h2>Emit G-code</h2><label>Program name<input bind:value={emitName}/></label><label>Controller<select bind:value={dialect}><option value="linuxcnc">971 / LinuxCNC (.ngc)</option><option value="wincnc">WinCNC (.tap)</option></select></label><fieldset><legend>Program group</legend><label class="radio"><input type="radio" bind:group={emitSuffix} value="all"/> All available groups</label>{#each availableSuffixes as suffix}<label class="radio"><input type="radio" bind:group={emitSuffix} value={suffix}/> {suffix || 'default'}</label>{/each}{#if !availableSuffixes.length}<p class="hint">Add a part or hole before emitting.</p>{/if}</fieldset><div class="row"><button type="button" class="btn btn-secondary" on:click={() => showEmit = false}>Cancel</button><button class="btn btn-primary" disabled={!placements.length || !availableSuffixes.length}>Emit and download</button></div></form></div>{/if}
{#if showProgram}<div class="scrim"><section class="modal program"><button type="button" class="modal-close" title="Close" on:click={() => showProgram = false}><X size={18}/></button><h2>{selected?.label} programs</h2>{#each selectedProgram?.variants || [] as variant}<details><summary>{variant.name} · {variant.dialect} · {variant.suffix || 'default'}</summary><pre>{variant.source}</pre></details>{/each}</section></div>{/if}

<style>
  .nesting,.workspace{max-width:1400px;margin:0 auto;padding:28px}.nesting header,.workspace-header,.row{display:flex;align-items:center;justify-content:space-between;gap:12px}.eyebrow{margin:0;color:var(--muted-text,#667085);font-size:.8rem;text-transform:uppercase;letter-spacing:0}.nesting h1,.workspace h1{margin:2px 0;font-size:1.7rem}.settings-panel{max-width:700px;margin-top:24px;padding:20px;border:1px solid var(--border-color,#d0d5dd);border-radius:6px}.settings-panel h2{font-size:1rem;margin:16px 0 4px}.settings-panel h2:first-child{margin-top:0}.settings-panel p,.hint{color:var(--muted-text,#667085);line-height:1.45}.header-actions{display:flex;gap:8px;align-items:center}.search{display:flex;margin-top:24px;max-width:540px;align-items:center;gap:8px;border:1px solid var(--border-color,#d0d5dd);padding:8px 10px}.search input{border:0;padding:0;min-width:0;width:100%}.sheet-list{margin-top:14px;display:grid;gap:8px;max-width:720px}.sheet-row{display:flex;justify-content:space-between;gap:12px;text-align:left;padding:16px;border:1px solid var(--border-color,#d0d5dd);background:var(--card-bg,#fff);border-radius:6px}.sheet-row span{color:var(--muted-text,#667085)}.workspace{max-width:none;padding:14px;height:calc(100vh - 70px);display:flex;flex-direction:column}.workspace-header{padding:0 4px 14px;border-bottom:1px solid var(--border-color,#d0d5dd)}.workspace-body{flex:1;min-height:0;display:grid;grid-template-columns:270px 1fr;margin-top:12px;gap:12px}aside{border:1px solid var(--border-color,#d0d5dd);padding:12px;overflow:auto}aside section{display:grid;gap:9px;padding:12px 0;border-bottom:1px solid var(--border-color,#d0d5dd)}aside h2{font-size:1rem;margin:0}.library{display:grid;gap:4px;max-height:190px;overflow:auto}.library button{padding:7px;text-align:left;border:1px solid var(--border-color,#d0d5dd);background:var(--card-bg,#fff);display:flex;justify-content:space-between}.canvas-wrap{position:relative;min-height:0;background:#182230;border:1px solid #344054;overflow:hidden}canvas{width:100%;height:100%;touch-action:none}.canvas-status{position:absolute;bottom:12px;left:12px;color:#fff;background:#101828d9;padding:7px 10px;display:flex;gap:7px;font-size:.8rem}.btn,.text-button{display:inline-flex;align-items:center;justify-content:center;gap:7px}.text-button{border:0;background:none;color:var(--primary,#2563eb);justify-content:start;padding:2px}.upload input{display:none}.active{outline:2px solid var(--primary,#2563eb)}.danger{color:#b42318}.selection-actions{display:grid;gap:6px}.selection-actions .btn{justify-content:flex-start}label{display:grid;gap:5px;font-size:.85rem}input,select{padding:8px;border:1px solid var(--border-color,#d0d5dd);border-radius:4px;background:var(--card-bg,#fff);color:inherit}.coordinate-grid,.two{display:grid;grid-template-columns:1fr 1fr;gap:8px}.scrim{position:fixed;inset:0;background:#10182899;display:grid;place-items:center;z-index:10}.modal{position:relative;background:var(--card-bg,#fff);padding:22px;width:min(460px,calc(100vw - 32px));display:grid;gap:14px;border-radius:8px;max-height:calc(100vh - 32px);overflow:auto}.modal h2{margin:0}.modal-close{position:absolute;right:12px;top:12px;border:0;background:none;color:inherit}.modal fieldset{display:grid;gap:8px;border:1px solid var(--border-color,#d0d5dd)}.radio{display:flex;align-items:center;gap:8px}.radio input{padding:0}.program{width:min(900px,calc(100vw - 32px))}.program details{border:1px solid var(--border-color,#d0d5dd);padding:8px}.program pre{white-space:pre;overflow:auto;max-height:320px;font-size:.75rem}@media(max-width:720px){.workspace{height:auto;min-height:100vh;padding:10px}.workspace-body{grid-template-columns:1fr;grid-template-rows:auto 65vh}.workspace-header{align-items:flex-start}.header-actions{flex-wrap:wrap;justify-content:end}.nesting,.workspace{padding:16px}.sheet-row{display:grid;gap:4px}.canvas-status{max-width:calc(100% - 24px)}}
</style>
