<script>
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { supabase } from '$lib/supabase.js';
  import { userStore, loadUserFromUUID } from '$lib/stores/user.js';
  import { canUseNesting } from '$lib/permissions.js';
  import { toastActions } from '$lib/toast.js';
  import { requestConfirmation } from '$lib/confirmation.js';
  import { Plus, Save, Undo2, Redo2, RotateCw, Download, Upload, Crosshair, MousePointer2, FolderOpen, Scissors } from 'lucide-svelte';
  import { listSheets, createSheet, getSheet, savePlacements, createCut, setActiveCut, recordEmission } from '$lib/nesting/db.js';
  import { listPartsLibrary, uploadPartFile, downloadText, uploadEmittedGcode } from '$lib/nesting/storage.js';
  import { makePlacement, placementContains, sheetContains, rotatePlacement } from '$lib/nesting/sheetModel.js';
  import { screenToSheet, sheetToScreen, zoomAt } from '$lib/nesting/coords.js';
  import { createUndoStack } from '$lib/nesting/undoStack.js';
  import { parseGcodeDocument } from '$lib/nesting/gcodeDocument.js';
  import { emitNestingGcode } from '$lib/nesting/gcodeEmit.js';

  export let forcedScreen = null;
  export let sheetId = null;
  let canvas, ctx, sheets = [], sheet = null, placements = [], selectedId = null, loading = true, saving = false;
  let screen = forcedScreen || 'select', view = { scale: 28, originX: 80, originY: 520 }, drag = null, placing = null;
  let undo = createUndoStack([]), gcodePrograms = {}, partFiles = [], newSheet = { name: '', width: 48, height: 24, thickness: '0.125' };
  let showNewSheet = false, showLibrary = false, emitName = '', activeCutId = null, user = null, loadError = '';
  $: selected = placements.find((item) => item.id === selectedId) || null;
  $: activeCut = sheet?.nesting_cuts?.find((cut) => cut.id === activeCutId) || null;

  onMount(async () => {
    const unsubscribe = userStore.subscribe(value => user = value);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      // Nesting only requires a session. Profile hydration is useful for the
      // rest of the app but must not stall this standalone workspace.
      user = user || { id: session.user.id };
      void loadUserFromUUID(supabase);
      if (!canUseNesting(user)) return;
      await refreshSheets();
      const id = sheetId || $page.params?.sheetId;
      if (id) await openSheet(id);
    } catch (error) {
      console.error('Failed to load sheet nesting:', error);
      loadError = error?.message || 'Could not load nesting sheets.';
    } finally {
      loading = false;
    }
    return unsubscribe;
  });

  async function refreshSheets() { sheets = await listSheets(); }
  async function openSheet(id) {
    sheet = await getSheet(id); activeCutId = sheet.active_cut_id || sheet.nesting_cuts?.[0]?.id;
    placements = structuredClone(sheet.nesting_cuts?.find(c => c.id === activeCutId)?.nesting_placements || []);
    undo = createUndoStack(placements); selectedId = null; screen = 'edit'; emitName = sheet.name; fitView(); await loadLibrary();
    if (!forcedScreen) goto(`/nesting/sheets/${id}`, { replaceState: true, keepFocus: true, noScroll: true });
  }
  function fitView() { if (!sheet) return; view = { scale: Math.max(8, Math.min(32, 720 / Math.max(Number(sheet.width_in), Number(sheet.height_in)))), originX: 72, originY: 580 }; requestAnimationFrame(draw); }
  async function createNewSheet() {
    if (!newSheet.name.trim()) return toastActions.show('Name the sheet first');
    try { const made = await createSheet({ name: newSheet.name.trim(), width_in: newSheet.width, height_in: newSheet.height, thickness_key: newSheet.thickness, created_by: user?.id || null }); showNewSheet = false; await refreshSheets(); await openSheet(made.id); } catch (error) { toastActions.show(error.message); }
  }
  function commit(next) { placements = undo.commit(next); selectedId = selectedId && placements.some(p => p.id === selectedId) ? selectedId : null; draw(); }
  function undoChange() { placements = undo.undo(); draw(); } function redoChange() { placements = undo.redo(); draw(); }
  async function save() { if (!activeCutId) return; saving = true; try { await savePlacements(activeCutId, placements); toastActions.show('Sheet saved'); } catch (error) { toastActions.show(error.message); } finally { saving = false; } }
  async function addCut() { const cut = await createCut(sheet.id, `Cut ${(sheet.nesting_cuts?.length || 0) + 1}`); sheet.nesting_cuts = [...sheet.nesting_cuts, { ...cut, nesting_placements: [] }]; activeCutId = cut.id; placements = []; undo = createUndoStack([]); await setActiveCut(sheet.id, cut.id); draw(); }
  async function chooseCut(id) { await save(); activeCutId = id; placements = structuredClone(sheet.nesting_cuts.find(c => c.id === id)?.nesting_placements || []); undo = createUndoStack(placements); selectedId = null; await setActiveCut(sheet.id, id); draw(); }
  async function loadLibrary() { try { partFiles = (await listPartsLibrary()).filter(item => /\.(ngc|tap)$/i.test(item.name)); } catch { partFiles = []; } }
  async function uploadPart(event) { const file = event.currentTarget.files?.[0]; if (!file) return; try { const path = await uploadPartFile(file, file.name.replace(/\.[^.]+$/, '')); gcodePrograms[path] = parseGcodeDocument(await file.text(), file.name); await loadLibrary(); placing = { label: file.name.replace(/\.[^.]+$/, ''), part_library_path: path, width_in: 2, height_in: 2 }; toastActions.show('Hold A and click the sheet to place this part'); } catch (error) { toastActions.show(error.message); } }
  async function armStoredPart(item) { const path = item.path; try { gcodePrograms[path] = parseGcodeDocument(await downloadText(path), item.name); placing = { label: item.name.replace(/\.[^.]+$/, ''), part_library_path: path, width_in: 2, height_in: 2 }; showLibrary = false; toastActions.show('Hold A and click the sheet to place this part'); } catch (error) { toastActions.show(error.message); } }
  function draw() {
    if (!canvas || !sheet) return; const rect = canvas.getBoundingClientRect(); canvas.width = rect.width * devicePixelRatio; canvas.height = rect.height * devicePixelRatio; ctx = canvas.getContext('2d'); ctx.scale(devicePixelRatio, devicePixelRatio); ctx.clearRect(0, 0, rect.width, rect.height);
    const a = sheetToScreen({ x: 0, y: 0 }, view), b = sheetToScreen({ x: Number(sheet.width_in), y: Number(sheet.height_in) }, view);
    ctx.fillStyle = '#f5f5f2'; ctx.fillRect(a.x, b.y, b.x - a.x, a.y - b.y); ctx.strokeStyle = '#596579'; ctx.lineWidth = 2; ctx.strokeRect(a.x, b.y, b.x - a.x, a.y - b.y);
    for (const p of placements) { const s = sheetToScreen(p, view); ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(-p.rotation); ctx.fillStyle = p.id === selectedId ? '#fbbf24' : p.kind === 'hole' ? '#22c55e' : '#3b82f6'; ctx.globalAlpha = .86; ctx.fillRect(-p.width_in * view.scale / 2, -p.height_in * view.scale / 2, p.width_in * view.scale, p.height_in * view.scale); ctx.globalAlpha = 1; ctx.fillStyle = '#101828'; ctx.font = '12px sans-serif'; ctx.fillText(p.label, -p.width_in * view.scale / 2 + 5, 4); ctx.restore(); }
  }
  function pointerDown(event) { if (!sheet) return; const rect = canvas.getBoundingClientRect(), point = screenToSheet({ x: event.clientX - rect.left, y: event.clientY - rect.top }, view); if (event.altKey && placing) { const item = makePlacement({ ...placing, x: point.x, y: point.y }); if (!sheetContains(sheet, item)) return toastActions.show('Placement must stay on the sheet'); commit([...placements, item]); selectedId = item.id; return; } const hit = [...placements].reverse().find(p => placementContains(p, point.x, point.y)); selectedId = hit?.id || null; drag = hit ? { id: hit.id, start: point, placement: structuredClone(hit) } : { pan: true, start: { x: event.clientX, y: event.clientY }, view: { ...view } }; draw(); }
  function pointerMove(event) { if (!drag) return; if (drag.pan) { view = { ...view, originX: drag.view.originX + event.clientX - drag.start.x, originY: drag.view.originY + event.clientY - drag.start.y }; draw(); return; } const rect = canvas.getBoundingClientRect(), point = screenToSheet({ x: event.clientX - rect.left, y: event.clientY - rect.top }, view); const dx = point.x - drag.start.x, dy = point.y - drag.start.y; placements = placements.map(p => p.id === drag.id ? { ...p, x: drag.placement.x + dx, y: drag.placement.y + dy } : p); draw(); }
  function pointerUp() { if (drag && !drag.pan) undo.commit(placements); drag = null; }
  function wheel(event) { event.preventDefault(); const r = canvas.getBoundingClientRect(); view = zoomAt(view, { x: event.clientX - r.left, y: event.clientY - r.top }, event.deltaY < 0 ? 1.12 : .89); draw(); }
  async function emit() { if (!placements.length) return toastActions.show('Place a part before emitting'); try { for (const item of placements.filter(p => p.part_library_path && !gcodePrograms[p.part_library_path])) gcodePrograms[item.part_library_path] = parseGcodeDocument(await downloadText(item.part_library_path), item.label); const result = emitNestingGcode({ name: emitName || sheet.name, placements, programs: gcodePrograms }); const path = await uploadEmittedGcode(result.filename, result.text); await recordEmission({ cut_id: activeCutId, suffix: '', dialect: 'linuxcnc', output_storage_path: path, tool_order: [] }); const url = URL.createObjectURL(new Blob([result.text], { type: 'text/plain' })); const a = document.createElement('a'); a.href = url; a.download = result.filename; a.click(); URL.revokeObjectURL(url); toastActions.show(`Wrote ${path}`); } catch (error) { toastActions.show(error.message); } }
  async function removeSelected() { if (!selected || !await requestConfirmation({ title: 'Delete placement', message: `Remove ${selected.label}?`, confirmLabel: 'Remove', danger: true })) return; commit(placements.filter(p => p.id !== selected.id)); }
