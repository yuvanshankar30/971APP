<script>
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { supabase } from '$lib/supabase.js';
  import { publishJprogOutput } from '$lib/jprog_output.js';
  import { userStore, loadUserFromUUID } from '$lib/stores/user.js';
  import { canUseNesting } from '$lib/permissions.js';
  import { toastActions } from '$lib/toast.js';
  import { requestConfirmation } from '$lib/confirmation.js';
  import { Plus, Save, Undo2, Redo2, RotateCw, RotateCcw, Download, Upload, Crosshair, MousePointer2, FolderOpen, Search, RefreshCw, Ruler, FileCode, Trash2, Copy, Settings, X, Pencil, ExternalLink } from 'lucide-svelte';
  import { listSheets, createSheet, getSheet, deleteSheet, savePlacements, createCut, renameCut, deleteCut, setActiveCut, setSheetProgramType, recordEmission } from '$lib/nesting/db.js';
  import { listPartsLibrary, listPartLibraryAtPath, sheetPartLibraryRoot, uploadPartFile, downloadText, uploadEmittedGcode } from '$lib/nesting/storage.js';
  import { clampPlacementToSheet, makePlacement, placementContains, sheetContains, rotatePlacement } from '$lib/nesting/sheetModel.js';
  import { screenToSheet, sheetToScreen, zoomAt } from '$lib/nesting/coords.js';
  import { createUndoStack } from '$lib/nesting/undoStack.js';
  import { parseGcodeDocument } from '$lib/nesting/gcodeDocument.js';
  import { emitNestingGcode } from '$lib/nesting/gcodeEmit.js';
  import { assertProgramTypeCompatible, dialectForProgramType, programTypeForName, singleProgramType } from '$lib/nesting/programType.js';

  export let forcedScreen = null;
  export let sheetId = null;
  let canvas, ctx, canvasResizeObserver, sheets = [], sheet = null, placements = [], selectedId = null, loading = true, saving = false;
  let screen = forcedScreen || 'select', view = { scale: 28, originX: 80, originY: 520 }, drag = null, rotationDrag = null, placing = null, activePart = null, placingWithShortcut = false;
  let undo = createUndoStack([]), gcodePrograms = {}, partGroups = [], newSheet = { name: '', width: 48, height: 30, thickness: '0.125' };
  let showNewSheet = false, showLibrary = false, showEmit = false, showProgram = false, activeCutId = null, user = null, loadError = '';
  let sheetSearch = '', librarySearch = '', measure = [], measuring = false, emitName = '', emitSuffix = '', selectedProgram = null, editingCutName = false, cutName = '';
  const CUT_COLORS = ['#2563eb', '#d97706', '#16a34a', '#9333ea', '#dc2626', '#0891b2', '#ca8a04', '#db2777'];
  const JPROG_OUTPUT_REPOSITORY = 'https://github.com/yuvanshankar30/output';
  $: selected = placements.find((item) => item.id === selectedId) || null;
  $: activeCut = sheet?.nesting_cuts?.find((cut) => cut.id === activeCutId) || null;
  $: renderedPlacements = (sheet?.nesting_cuts || []).flatMap((cut, cutIndex) => (cut.id === activeCutId ? placements : cut.nesting_placements || []).map((placement) => ({ ...placement, renderCutId: cut.id, renderCutIndex: cutIndex, renderActive: cut.id === activeCutId })));
  $: visibleSheets = sheets.filter(item => item.name.toLowerCase().includes(sheetSearch.trim().toLowerCase()));
  $: visiblePartGroups = partGroups.filter(group => group.label.toLowerCase().includes(librarySearch.trim().toLowerCase()));
  $: availableSuffixes = [...new Set([
    ...(placements.some(item => item.kind === 'hole') ? ['holes'] : []),
    ...placements.flatMap(item => gcodePrograms[item.part_library_path]?.variants?.map(variant => variant.suffix) || partGroups.find(group => group.key === item.part_library_path)?.suffixes || [])
  ])].map(suffix => suffix || defaultGroupLabel).sort();
  $: programType = sheet?.program_extension || 'ngc';
  $: dialect = dialectForProgramType(programType);
  $: defaultGroupLabel = activeCut?.name || 'default';

  onMount(() => {
    const unsubscribe = userStore.subscribe(value => user = value);
    const onKey = (event) => {
      if (screen !== 'edit' || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redoChange() : undoChange(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelected(); }
      if (event.key.toLowerCase() === 'r' && selected?.kind === 'part') { event.preventDefault(); rotateSelected(); }
      if (event.key.toLowerCase() === 'a' && activePart) { event.preventDefault(); placing = { ...activePart }; placingWithShortcut = true; }
      if (event.key === 'Escape') { placing = null; measure = []; }
    };
    const onKeyUp = (event) => {
      if (event.key.toLowerCase() === 'a' && placingWithShortcut) { placing = null; placingWithShortcut = false; }
    };
    const clearSelectionOutsideEditor = (event) => {
      if (screen !== 'edit' || !selectedId || !(event.target instanceof Element)) return;
      if (!event.target.closest('canvas, aside, .workspace-header, .modal')) selectedId = null;
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('pointerdown', clearSelectionOutsideEditor, true);
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
        console.error('Failed to load JProg:', error);
        loadError = error?.message || 'Could not load JProg sheets.';
      } finally { loading = false; }
    })();
    return () => { unsubscribe(); canvasResizeObserver?.disconnect(); window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('pointerdown', clearSelectionOutsideEditor, true); };
  });

  async function refreshSheets() { sheets = await listSheets(); }
  async function openSheet(id) {
    if (screen === 'select' && !sheet) { await goto(`/jprog/sheets/${id}`, { noScroll: true }); return; }
    sheet = await getSheet(id); activeCutId = sheet.active_cut_id || sheet.nesting_cuts?.[0]?.id;
    placements = structuredClone(sheet.nesting_cuts?.find(c => c.id === activeCutId)?.nesting_placements || []);
    undo = createUndoStack(placements); selectedId = null; screen = 'edit'; emitName = sheet.name; await tick(); observeCanvas(); fitView(); await loadLibrary(); await loadPlacedPrograms(); await tick(); fitView(); draw(); requestAnimationFrame(() => { fitView(); draw(); });
    if (!forcedScreen && $page.url.pathname !== `/jprog/sheets/${id}`) goto(`/jprog/sheets/${id}`, { replaceState: true, keepFocus: true, noScroll: true });
  }
  function observeCanvas() {
    if (!canvas || canvasResizeObserver) return;
    canvasResizeObserver = new ResizeObserver(() => { if (screen === 'edit') { fitView(); draw(); } });
    canvasResizeObserver.observe(canvas);
  }
  function fitView() {
    if (!sheet) return;
    const rect = canvas?.getBoundingClientRect();
    const width = rect?.width || 900, height = rect?.height || 600;
    const padding = 64;
    const scale = Math.max(5, Math.min(500, Math.min((width - padding * 2) / Number(sheet.width_in), (height - padding * 2) / Number(sheet.height_in))));
    view = { scale, originX: width / 2 - Number(sheet.width_in) * scale / 2, originY: height / 2 + Number(sheet.height_in) * scale / 2 }; requestAnimationFrame(draw);
  }
  async function createNewSheet() {
    if (!newSheet.name.trim()) return toastActions.show('Name the sheet first');
    try { const made = await createSheet({ name: newSheet.name.trim(), width_in: newSheet.width, height_in: newSheet.height, thickness_key: newSheet.thickness, created_by: user?.id || null }); showNewSheet = false; await refreshSheets(); await openSheet(made.id); } catch (error) { toastActions.show(error.message); }
  }
  async function removeSheet(item) {
    if (!await requestConfirmation({ title: 'Delete sheet', message: `Delete ${item.name} and all of its cuts and placements?`, confirmLabel: 'Delete', danger: true })) return;
    try { await deleteSheet(item.id); await refreshSheets(); toastActions.show(`Deleted ${item.name}`); } catch (error) { toastActions.show(error.message); }
  }
  function commit(next) { placements = undo.commit(next); selectedId = selectedId && placements.some(p => p.id === selectedId) ? selectedId : null; draw(); }
  function undoChange() { placements = undo.undo(); draw(); }
  function redoChange() { placements = undo.redo(); draw(); }
  async function save({ quiet = false } = {}) { if (!activeCutId) return false; saving = true; try { await savePlacements(activeCutId, placements); updateActiveCutInMemory(); if (!quiet) toastActions.show('Sheet saved'); return true; } catch (error) { toastActions.show(error.message); return false; } finally { saving = false; } }
  function updateActiveCutInMemory() { const cut = sheet?.nesting_cuts?.find(item => item.id === activeCutId); if (cut) cut.nesting_placements = structuredClone(placements); }
  async function addCut() {
    const name = `Cut ${(sheet.nesting_cuts?.length || 0) + 1}`;
    if (!await save({ quiet: true })) return;
    try { const cut = await createCut(sheet.id, name); sheet.nesting_cuts = [...sheet.nesting_cuts, { ...cut, nesting_placements: [] }]; activeCutId = cut.id; placements = []; undo = createUndoStack([]); await setActiveCut(sheet.id, cut.id); draw(); } catch (error) { toastActions.show(error.message); }
  }
  async function chooseCut(id) { if (id === activeCutId || !await save({ quiet: true })) return; activeCutId = id; placements = structuredClone(sheet.nesting_cuts.find(c => c.id === id)?.nesting_placements || []); undo = createUndoStack(placements); selectedId = null; await setActiveCut(sheet.id, id); await loadPlacedPrograms(); draw(); }
  function beginRenameCut() { cutName = activeCut?.name || ''; editingCutName = true; }
  async function saveCutName() {
    const name = cutName.trim();
    if (!name) return toastActions.show('Name the cut first');
    try { const renamed = await renameCut(activeCutId, name); sheet.nesting_cuts = sheet.nesting_cuts.map(cut => cut.id === activeCutId ? { ...cut, ...renamed } : cut); editingCutName = false; } catch (error) { toastActions.show(error.message); }
  }
  async function removeActiveCut() {
    if ((sheet?.nesting_cuts?.length || 0) <= 1) return toastActions.show('A sheet needs at least one cut');
    if (!await requestConfirmation({ title: 'Delete cut', message: `Delete ${activeCut?.name || 'this cut'} and its placements?`, confirmLabel: 'Delete', danger: true })) return;
    if (!await save({ quiet: true })) return;
    try {
      const remaining = sheet.nesting_cuts.filter(cut => cut.id !== activeCutId);
      const nextCut = remaining[0];
      await deleteCut(activeCutId);
      sheet = { ...sheet, active_cut_id: nextCut.id, nesting_cuts: remaining };
      activeCutId = nextCut.id; placements = structuredClone(nextCut.nesting_placements || []); undo = createUndoStack(placements); selectedId = null;
      await setActiveCut(sheet.id, nextCut.id); await loadPlacedPrograms(); draw();
    } catch (error) { toastActions.show(error.message); }
  }
  async function loadLibrary() {
    try {
      const root = sheetPartLibraryRoot(sheet?.name);
      const files = (await listPartsLibrary(sheet?.name)).filter(item => /\.(ngc|tap)$/i.test(item.name));
      const groups = new Map();
      for (const item of files) {
        const pieces = item.path.split('/');
        const folder = pieces.length > 2 ? pieces.slice(-2, -1)[0] : item.name.replace(/\.[^.]+$/, '');
        const key = `${root}/${folder}`;
        const isUuidFolder = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(folder);
        const fileStem = item.name.replace(/\.[^.]+$/, ''), label = isUuidFolder ? fileStem.replace(/_[^_]+$/, '') : folder;
        if (!groups.has(key)) groups.set(key, { key, label, files: [], suffixes: [], programTypes: new Set() });
        groups.get(key).files.push(item);
        groups.get(key).programTypes.add(programTypeForName(item.name));
        const stem = item.name.replace(/\.[^.]+$/, ''), suffixIndex = stem.lastIndexOf('_');
        groups.get(key).suffixes.push(suffixIndex === -1 ? '' : stem.slice(suffixIndex + 1).toLowerCase());
      }
      partGroups = [...groups.values()].map(({ programTypes, ...group }) => ({ ...group, programType: programTypes.size === 1 ? [...programTypes][0] : null })).sort((a, b) => a.label.localeCompare(b.label));
    } catch { partGroups = []; }
  }
  async function readPartGroup(group) {
    const variants = await Promise.all(group.files.map(async file => parseGcodeDocument(await downloadText(file.path), file.name)));
    const primary = variants[0], bounds = variants.reduce((largest, item) => item.bounds.width * item.bounds.height > largest.width * largest.height ? item.bounds : largest, primary.bounds);
    return { variants, bounds };
  }
  async function loadPlacedPrograms() {
    await Promise.all(renderedPlacements.filter(item => item.kind === 'part' && !gcodePrograms[item.part_library_path]).map(async item => {
      let group = partGroups.find(candidate => candidate.key === item.part_library_path);
      if (!group && item.part_library_path) {
        try {
          const files = (await listPartLibraryAtPath(item.part_library_path)).filter(file => /\.(ngc|tap)$/i.test(file.name));
          if (files.length) group = { key: item.part_library_path, label: item.label, files };
        } catch { /* The rectangle fallback remains if an old file is gone. */ }
      }
      if (!group) return;
      try { gcodePrograms[item.part_library_path] = await readPartGroup(group); } catch { /* Keep existing placements editable if a library file is unavailable. */ }
    }));
  }
  async function armStoredPart(group) {
    try {
      const type = group.programType || singleProgramType(group.files.map(file => file.name));
      assertProgramTypeCompatible(sheet?.program_extension, type);
      if (!sheet?.program_extension && type) { await setSheetProgramType(sheet.id, type); sheet = { ...sheet, program_extension: type }; }
      const program = await readPartGroup(group); gcodePrograms[group.key] = program;
      activePart = { label: group.label, part_library_path: group.key, width_in: program.bounds.width, height_in: program.bounds.height };
      placing = { ...activePart }; placingWithShortcut = false;
      showLibrary = false; toastActions.show(`Click the sheet to place ${group.label}. Press Esc when finished.`);
    } catch (error) { toastActions.show(error.message); }
  }
  async function uploadParts(event) {
    const files = [...(event.currentTarget.files || [])]; if (!files.length) return;
    let type;
    try {
      type = singleProgramType(files.map(file => file.name));
      assertProgramTypeCompatible(sheet?.program_extension, type);
    } catch (error) { toastActions.show(error.message); event.currentTarget.value = ''; return; }
    const firstStem = files[0].name.replace(/\.[^.]+$/, '');
    const partName = firstStem.replace(/_[^_]+$/, '') || firstStem;
    try {
      await Promise.all(files.map(file => uploadPartFile(file, sheet.name, partName)));
      const variants = await Promise.all(files.map(async file => parseGcodeDocument(await file.text(), file.name)));
      const primary = variants[0], bounds = variants.reduce((largest, item) => item.bounds.width * item.bounds.height > largest.width * largest.height ? item.bounds : largest, primary.bounds);
      const key = `${sheetPartLibraryRoot(sheet.name)}/${partName}`; gcodePrograms[key] = { variants, bounds };
      if (!sheet?.program_extension && type) { await setSheetProgramType(sheet.id, type); sheet = { ...sheet, program_extension: type }; }
      activePart = { label: partName, part_library_path: key, width_in: bounds.width, height_in: bounds.height };
      placing = { ...activePart }; placingWithShortcut = false;
      await loadLibrary(); toastActions.show(`Uploaded ${files.length} program${files.length === 1 ? '' : 's'}; click the sheet to place it`);
    } catch (error) { toastActions.show(error.message); }
    event.currentTarget.value = '';
  }
  function draw() {
    if (!canvas || !sheet) return;
    const rect = canvas.getBoundingClientRect(); canvas.width = rect.width * devicePixelRatio; canvas.height = rect.height * devicePixelRatio;
    ctx = canvas.getContext('2d'); ctx.scale(devicePixelRatio, devicePixelRatio); ctx.clearRect(0, 0, rect.width, rect.height);
    const a = sheetToScreen({ x: 0, y: 0 }, view), b = sheetToScreen({ x: Number(sheet.width_in), y: Number(sheet.height_in) }, view);
    ctx.fillStyle = '#17345f'; ctx.fillRect(a.x, b.y, b.x - a.x, a.y - b.y); ctx.strokeStyle = '#8aa4c7'; ctx.lineWidth = 2; ctx.strokeRect(a.x, b.y, b.x - a.x, a.y - b.y);
    for (const p of renderedPlacements) {
      const s = sheetToScreen(p, view); ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(-p.rotation);
      const preview = gcodePrograms[p.part_library_path]?.variants?.[0];
      const cutColor = CUT_COLORS[p.renderCutIndex % CUT_COLORS.length];
      if (preview?.toolpath?.length) {
        ctx.scale(view.scale, -view.scale); ctx.strokeStyle = p.renderActive && p.id === selectedId ? '#101828' : cutColor; ctx.lineWidth = (p.renderActive ? 1.7 : 1.25) / view.scale;
        for (const segment of preview.toolpath) {
          ctx.globalAlpha = segment.rapid ? .18 : 1; ctx.beginPath();
          segment.points.forEach((point, index) => { const x = point.x - preview.bounds.centerX, y = point.y - preview.bounds.centerY; if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = p.renderActive && p.id === selectedId ? '#101828' : cutColor; ctx.globalAlpha = p.renderActive ? .86 : .5;
        if (p.kind === 'hole') { ctx.beginPath(); ctx.arc(0, 0, Math.max(4, p.width_in * view.scale / 2), 0, Math.PI * 2); ctx.fill(); }
        else ctx.fillRect(-p.width_in * view.scale / 2, -p.height_in * view.scale / 2, p.width_in * view.scale, p.height_in * view.scale);
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }
    if (selected?.kind === 'part') {
      const center = sheetToScreen(selected, view), handle = { x: center.x, y: center.y - Math.max(28, selected.height_in * view.scale / 2 + 18) };
      ctx.strokeStyle = '#d97706'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(center.x, center.y); ctx.lineTo(handle.x, handle.y); ctx.stroke();
      ctx.fillStyle = '#fbbf24'; ctx.beginPath(); ctx.arc(handle.x, handle.y, 8, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#7c2d12'; ctx.stroke();
    }
    if (measure.length) {
      const points = measure.map(point => sheetToScreen(point, view)); ctx.strokeStyle = '#fbbf24'; ctx.fillStyle = '#fbbf24'; ctx.lineWidth = 2;
      for (const point of points) { ctx.beginPath(); ctx.arc(point.x, point.y, 4, 0, Math.PI * 2); ctx.fill(); }
      if (points.length === 2) { ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y); ctx.lineTo(points[1].x, points[1].y); ctx.stroke(); }
    }
  }
  function rotationHandlePoint(placement) {
    const center = sheetToScreen(placement, view);
    return { center, handle: { x: center.x, y: center.y - Math.max(28, placement.height_in * view.scale / 2 + 18) } };
  }
  function pointerDown(event) {
    if (!sheet) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const rect = canvas.getBoundingClientRect(), point = screenToSheet({ x: event.clientX - rect.left, y: event.clientY - rect.top }, view);
    if (measuring || event.shiftKey) { measure = measure.length === 1 ? [...measure, point] : [point]; if (measure.length === 2) measuring = false; draw(); return; }
    if (selected?.kind === 'part') {
      const { center, handle } = rotationHandlePoint(selected);
      if (Math.hypot(event.clientX - rect.left - handle.x, event.clientY - rect.top - handle.y) <= 14) {
        rotationDrag = { id: selected.id, center }; return;
      }
    }
    if (placing) {
      const item = clampPlacementToSheet(sheet, makePlacement({ ...placing, x: point.x, y: point.y }));
      if (!item) return toastActions.show('This part is larger than the selected sheet');
      commit([...placements, item]); selectedId = item.id; return;
    }
    const hit = [...placements].reverse().find(p => placementContains(p, point.x, point.y)); selectedId = hit?.id || null;
    if (hit?.kind === 'part') activePart = { kind: hit.kind, label: hit.label, part_library_path: hit.part_library_path, width_in: hit.width_in, height_in: hit.height_in };
    drag = hit ? { id: hit.id, start: point, placement: structuredClone(hit) } : { pan: true, start: { x: event.clientX, y: event.clientY }, view: { ...view } }; draw();
  }
  function pointerMove(event) {
    if (rotationDrag) {
      const rect = canvas.getBoundingClientRect(), dx = event.clientX - rect.left - rotationDrag.center.x, dy = event.clientY - rect.top - rotationDrag.center.y;
      const rotation = -Math.atan2(dx, -dy);
      placements = placements.map(p => p.id === rotationDrag.id ? { ...p, rotation } : p); draw(); return;
    }
    if (!drag) return;
    if (drag.pan) { view = { ...view, originX: drag.view.originX + event.clientX - drag.start.x, originY: drag.view.originY + event.clientY - drag.start.y }; draw(); return; }
    const rect = canvas.getBoundingClientRect(), point = screenToSheet({ x: event.clientX - rect.left, y: event.clientY - rect.top }, view), dx = point.x - drag.start.x, dy = point.y - drag.start.y;
    placements = placements.map(p => p.id === drag.id ? { ...p, x: drag.placement.x + dx, y: drag.placement.y + dy } : p); draw();
  }
  function pointerUp(event) { if (event?.type === 'pointerleave') return; if (event?.currentTarget?.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); if (rotationDrag) { undo.commit(placements); rotationDrag = null; draw(); return; } if (drag && !drag.pan) { const moved = placements.find(item => item.id === drag.id); if (moved && !sheetContains(sheet, moved)) placements = placements.map(item => item.id === drag.id ? drag.placement : item); else undo.commit(placements); } drag = null; draw(); }
  function wheel(event) { event.preventDefault(); const r = canvas.getBoundingClientRect(); view = zoomAt(view, { x: event.clientX - r.left, y: event.clientY - r.top }, event.deltaY < 0 ? 1.06 : .94); draw(); }
  function placeHole() { placing = { kind: 'hole', label: 'Hole', width_in: .3, height_in: .3 }; measure = []; toastActions.show('Uses the selected sheet thickness hole program'); }
  function rotateSelected(turns = 1) { if (selected?.kind === 'part') commit(placements.map(p => p.id === selected.id ? rotatePlacement(p, -turns) : p)); }
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
  async function buildEmissions() {
    await ensurePrograms();
    const suffixes = availableSuffixes.length ? availableSuffixes.map(suffix => suffix === defaultGroupLabel ? '' : suffix) : [''];
    const targets = emitSuffix === 'all' ? suffixes : [emitSuffix === defaultGroupLabel ? '' : emitSuffix || suffixes[0]];
    return targets.map(suffix => ({ ...emitNestingGcode({ name: emitName || sheet.name, placements, programs: gcodePrograms, suffix, suffixCount: targets.length, dialect, thickness: sheet.thickness_key }), suffix })).filter(result => result.emitted);
  }
  function downloadEmission(result) {
    const url = URL.createObjectURL(new Blob([result.text], { type: 'text/plain' })), link = document.createElement('a'); link.href = url; link.download = result.filename; link.click(); URL.revokeObjectURL(url);
  }
  async function downloadGcode() {
    try {
      const results = await buildEmissions();
      if (!results.length) throw new Error('No placed item has a program for the selected suffix.');
      results.forEach(downloadEmission); showEmit = false; toastActions.show(`Downloaded ${results.length} G-code file${results.length === 1 ? '' : 's'}`);
    } catch (error) { toastActions.show(error.message); }
  }
  async function commitGcode() {
    try {
      const results = await buildEmissions();
      if (!results.length) throw new Error('No placed item has a program for the selected suffix.');
      for (const result of results) {
        const path = await uploadEmittedGcode(result.filename, result.text);
        await publishJprogOutput(path, result.text);
        await recordEmission({ cut_id: activeCutId, suffix: result.suffix || '', dialect, output_storage_path: path, tool_order: [] });
      }
      showEmit = false; toastActions.show(`Committed ${results.length} G-code file${results.length === 1 ? '' : 's'} to output`);
    } catch (error) { toastActions.show(error.message); }
  }
</script>

<svelte:head><title>JProg</title></svelte:head>
{#if loading}<main class="nesting"><p>Loading JProg...</p></main>
{:else if loadError}<main class="nesting"><h1>JProg</h1><p>{loadError}</p><p>Reload this page. If the error persists after deployment, apply <code>migrations/20260914000000_nesting_system.sql</code>.</p></main>
{:else if !user}<main class="nesting"><h1>JProg</h1><p>Sign in to use JProg.</p></main>
{:else if screen === 'settings'}
  <main class="nesting"><header><div><p class="eyebrow">JProg</p><h1>Settings</h1></div><button class="btn btn-secondary" on:click={() => { screen = 'select'; goto('/jprog'); }}><FolderOpen size={16}/> JProg Home</button></header><section class="settings-panel"><h2>Coordinate system</h2><p>Sheets use positive inch dimensions. The lower-left of each sheet is X0 Y0; the canvas handles screen-space inversion internally.</p><h2>Part library</h2><p>Upload all <code>.ngc</code> or <code>.tap</code> variants for a part at once. Their final underscore suffixes become emission groups, matching JProg's suffix workflow.</p><h2>Output</h2><p>Each emission is saved in the Manufacturing Files tab under <code>JustinProgOutput/YYYYMMDD/</code>. The date folder is created automatically when the first program is emitted.</p><h2>Hole programs</h2><p>Added holes use the bundled JProg thickness program and only emit with the <code>holes</code> suffix.</p><h2>Workflow boundary</h2><p>JProg remains standalone. Emitting a program does not queue or update AutoCAM or Fusion.</p></section></main>
{:else if screen === 'select'}
  <main class="nesting jprog-home"><header class="jprog-home-header"><div><p class="eyebrow">Manufacturing</p><h1>JProg</h1><p class="home-subtitle">Manual sheet layout and G-code emission</p></div><div class="header-actions"><button class="btn btn-secondary" on:click={() => screen = 'settings'}><Settings size={16}/> Settings</button><button class="btn btn-primary" on:click={() => showNewSheet = true}><Plus size={16}/> New sheet</button></div></header><section class="sheet-index"><div class="sheet-index-toolbar"><div><h2>Sheets</h2><span>{sheets.length} total</span></div><label class="search"><Search size={17}/><input bind:value={sheetSearch} placeholder="Search sheets"/></label></div><div class="sheet-list">{#each visibleSheets as item}<div class="sheet-row"><button class="sheet-open" on:click={() => openSheet(item.id)}><span class="sheet-mark"><FolderOpen size={18}/></span><span class="sheet-details"><strong>{item.name}</strong><span>{item.width_in} x {item.height_in} in stock · {item.thickness_key} in thick · {item.nesting_cuts?.length || 0} cuts</span></span><span class="open-sheet">Open</span></button><button class="icon-button danger sheet-delete" title={`Delete ${item.name}`} aria-label={`Delete ${item.name}`} on:click={() => removeSheet(item)}><Trash2 size={17}/></button></div>{:else}<div class="empty-sheets"><strong>{sheetSearch ? 'No sheets match that search.' : 'No sheets yet.'}</strong><span>{sheetSearch ? 'Try a different name.' : 'Create a sheet to begin laying out parts.'}</span></div>{/each}</div></section></main>
{:else}
  <main class="workspace"><header class="workspace-header"><div class="jprog-identity"><h1>JProg</h1><button class="btn btn-secondary" on:click={() => { screen = 'select'; goto('/jprog'); }}><FolderOpen size={16}/> JProg Home</button></div><div class="header-sheet-name"><strong>{sheet?.name}</strong><span>{sheet?.width_in} x {sheet?.height_in} in · {sheet?.thickness_key} in</span></div><div class="header-actions"><button class="btn btn-secondary" on:click={fitView}><Crosshair size={16}/> Fit sheet</button><button class:active={measuring || measure.length} class="btn btn-secondary" on:click={() => { measuring = !measuring; if (measuring) measure = []; toastActions.show(measuring ? 'Click two points to measure' : 'Measurement cancelled'); }}><Ruler size={16}/> Measure</button><button class="btn btn-secondary" disabled={!undo.canUndo} on:click={undoChange}><Undo2 size={16}/> Undo</button><button class="btn btn-secondary" disabled={!undo.canRedo} on:click={redoChange}><Redo2 size={16}/> Redo</button><button class="btn btn-secondary" on:click={save}><Save size={16}/>{saving ? 'Saving' : 'Save'}</button><button class="btn btn-primary" on:click={() => { showEmit = true; emitSuffix = availableSuffixes.length === 1 ? availableSuffixes[0] : 'all'; }}><Download size={16}/> Emit G-code</button></div></header>
  <div class="workspace-body"><aside><section class="sheet-specs"><strong>{sheet?.name}</strong><span>{sheet?.width_in} x {sheet?.height_in} in · {sheet?.thickness_key} in thick</span></section><section><label for="active-cut">Active cut</label><select id="active-cut" value={activeCutId} on:change={(e) => chooseCut(e.currentTarget.value)}>{#each sheet?.nesting_cuts || [] as cut}<option value={cut.id}>{cut.name}</option>{/each}</select>{#if editingCutName}<div class="cut-rename"><input aria-label="Cut name" bind:value={cutName} on:keydown={(event) => { if (event.key === 'Enter') saveCutName(); if (event.key === 'Escape') editingCutName = false; }}/><button class="icon-button" title="Save cut name" on:click={saveCutName}><Save size={15}/></button><button class="icon-button" title="Cancel rename" on:click={() => editingCutName = false}><X size={15}/></button></div>{/if}<div class="cut-actions"><button class="btn btn-secondary add-cut-button" on:click={addCut}><Plus size={15}/> Add cut</button><button class="icon-button" title="Rename cut" on:click={beginRenameCut}><Pencil size={15}/></button><button class="icon-button danger" title="Delete cut" disabled={(sheet?.nesting_cuts?.length || 0) <= 1} on:click={removeActiveCut}><Trash2 size={15}/></button></div></section><section><h2>Place</h2><label class="btn btn-secondary upload"><Upload size={16}/> Upload part program(s)<input type="file" accept=".ngc,.tap" multiple on:change={uploadParts}/></label><div class="row"><button class="btn btn-secondary" on:click={() => showLibrary = !showLibrary}><FolderOpen size={16}/> Library</button><button class="btn btn-secondary" on:click={loadLibrary}><RefreshCw size={16}/> Reload</button></div>{#if showLibrary}<div class="library-panel"><input class="library-search" aria-label="Search part library" bind:value={librarySearch} placeholder="Search part library"/><div class="library">{#each visiblePartGroups as group}<button title={`Place ${group.label}`} on:click={() => armStoredPart(group)}>{group.label}<span>{group.files.length}</span></button>{:else}<span class="hint">{librarySearch ? 'No matching parts.' : 'No part folders found.'}</span>{/each}</div></div>{/if}<button class:active={placing?.kind === 'hole'} class="btn btn-secondary" on:click={placeHole}><Crosshair size={16}/> Add hole</button>{#if placing}<p class="hint">Click the sheet to place {placing.label}. Keep clicking to add copies, then press Esc to finish.</p>{/if}</section>{#if selected}<section><h2>Selection</h2><strong>{selected.label}</strong><div class="coordinate-grid"><label>X<input type="number" step="0.001" value={selected.x} on:change={(e) => commit(placements.map(item => item.id === selected.id ? { ...item, x: Number(e.currentTarget.value) } : item))}/></label><label>Y<input type="number" step="0.001" value={selected.y} on:change={(e) => commit(placements.map(item => item.id === selected.id ? { ...item, y: Number(e.currentTarget.value) } : item))}/></label></div><div class="selection-actions"><button class="btn btn-secondary" on:click={() => rotateSelected(-1)}><RotateCcw size={16}/> Rotate left</button><button class="btn btn-secondary" on:click={() => rotateSelected(1)}><RotateCw size={16}/> Rotate right</button><button class="btn btn-secondary" on:click={duplicateSelected}><Copy size={16}/> Duplicate</button>{#if selected.kind === 'part'}<button class="btn btn-secondary" on:click={inspectSelected}><FileCode size={16}/> Inspect G-code</button>{/if}<button class="btn btn-secondary danger" on:click={removeSelected}><Trash2 size={16}/> Delete</button></div></section>{/if}<section><h2>Measurement</h2>{#if measure.length === 2}<strong>{Math.hypot(measure[1].x - measure[0].x, measure[1].y - measure[0].y).toFixed(3)} in</strong><button class="text-button" on:click={() => { measure = []; draw(); }}>Clear measurement</button>{:else}<p class="hint">Select the ruler, then click two points.</p>{/if}</section></aside>
  <section class="canvas-wrap"><canvas bind:this={canvas} on:pointerdown={pointerDown} on:pointermove={pointerMove} on:pointerup={pointerUp} on:pointerleave={pointerUp} on:wheel={wheel}></canvas><div class="canvas-status"><MousePointer2 size={15}/> Click to place selected G-code · Esc to finish · Drag to move/pan · Wheel to zoom · R to rotate · Delete to remove</div></section></div></main>
{/if}
{#if showNewSheet}<div class="scrim"><form class="modal" on:submit|preventDefault={createNewSheet}><button type="button" class="modal-close" title="Close" on:click={() => showNewSheet = false}><X size={18}/></button><h2>New Sheet</h2><label>Name<input bind:value={newSheet.name} /></label><div class="two"><label>Width (in)<input type="number" min="1" bind:value={newSheet.width}/></label><label>Height (in)<input type="number" min="1" bind:value={newSheet.height}/></label></div><label>Thickness<select bind:value={newSheet.thickness}><option value="0.063">1/16 in</option><option value="0.09">0.090 in</option><option value="0.125">1/8 in</option><option value="0.1875">3/16 in</option><option value="0.25">1/4 in</option><option value="0.3125">5/16 in</option><option value="0.375">3/8 in</option><option value="0.5">1/2 in</option><option value="0.75">3/4 in</option></select></label><div class="row"><button type="button" class="btn btn-secondary" on:click={() => showNewSheet = false}>Cancel</button><button class="btn btn-primary">Create sheet</button></div></form></div>{/if}
{#if showEmit}<div class="scrim"><form class="modal" on:submit|preventDefault={commitGcode}><button type="button" class="modal-close" title="Close" on:click={() => showEmit = false}><X size={18}/></button><h2>Emit G-code</h2><label>Program name<input bind:value={emitName}/></label><p class="hint">{programType === 'tap' ? 'WinCNC (.tap)' : '971 / LinuxCNC (.ngc)'}</p><fieldset><legend>Program group</legend><label class="radio"><input type="radio" bind:group={emitSuffix} value="all"/> All available groups</label>{#each availableSuffixes as suffix}<label class="radio"><input type="radio" bind:group={emitSuffix} value={suffix}/> {suffix || 'default'}</label>{/each}{#if !availableSuffixes.length}<p class="hint">Add a part or hole before emitting.</p>{/if}</fieldset><div class="row emit-actions"><button type="button" class="btn btn-secondary" on:click={() => showEmit = false}>Cancel</button><button type="button" class="btn btn-secondary" on:click={downloadGcode} disabled={!placements.length || !availableSuffixes.length}><Download size={16}/> Download</button><button class="btn btn-primary" disabled={!placements.length || !availableSuffixes.length}><Upload size={16}/> Commit to Output</button></div></form></div>{/if}
{#if showProgram}<div class="scrim"><section class="modal program"><button type="button" class="modal-close" title="Close" on:click={() => showProgram = false}><X size={18}/></button><h2>{selected?.label} programs</h2>{#each selectedProgram?.variants || [] as variant}<details><summary>{variant.name} · {variant.dialect} · {variant.suffix || 'default'}</summary><pre>{variant.source}</pre></details>{/each}</section></div>{/if}

{#if screen === 'edit'}<a class="workspace-output-link btn btn-primary" href={JPROG_OUTPUT_REPOSITORY} target="_blank" rel="noreferrer"><ExternalLink size={16}/> Open Output Repository</a>{/if}

<style>
  .nesting,.workspace{max-width:1400px;margin:0 auto;padding:28px}.nesting header,.workspace-header,.row{display:flex;align-items:center;justify-content:space-between;gap:12px}.eyebrow{margin:0;color:var(--muted-text,#667085);font-size:.8rem;text-transform:uppercase;letter-spacing:0}.nesting h1,.workspace h1{margin:2px 0;font-size:1.7rem}.settings-panel{max-width:700px;margin-top:24px;padding:20px;border:1px solid var(--border-color,#d0d5dd);border-radius:6px}.settings-panel h2{font-size:1rem;margin:16px 0 4px}.settings-panel h2:first-child{margin-top:0}.settings-panel p,.hint{color:var(--muted-text,#667085);line-height:1.45}.header-actions{display:flex;gap:8px;align-items:center}.jprog-identity{display:grid;gap:8px;justify-items:start}.jprog-identity h1{margin:0}.header-sheet-name{display:grid;gap:2px;text-align:center;color:var(--muted-text,#667085)}.header-sheet-name strong{color:var(--text,#101828);font-size:1rem}.header-sheet-name span{font-size:.8rem}.search{display:flex;margin-top:24px;max-width:540px;align-items:center;gap:8px;border:1px solid var(--border-color,#d0d5dd);padding:8px 10px}.search input{border:0;padding:0;min-width:0;width:100%}.sheet-list{margin-top:14px;display:grid;gap:8px;max-width:720px}.sheet-row{display:flex;justify-content:space-between;gap:12px;text-align:left;padding:16px;border:1px solid var(--border-color,#d0d5dd);background:var(--card-bg,#fff);border-radius:6px}.sheet-row span{color:var(--muted-text,#667085)}.workspace{max-width:none;padding:14px;height:calc(100vh - 70px);display:flex;flex-direction:column}.workspace-header{padding:0 4px 14px;border-bottom:1px solid var(--border-color,#d0d5dd)}.workspace-body{flex:1;min-height:0;display:grid;grid-template-columns:270px 1fr;margin-top:12px;gap:12px}aside{border:1px solid var(--border-color,#d0d5dd);padding:12px;overflow:auto}aside section{display:grid;gap:9px;padding:12px 0;border-bottom:1px solid var(--border-color,#d0d5dd)}aside h2{font-size:1rem;margin:0}.sheet-specs{display:grid;gap:2px;color:var(--muted-text,#667085);font-size:.85rem}.sheet-specs strong{color:var(--text,#101828)}.library{display:grid;gap:4px;max-height:190px;overflow:auto}.library button{padding:7px;text-align:left;border:1px solid var(--border-color,#d0d5dd);background:var(--card-bg,#fff);display:flex;justify-content:space-between;transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease}.library button:hover,.library button:focus-visible{transform:translateX(3px);border-color:var(--primary,#2563eb);box-shadow:0 3px 10px #10182822;outline:none}.canvas-wrap{position:relative;min-height:0;background:#000;border:1px solid #344054;overflow:hidden}canvas{width:100%;height:100%;touch-action:none}.canvas-status{position:absolute;bottom:12px;left:12px;color:#fff;background:#101828d9;padding:7px 10px;display:flex;gap:7px;font-size:.8rem}.btn,.text-button{display:inline-flex;align-items:center;justify-content:center;gap:7px}.text-button{border:0;background:none;color:var(--primary,#2563eb);justify-content:start;padding:2px}.upload input{display:none}.active{outline:2px solid var(--primary,#2563eb)}.danger{color:#b42318}.selection-actions{display:grid;gap:6px}.selection-actions .btn{justify-content:flex-start}label{display:grid;gap:5px;font-size:.85rem}input,select{padding:8px;border:1px solid var(--border-color,#d0d5dd);border-radius:4px;background:var(--card-bg,#fff);color:inherit}.coordinate-grid,.two{display:grid;grid-template-columns:1fr 1fr;gap:8px}.scrim{position:fixed;inset:0;background:#10182899;display:grid;place-items:center;z-index:10}.modal{position:relative;background:var(--card-bg,#fff);padding:22px;width:min(460px,calc(100vw - 32px));display:grid;gap:14px;border-radius:8px;max-height:calc(100vh - 32px);overflow:auto}.modal h2{margin:0}.modal-close{position:absolute;right:12px;top:12px;border:0;background:none;color:inherit}.modal fieldset{display:grid;gap:8px;border:1px solid var(--border-color,#d0d5dd)}.radio{display:flex;align-items:center;gap:8px}.radio input{padding:0}.program{width:min(900px,calc(100vw - 32px))}.program details{border:1px solid var(--border-color,#d0d5dd);padding:8px}.program pre{white-space:pre;overflow:auto;max-height:320px;font-size:.75rem}@media(max-width:720px){.workspace{height:auto;min-height:100vh;padding:10px}.workspace-body{grid-template-columns:1fr;grid-template-rows:auto 65vh}.workspace-header{align-items:flex-start}.header-actions{flex-wrap:wrap;justify-content:end}.nesting,.workspace{padding:16px}.sheet-row{display:grid;gap:4px}.canvas-status{max-width:calc(100% - 24px)}}

  .jprog-home { max-width: 1180px; padding-top: 48px; }
  .jprog-home-header { padding-bottom: 26px; border-bottom: 1px solid var(--border-color, #d0d5dd); }
  .jprog-home h1 { font-size: 2rem; font-weight: 700; }
  .home-subtitle { margin: 5px 0 0; color: var(--muted-text, #667085); }
  .sheet-index { margin-top: 26px; }
  .sheet-index-toolbar { display: flex; align-items: end; justify-content: space-between; gap: 24px; padding-bottom: 12px; }
  .sheet-index-toolbar h2 { margin: 0; font-size: 1rem; }
  .sheet-index-toolbar > div > span { display: block; margin-top: 3px; color: var(--muted-text, #667085); font-size: .82rem; }
  .sheet-index .search { margin: 0; width: min(100%, 380px); max-width: none; background: var(--card-bg, #fff); border-radius: 5px; }
  .sheet-list { max-width: none; gap: 7px; }
  .sheet-row { min-height: 74px; align-items: center; padding: 13px 16px; border-radius: 6px; transition: border-color .15s ease, background .15s ease; }
  .sheet-row:hover { border-color: var(--primary, #2563eb); background: var(--primary-soft, #eff6ff); }
  .sheet-open { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 0; border: 0; background: transparent; color: inherit; text-align: left; }
  .sheet-delete { flex: 0 0 auto; }
  .sheet-mark { display: grid; place-items: center; width: 38px; height: 38px; color: var(--primary, #2563eb); background: var(--primary-soft, #eff6ff); border-radius: 5px; }
  .sheet-details { display: grid; gap: 4px; flex: 1; min-width: 0; }
  .sheet-details strong { font-size: 1rem; }
  .sheet-details span { color: var(--muted-text, #667085); font-size: .88rem; }
  .open-sheet { color: var(--primary, #2563eb); font-size: .88rem; font-weight: 600; }
  .empty-sheets { display: grid; gap: 5px; padding: 32px 16px; color: var(--muted-text, #667085); border: 1px dashed var(--border-color, #d0d5dd); text-align: center; }
  .empty-sheets strong { color: inherit; }
  @media (max-width: 720px) {
    .jprog-home { padding-top: 28px; }
    .jprog-home-header, .sheet-index-toolbar { align-items: flex-start; flex-direction: column; }
    .sheet-index .search { width: 100%; }
    .sheet-row { grid-template-columns: auto 1fr; }
    .open-sheet { display: none; }
  }
  .cut-actions, .cut-rename { display: flex; align-items: center; gap: 6px; }
  .cut-actions .add-cut-button { flex: 1; color: #1c1913; background: #d4a72c; border-color: #b88912; }
  .cut-rename input { min-width: 0; flex: 1; }
  label.radio { display: grid !important; grid-template-columns: 24px minmax(0, 1fr); align-items: center; gap: 8px; }
  label.radio input { grid-column: 1; margin: 0; }
  .workspace-header .header-actions { flex-wrap: nowrap; margin-left: auto; }
  .workspace-header { display: grid; grid-template-columns: 150px minmax(0, 1fr) auto; align-items: start; }
  .workspace-header .jprog-identity { justify-self: start; min-width: 0; }
  .workspace-header .jprog-identity .btn { white-space: nowrap; }
  .workspace-header .header-sheet-name { justify-self: start; text-align: left; padding-top: 2px; }
  .workspace-body { margin-left: -14px; width: calc(100% + 14px); }
  .workspace-output-link { position: fixed; right: 16px; bottom: 16px; z-index: 3; }
  @media (max-width: 900px) { .workspace-header .header-actions { flex-wrap: wrap; } }
  .icon-button { width: 2rem; height: 2rem; padding: 0; border: 1px solid var(--border-color, #d0d5dd); border-radius: 4px; background: var(--card-bg, #fff); display: inline-flex; align-items: center; justify-content: center; }
  .icon-button:disabled { opacity: .45; cursor: not-allowed; }
  .modal label:has(> select) { position: relative; }
  .modal label:has(> select)::after { content: ''; position: absolute; right: 15px; bottom: 15px; width: 8px; height: 8px; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; transform: rotate(45deg); pointer-events: none; }
  .modal select { width: 100%; min-width: 0; box-sizing: border-box; height: 44px; padding: 8px 3rem 8px 12px; line-height: 1.4; white-space: nowrap; text-overflow: clip; appearance: none; -webkit-appearance: none; }
  .library-panel { display: grid; gap: 6px; min-height: 0; }
  .library-search { width: 100%; min-width: 0; box-sizing: border-box; }
  .library { height: 220px; max-height: 220px; overflow-y: auto; overscroll-behavior: contain; align-content: start; }
  .library button { min-height: 40px; white-space: normal; overflow-wrap: anywhere; line-height: 1.25; align-items: center; }
</style>