</script>

<svelte:head><title>Sheet Nesting</title></svelte:head>
{#if loading}<main class="nesting"><p>Loading sheet nesting...</p></main>
{:else if loadError}<main class="nesting"><h1>Sheet Nesting</h1><p>{loadError}</p><p>Reload this page. If the error persists after deployment, apply <code>migrations/20260914000000_nesting_system.sql</code>.</p></main>
{:else if !user}<main class="nesting"><h1>Sheet Nesting</h1><p>Sign in to use the nesting workspace.</p></main>
{:else if screen === 'settings'}
  <main class="nesting"><header><div><p class="eyebrow">Sheet Nesting</p><h1>Settings</h1></div><a class="btn btn-secondary" href="/nesting">Back to sheets</a></header><section class="settings-panel"><h2>Coordinate system</h2><p>Sheets use positive inch dimensions. The lower-left of each sheet is X0 Y0; the canvas handles its screen-space inversion internally.</p><h2>Part library</h2><p>Part G-code is stored in the shared Manufacturing Drive under <code>Nesting Parts Library/</code>. Emitted files are saved under <code>Nesting Output/</code>.</p><h2>Workflow boundary</h2><p>Nesting is standalone. Emitting a program does not queue or update AutoCAM or Fusion.</p></section></main>
{:else if screen === 'select'}
  <main class="nesting"><header><div><p class="eyebrow">Manufacturing</p><h1>Sheet Nesting</h1></div><button class="btn btn-primary" on:click={() => showNewSheet = true}><Plus size={16}/> New sheet</button></header>
  <section class="sheet-list">{#each sheets as item}<button class="sheet-row" on:click={() => openSheet(item.id)}><strong>{item.name}</strong><span>{item.width_in} x {item.height_in} in · {item.nesting_cuts?.length || 0} cuts</span></button>{:else}<p>No sheets yet. Create one to start placing cuts.</p>{/each}</section></main>
{:else}
  <main class="workspace"><header class="workspace-header"><button class="icon-button" title="Back to sheets" on:click={() => { screen = 'select'; goto('/nesting'); }}><FolderOpen size={18}/></button><div><p class="eyebrow">{sheet?.name}</p><h1>Sheet Nesting</h1></div><div class="header-actions"><button class="icon-button" title="Undo" disabled={!undo.canUndo} on:click={undoChange}><Undo2 size={18}/></button><button class="icon-button" title="Redo" disabled={!undo.canRedo} on:click={redoChange}><Redo2 size={18}/></button><button class="btn btn-secondary" on:click={save}><Save size={16}/>{saving ? 'Saving' : 'Save'}</button><button class="btn btn-primary" on:click={emit}><Download size={16}/> Emit G-code</button></div></header>
  <div class="workspace-body"><aside><section><label>Active cut</label><select value={activeCutId} on:change={(e) => chooseCut(e.currentTarget.value)}>{#each sheet?.nesting_cuts || [] as cut}<option value={cut.id}>{cut.name}</option>{/each}</select><button class="text-button" on:click={addCut}><Plus size={15}/> Add cut</button></section><section><h2>Place</h2><label class="btn btn-secondary upload"><Upload size={16}/> Upload part<input type="file" accept=".ngc,.tap" on:change={uploadPart}/></label><button class="btn btn-secondary" on:click={() => showLibrary = !showLibrary}><FolderOpen size={16}/> Library</button>{#if showLibrary}<div class="library">{#each partFiles as item}<button title={item.path} on:click={() => armStoredPart(item)}>{item.name}</button>{:else}<span class="hint">No uploaded G-code files.</span>{/each}</div>{/if}<button class:active={placing?.kind === 'hole'} class="btn btn-secondary" on:click={() => placing = { kind: 'hole', label: 'Hole', width_in: .25, height_in: .25 }}><Crosshair size={16}/> Add hole</button>{#if placing}<p class="hint">Hold <kbd>A</kbd> and click to place {placing.label}.</p>{/if}</section>{#if selected}<section><h2>Selection</h2><strong>{selected.label}</strong><div class="row"><button class="icon-button" title="Rotate 90 degrees" on:click={() => commit(placements.map(p => p.id === selected.id ? rotatePlacement(p) : p))}><RotateCw size={17}/></button><button class="btn btn-danger" on:click={removeSelected}>Delete</button></div></section>{/if}</aside>
  <section class="canvas-wrap"><canvas bind:this={canvas} on:pointerdown={pointerDown} on:pointermove={pointerMove} on:pointerup={pointerUp} on:pointerleave={pointerUp} on:wheel={wheel}></canvas><div class="canvas-status"><MousePointer2 size={15}/> Drag to move/pan · Wheel to zoom · Hold A to place</div></section></div></main>
{/if}
{#if showNewSheet}<div class="scrim"><form class="modal" on:submit|preventDefault={createNewSheet}><h2>New Sheet</h2><label>Name<input bind:value={newSheet.name} autofocus /></label><div class="two"><label>Width (in)<input type="number" min="1" bind:value={newSheet.width}/></label><label>Height (in)<input type="number" min="1" bind:value={newSheet.height}/></label></div><label>Thickness<select bind:value={newSheet.thickness}><option value="0.063">1/16 in</option><option value="0.125">1/8 in</option><option value="0.25">1/4 in</option></select></label><div class="row"><button type="button" class="btn btn-secondary" on:click={() => showNewSheet = false}>Cancel</button><button class="btn btn-primary">Create sheet</button></div></form></div>{/if}

<style>
  .nesting,.workspace{max-width:1400px;margin:0 auto;padding:28px}.nesting header,.workspace-header,.row{display:flex;align-items:center;justify-content:space-between;gap:12px}.eyebrow{margin:0;color:var(--muted-text,#667085);font-size:.8rem;text-transform:uppercase;letter-spacing:0}.nesting h1,.workspace h1{margin:2px 0;font-size:1.7rem}.settings-panel{max-width:700px;margin-top:24px;padding:20px;border:1px solid var(--border-color,#d0d5dd);border-radius:6px}.settings-panel h2{font-size:1rem;margin:16px 0 4px}.settings-panel h2:first-child{margin-top:0}.settings-panel p{color:var(--muted-text,#667085);line-height:1.5}.sheet-list{margin-top:24px;display:grid;gap:8px;max-width:720px}.sheet-row{display:flex;justify-content:space-between;text-align:left;padding:16px;border:1px solid var(--border-color,#d0d5dd);background:var(--card-bg,#fff);border-radius:6px}.sheet-row span,.hint{color:var(--muted-text,#667085)}.workspace{max-width:none;padding:14px;height:calc(100vh - 70px);display:flex;flex-direction:column}.workspace-header{padding:0 4px 14px;border-bottom:1px solid var(--border-color,#d0d5dd)}.header-actions{display:flex;gap:8px;align-items:center}.workspace-body{flex:1;min-height:0;display:grid;grid-template-columns:250px 1fr;margin-top:12px;gap:12px}aside{border:1px solid var(--border-color,#d0d5dd);padding:12px;overflow:auto}aside section{display:grid;gap:9px;padding:12px 0;border-bottom:1px solid var(--border-color,#d0d5dd)}aside h2{font-size:1rem;margin:0}.library{display:grid;gap:4px;max-height:150px;overflow:auto}.library button{padding:6px;text-align:left;border:1px solid var(--border-color,#d0d5dd);background:var(--card-bg,#fff);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.canvas-wrap{position:relative;min-height:0;background:#182230;border:1px solid #344054;overflow:hidden}canvas{width:100%;height:100%;touch-action:none}.canvas-status{position:absolute;bottom:12px;left:12px;color:#fff;background:#101828d9;padding:7px 10px;display:flex;gap:7px;font-size:.8rem}.btn,.icon-button,.text-button{display:inline-flex;align-items:center;justify-content:center;gap:7px}.icon-button{width:34px;height:34px;border:1px solid var(--border-color,#d0d5dd);background:var(--card-bg,#fff)}.text-button{border:0;background:none;color:var(--primary,#2563eb);justify-content:start;padding:2px}.upload input{display:none}.active{outline:2px solid var(--primary,#2563eb)}label{display:grid;gap:5px;font-size:.85rem}input,select{padding:8px;border:1px solid var(--border-color,#d0d5dd);border-radius:4px;background:var(--card-bg,#fff);color:inherit}.scrim{position:fixed;inset:0;background:#10182899;display:grid;place-items:center;z-index:10}.modal{background:var(--card-bg,#fff);padding:22px;width:min(420px,calc(100vw - 32px));display:grid;gap:14px;border-radius:8px}.modal h2{margin:0}.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}.btn-danger{background:#b42318;color:#fff;border-color:#b42318}@media(max-width:720px){.workspace{height:auto;min-height:100vh;padding:10px}.workspace-body{grid-template-columns:1fr;grid-template-rows:auto 65vh}.workspace-header{align-items:flex-start}.header-actions{flex-wrap:wrap;justify-content:end}.nesting,.workspace{padding:16px}.sheet-row{display:grid;gap:4px}}
</style>
