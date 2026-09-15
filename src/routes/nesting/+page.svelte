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
  import { Plus, Save, Undo2, Redo2, RotateCw, RotateCcw, Download, Upload, Crosshair, MousePointer2, FolderOpen, Search, RefreshCw, Ruler, FileCode, Trash2, Copy, Settings, X, Pencil, ExternalLink, AlertTriangle, Cpu, ArrowDown, ArrowUp } from 'lucide-svelte';
  import { listSheets, createSheet, getSheet, deleteSheet, savePlacements, createCut, renameCut, deleteCut, setActiveCut, setSheetProgramType, recordEmission } from '$lib/nesting/db.js';
  import { listAllPartsLibrary, listAutoCamPrograms, listPartsLibrary, listPartLibraryAtPath, renamePartLibraryGroup, sheetPartLibraryRoot, uploadPartFile, downloadText, uploadEmittedGcode } from '$lib/nesting/storage.js';
  import { makePlacement, placementContains, placementHasEdgeClearance, rotatePlacement } from '$lib/nesting/sheetModel.js';
  import { screenToSheet, sheetToScreen, zoomAt } from '$lib/nesting/coords.js';
  import { createUndoStack } from '$lib/nesting/undoStack.js';
  import { parseGcodeDocument } from '$lib/nesting/gcodeDocument.js';
  import { emitNestingGcode, nestingEmissionTools } from '$lib/nesting/gcodeEmit.js';
  import { HOLE_HEAD_SIZE_IN } from '$lib/nesting/holePrograms.js';
  import { assertProgramTypeCompatible, dialectForProgramType, programTypeForName, singleProgramType } from '$lib/nesting/programType.js';
  import { placementIssueIds, placementsOverlap, validateCut } from '$lib/nesting/validation.js';
  import { convertGcodeToInches } from '$autocam/fusion/gcodeUnitConvert.js';
  import { fetchFusionJobNcFiles } from '$lib/fusionCam.js';

  export let forcedScreen = null;
  export let sheetId = null;
  let canvas, ctx, canvasResizeObserver, sheets = [], sheet = null, placements = [], selectedId = null, loading = true, saving = false;
  let screen = forcedScreen || 'select', view = { scale: 28, originX: 80, originY: 520 }, drag = null, rotationDrag = null, rotationAnimationFrame = null, rotationKeyHeld = false, placing = null, activePart = null, placingWithShortcut = false;
  let undo = createUndoStack([]), gcodePrograms = {}, partGroups = [], newSheet = { name: '', width: 48, height: 30, thickness: '0.125' };
  let showNewSheet = false, showLibrary = true, showLibraryModal = false, loadingLibraryModal = false, libraryScope = 'all', showCamJobs = false, loadingCamJobs = false, camJobs = [], camJobSearch = '', camJobDateFrom = '', camJobDateTo = '', showEmit = false, showProgram = false, showCommands = false, committingGcode = false, deletingCut = false, activeCutId = null, pendingAutoCamFile = null, user = null, loadError = '';
  let sheetSearch = '', librarySearch = '', measure = [], measuring = false, emitName = '', emitSuffix = '', emitCutId = null, emitToolOrder = [], selectedProgram = null, editingCutName = false, cutName = '';
  let allPartGroups = [], libraryDateFrom = '', libraryDateTo = '', libraryRenamePath = null, libraryRenameName = '', showInactiveCuts = true, autosaveTimer = null, placementSaveQueue = Promise.resolve(), placementRevision = 0, saveStatus = 'saved';
  const CUT_COLORS = ['#f59e0b', '#22c55e', '#f43f5e', '#e879f9', '#facc15', '#2dd4bf', '#fb923c', '#a3e635'];
  // Incremental deltas avoid the discontinuity that occurs when a drag
  // crosses 180 degrees. There is deliberately no angular snapping.
  const ROTATION_DRAG_SENSITIVITY = 1;
  const ROTATION_KEY_RADIANS_PER_SECOND = Math.PI / 3;
  const HOLE_EDGE_CLEARANCE_IN = .05;
  const JPROG_OUTPUT_REPOSITORY = 'https://github.com/yuvanshankar30/output';
  function currentRenderedPlacements() {
    return (sheet?.nesting_cuts || []).flatMap((cut, cutIndex) =>
      (cut.id === activeCutId ? placements : cut.nesting_placements || [])
        .filter(() => showInactiveCuts || cut.id === activeCutId)
        .map((placement) => ({ ...placement, renderCutId: cut.id, renderCutIndex: cutIndex, renderActive: cut.id === activeCutId }))
    );
  }
  $: selected = placements.find((item) => item.id === selectedId) || null;
  $: activeCut = sheet?.nesting_cuts?.find((cut) => cut.id === activeCutId) || null;
  $: renderedPlacements = currentRenderedPlacements();
  $: visibleSheets = sheets.filter(item => item.name.toLowerCase().includes(sheetSearch.trim().toLowerCase()));
  $: emitCut = sheet?.nesting_cuts?.find((cut) => cut.id === emitCutId) || activeCut;
  $: emitPlacements = emitCut?.id === activeCutId ? placements : emitCut?.nesting_placements || [];
  $: availableSuffixes = [...new Set([
    ...(emitPlacements.some(item => item.kind === 'hole') ? ['holes'] : []),
    ...emitPlacements.flatMap(item => gcodePrograms[item.part_library_path]?.variants?.map(variant => variant.suffix) || partGroups.find(group => group.key === item.part_library_path)?.suffixes || [])
  ])].sort();
  $: programType = sheet?.program_extension || 'ngc';
  $: dialect = dialectForProgramType(programType);
  $: defaultGroupLabel = emitCut?.name || 'default';
  // Holes always emit as their own separate program using JProg's bundled
  // hole tool (T1 - see holePrograms.js) regardless of whatever tools the
  // rest of this cut uses, so a real part's tool order never actually
  // includes or depends on it (emitNestingGcode filters each suffix's
  // program down to only the tools present in that one suffix). Excluded
  // from the reorderable set here for the same reason - see emitHolesInScope
  // and the fixed "Holes / Unchangeable" row below.
  $: emitToolNumbers = dialect === 'wincnc'
    ? [...new Set((emitSuffix === 'all' ? availableSuffixes : [emitSuffix]).filter(suffix => suffix !== 'holes').flatMap(suffix => nestingEmissionTools({ placements: emitPlacements, programs: gcodePrograms, suffix, dialect, thickness: sheet?.thickness_key })))].sort((left, right) => left - right)
    : [];
  $: if (emitToolNumbers.length && !sameToolSet(emitToolOrder, emitToolNumbers)) emitToolOrder = [...emitToolNumbers];
  // Filtered against the current tool set rather than trusted as-is -
  // emitToolOrder can briefly carry a stale set (e.g. right after switching
  // to "holes" alone, where emitToolNumbers is empty and the reactive
  // block above has nothing to reset it to) between reactive updates.
  $: emitToolOrderDisplay = emitToolOrder.filter(tool => emitToolNumbers.includes(tool));
  $: emitHolesInScope = (emitSuffix === 'all' || emitSuffix === 'holes') && emitPlacements.some(item => item.kind === 'hole');
  $: recentPartGroups = [...partGroups]
    .sort((first, second) => String(second.updatedAt || '').localeCompare(String(first.updatedAt || '')))
    .slice(0, 5);
  $: visibleAllPartGroups = allPartGroups.filter(group => {
    const updated = group.updatedAt ? new Date(group.updatedAt).toISOString().slice(0, 10) : '';
    return group.label.toLowerCase().includes(librarySearch.trim().toLowerCase()) && (!libraryDateFrom || updated >= libraryDateFrom) && (!libraryDateTo || updated <= libraryDateTo);
  });
  $: visibleCamJobs = camJobs.filter((job) => {
    const name = String(job.name || job.gcode_file_name || '').toLowerCase();
    const date = job.created_at ? new Date(job.created_at).toISOString().slice(0, 10) : '';
    return (!camJobSearch.trim() || name.includes(camJobSearch.trim().toLowerCase()))
      && (!camJobDateFrom || date >= camJobDateFrom)
      && (!camJobDateTo || date <= camJobDateTo);
  });
  $: libraryTitle = libraryScope === 'sheet' ? 'Sheet part files' : 'Part library';
  $: librarySubtitle = libraryScope === 'sheet' ? `Files / Nesting Parts Library / ${sheet?.name || ''}` : 'All uploaded G-code programs';
  $: activeValidation = validateCut({ sheet, placements, programPaths: [...partGroups.map(group => group.key), ...Object.keys(gcodePrograms)], holeEdgeClearance: HOLE_EDGE_CLEARANCE_IN });
  $: emitValidation = validateCut({ sheet, placements: emitPlacements, programPaths: [...partGroups.map(group => group.key), ...Object.keys(gcodePrograms)], holeEdgeClearance: HOLE_EDGE_CLEARANCE_IN });
  $: invalidPlacementIds = placementIssueIds(activeValidation);

  onMount(() => {
    const unsubscribe = userStore.subscribe(value => user = value);
    const keepLibraryOpen = () => { if (screen === 'edit') showLibrary = true; };
    const onKey = (event) => {
      if (screen !== 'edit' || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); showCommands = true; return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redoChange() : undoChange(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelected(); }
      if (event.key.toLowerCase() === 'r' && selected?.kind === 'part') { event.preventDefault(); rotationKeyHeld = true; rotateSelectedSmoothly(); }
      if (event.key.toLowerCase() === 'a' && activePart) { event.preventDefault(); placing = { ...activePart }; placingWithShortcut = true; }
      if (event.key.toLowerCase() === 'e') { event.preventDefault(); void openEmitDialog(); }
      if (event.key.toLowerCase() === 'f') { event.preventDefault(); fitView(); }
      if (event.key.toLowerCase() === 'v') { event.preventDefault(); showInactiveCuts = !showInactiveCuts; draw(); }
      if (event.key.toLowerCase() === 'l') { event.preventDefault(); openLibraryBrowser(); }
      if (event.key === 'Escape') { placing = null; measure = []; selectedId = null; draw(); }
    };
    const onKeyUp = (event) => {
      if (event.key.toLowerCase() === 'r') rotationKeyHeld = false;
      if (event.key.toLowerCase() === 'a' && placingWithShortcut) { placing = null; placingWithShortcut = false; }
    };
    const clearSelectionOutsideEditor = (event) => {
      if (screen !== 'edit' || !selectedId || !(event.target instanceof Element)) return;
      // Canvas hit-testing handles selection changes there. Preserve the
      // explicit selection controls, but clear it for every other page click.
      if (event.target.closest('canvas, aside section:has(.selection-actions), .modal')) return;
      selectedId = null;
      draw();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('pointerdown', clearSelectionOutsideEditor, true);
    window.addEventListener('click', keepLibraryOpen);
    (async () => {
      try {
        const { data: { session } } = await withTimeout(supabase.auth.getSession(), 8000, 'Authentication took too long to respond.');
        if (!session) return;
        user = user || { id: session.user.id };
        void loadUserFromUUID(supabase);
        if (!canUseNesting(user)) return;
        const pendingJobId = $page.url.searchParams.get('autocamJob');
        const pendingFile = $page.url.searchParams.get('autocamFile');
        const pendingName = $page.url.searchParams.get('autocamName');
        if (pendingJobId && pendingFile) pendingAutoCamFile = { jobId: pendingJobId, fileName: pendingFile, name: pendingName || 'Fusion' };
        await withTimeout(refreshSheets(), 12000, 'JProg sheets took too long to load.');
        const id = sheetId || $page.params?.sheetId;
        if (id) await openSheet(id);
      } catch (error) {
        console.error('Failed to load JProg:', error);
        loadError = error?.message || 'Could not load JProg sheets.';
      } finally { loading = false; }
    })();
    return () => { unsubscribe(); canvasResizeObserver?.disconnect(); clearTimeout(autosaveTimer); if (rotationAnimationFrame) cancelAnimationFrame(rotationAnimationFrame); window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('pointerdown', clearSelectionOutsideEditor, true); window.removeEventListener('click', keepLibraryOpen); };
  });

  function withTimeout(promise, milliseconds, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function sameToolSet(first, second) {
    return first.length === second.length && first.every(tool => second.includes(tool));
  }
  function moveEmitTool(tool, direction) {
    const from = emitToolOrder.indexOf(tool), to = from + direction;
    if (from < 0 || to < 0 || to >= emitToolOrder.length) return;
    const next = [...emitToolOrder];
    [next[from], next[to]] = [next[to], next[from]];
    emitToolOrder = next;
  }
  async function openEmitDialog() {
    emitCutId = activeCutId;
    emitSuffix = 'all';
    try {
      await ensurePrograms(emitPlacements);
      gcodePrograms = { ...gcodePrograms };
    } catch (error) {
      toastActions.show(error.message);
    }
    showEmit = true;
  }

  async function refreshSheets() { sheets = await listSheets(); }
  async function openSheet(id) {
    if (screen === 'select' && !sheet) { await goto(`/jprog/sheets/${id}`, { noScroll: true }); return; }
    sheet = await getSheet(id); activeCutId = sheet.active_cut_id || sheet.nesting_cuts?.[0]?.id;
    const restoredHistory = restoreHistory(activeCutId, sheet.nesting_cuts?.find(c => c.id === activeCutId)?.nesting_placements || []);
    if (restoredHistory) scheduleAutosave();
    selectedId = null; screen = 'edit'; emitName = sheet.name; await tick(); observeCanvas(); fitView(); await loadLibrary(); await loadPlacedPrograms(placements); await importPendingAutoCamFile(); await tick(); fitView(); draw(); requestAnimationFrame(() => { fitView(); draw(); });
    void loadPlacedPrograms(renderedPlacements.filter(item => !item.renderActive)).then(draw);
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
  function historyKey(cutId = activeCutId) { return `jprog:history:${sheet?.id}:${cutId}`; }
  function persistHistory() { if (sheet?.id && activeCutId) sessionStorage.setItem(historyKey(), JSON.stringify(undo.snapshot)); }
  function restoreHistory(cutId, initial) {
    let history = null;
    try { history = JSON.parse(sessionStorage.getItem(historyKey(cutId)) || 'null'); } catch { /* Ignore corrupt session state. */ }
    undo = createUndoStack(initial, history); placements = undo.value;
    return Boolean(history);
  }
  function updateCutInMemory(cutId, nextPlacements) { const cut = sheet?.nesting_cuts?.find(item => item.id === cutId); if (cut) cut.nesting_placements = structuredClone(nextPlacements); }
  function scheduleAutosave() {
    if (!activeCutId) return;
    clearTimeout(autosaveTimer); saveStatus = 'unsaved';
    const cutId = activeCutId, snapshot = structuredClone(placements), revision = placementRevision;
    autosaveTimer = setTimeout(() => persistPlacements(cutId, snapshot, true, revision), 650);
  }
  async function persistPlacements(cutId, snapshot, quiet = false, revision = placementRevision) {
    const operation = placementSaveQueue.then(async () => {
      saving = true; if (cutId === activeCutId) saveStatus = 'saving';
      try { await savePlacements(cutId, snapshot); updateCutInMemory(cutId, snapshot); if (cutId === activeCutId && revision === placementRevision) saveStatus = 'saved'; if (!quiet) toastActions.show('Sheet saved'); return true; }
      catch (error) { if (cutId === activeCutId && revision === placementRevision) saveStatus = 'error'; toastActions.show(error.message); return false; }
      finally { saving = false; }
    });
    placementSaveQueue = operation.catch(() => {});
    return operation;
  }
  async function save({ quiet = false } = {}) { if (!activeCutId) return false; clearTimeout(autosaveTimer); return persistPlacements(activeCutId, structuredClone(placements), quiet); }
  function commit(next) { placements = undo.commit(next); placementRevision += 1; selectedId = selectedId && placements.some(p => p.id === selectedId) ? selectedId : null; updateCutInMemory(activeCutId, placements); persistHistory(); scheduleAutosave(); draw(); }
  function undoChange() { placements = undo.undo(); placementRevision += 1; persistHistory(); scheduleAutosave(); draw(); }
  function redoChange() { placements = undo.redo(); placementRevision += 1; persistHistory(); scheduleAutosave(); draw(); }
  async function addCut() {
    const name = `Cut ${(sheet.nesting_cuts?.length || 0) + 1}`;
    if (!await save({ quiet: true })) return;
    try { const cut = await createCut(sheet.id, name); sheet.nesting_cuts = [...sheet.nesting_cuts, { ...cut, nesting_placements: [] }]; activeCutId = cut.id; restoreHistory(cut.id, []); await setActiveCut(sheet.id, cut.id); draw(); } catch (error) { toastActions.show(error.message); }
  }
  async function chooseCut(id) { if (id === activeCutId || !await save({ quiet: true })) return; activeCutId = id; if (restoreHistory(id, sheet.nesting_cuts.find(c => c.id === id)?.nesting_placements || [])) scheduleAutosave(); selectedId = null; await setActiveCut(sheet.id, id); await loadPlacedPrograms(placements); draw(); }
  function beginRenameCut() { cutName = activeCut?.name || ''; editingCutName = true; }
  async function saveCutName() {
    const name = cutName.trim();
    if (!name) return toastActions.show('Name the cut first');
    try { const renamed = await renameCut(activeCutId, name); sheet.nesting_cuts = sheet.nesting_cuts.map(cut => cut.id === activeCutId ? { ...cut, ...renamed } : cut); editingCutName = false; } catch (error) { toastActions.show(error.message); }
  }
  async function removeActiveCut() {
    if (deletingCut || (sheet?.nesting_cuts?.length || 0) <= 1) return toastActions.show('A sheet needs at least one cut');
    if (!await requestConfirmation({ title: 'Delete cut', message: `Delete ${activeCut?.name || 'this cut'} and its placements?`, confirmLabel: 'Delete', danger: true })) return;
    clearTimeout(autosaveTimer);
    const previousSheet = sheet;
    const previousCutId = activeCutId;
    const previousPlacements = placements;
    const remaining = sheet.nesting_cuts.filter(cut => cut.id !== previousCutId);
    const nextCut = remaining[0];

    // A cut's placements are deleted with the cut, so saving them first only
    // adds latency. Switch the editor immediately and repair state on failure.
    deletingCut = true;
    sheet = { ...sheet, active_cut_id: nextCut.id, nesting_cuts: remaining };
    activeCutId = nextCut.id;
    restoreHistory(nextCut.id, nextCut.nesting_placements || []);
    selectedId = null;
    draw();
    try {
      await deleteCut(previousCutId);
      await setActiveCut(sheet.id, nextCut.id);
      void loadPlacedPrograms(renderedPlacements.filter(item => !item.renderActive)).then(draw);
    } catch (error) {
      try {
        // The delete and active-cut update are separate requests. Reload if
        // either fails so local state always reflects the database outcome.
        sheet = await getSheet(previousSheet.id);
        activeCutId = sheet.active_cut_id || sheet.nesting_cuts?.[0]?.id;
        placements = structuredClone(sheet.nesting_cuts?.find(cut => cut.id === activeCutId)?.nesting_placements || []);
      } catch {
        sheet = previousSheet;
        activeCutId = previousCutId;
        placements = previousPlacements;
      }
      restoreHistory(activeCutId, placements);
      draw();
      toastActions.show(error.message);
    } finally { deletingCut = false; }
  }
  async function loadLibrary() {
    try {
      const files = (await listPartsLibrary(sheet?.name)).filter(item => /\.(ngc|tap)$/i.test(item.name));
      partGroups = groupPartFiles(files);
    } catch { partGroups = []; }
  }
  function groupPartFiles(files) {
    const groups = new Map();
    for (const item of files) {
      const pieces = item.path.split('/'), key = pieces.slice(0, -1).join('/');
      const folder = pieces.length > 1 ? pieces.at(-2) : item.name.replace(/\.[^.]+$/, '');
      const isUuidFolder = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(folder);
      const fileStem = item.name.replace(/\.[^.]+$/, ''), label = isUuidFolder ? fileStem.replace(/_[^_]+$/, '') : folder;
      if (!groups.has(key)) groups.set(key, { key, label, files: [], suffixes: [], programTypes: new Set(), updatedAt: item.updated_at || item.created_at || null });
      const group = groups.get(key); group.files.push(item); group.programTypes.add(programTypeForName(item.name));
      if ((item.updated_at || item.created_at || '') > (group.updatedAt || '')) group.updatedAt = item.updated_at || item.created_at;
      const suffixIndex = fileStem.lastIndexOf('_'); group.suffixes.push(suffixIndex === -1 ? '' : fileStem.slice(suffixIndex + 1).toLowerCase());
    }
    return [...groups.values()].map(({ programTypes, ...group }) => ({ ...group, programType: programTypes.size === 1 ? [...programTypes][0] : null })).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || a.label.localeCompare(b.label));
  }
  async function openLibraryBrowser() {
    libraryScope = 'all'; showLibraryModal = true; loadingLibraryModal = true;
    try { allPartGroups = groupPartFiles((await listAllPartsLibrary()).filter(item => /\.(ngc|tap)$/i.test(item.name))); }
    catch (error) { toastActions.show(error.message); } finally { loadingLibraryModal = false; }
  }
  async function openSheetFiles() {
    libraryScope = 'sheet'; showLibraryModal = true; loadingLibraryModal = true;
    try { allPartGroups = groupPartFiles((await listPartsLibrary(sheet?.name)).filter(item => /\.(ngc|tap)$/i.test(item.name))); }
    catch (error) { toastActions.show(error.message); } finally { loadingLibraryModal = false; }
  }
  async function openCamJobs() {
    showCamJobs = true;
    loadingCamJobs = true;
    try {
      camJobs = (await Promise.all((await listAutoCamPrograms())
        .filter((entry) => /\.(ngc|tap)$/i.test(entry.name))
        .map(async (entry) => {
          try {
            const source = await downloadText(entry.path);
            const { gcode } = convertGcodeToInches(source);
            return { id: entry.path, name: entry.name.replace(/\.[^.]+$/, ''), gcode, gcode_file_name: entry.name, status: 'completed', operation_type: 'AutoCAM', created_at: entry.updated_at || entry.created_at };
          } catch { return null; }
        }))).filter(Boolean);
    } catch (error) {
      camJobs = [];
      toastActions.show(error.message || 'Could not load CAM jobs');
    } finally { loadingCamJobs = false; }
  }
  async function insertCamJob(job) {
    if (!job?.gcode || !sheet?.name) return toastActions.show('This CAM job has no G-code to insert');
    const sourceName = String(job.name || job.gcode_file_name || 'CAM job').replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'CAM-job';
    const partName = /autocam$/i.test(sourceName) ? sourceName : `${sourceName}AutoCAM`;
    const extension = /\.tap$/i.test(job.gcode_file_name || '') ? 'tap' : 'ngc';
    const fileName = `${partName}.${extension}`;
    try {
      assertProgramTypeCompatible(sheet?.program_extension, extension);
      const file = new File([job.gcode], fileName, { type: 'text/plain' });
      await uploadPartFile(file, sheet.name, partName);
      const variant = await parseGcodeDocument(job.gcode, fileName);
      const key = `${sheetPartLibraryRoot(sheet.name)}/${partName}`;
      gcodePrograms[key] = { variants: [variant], bounds: variant.bounds };
      const candidate = makePlacement({ kind: 'part', label: partName, part_library_path: key, width_in: variant.bounds.width, height_in: variant.bounds.height, x: Number(sheet.width_in) / 2, y: Number(sheet.height_in) / 2 });
      if (!sheet?.program_extension) { await setSheetProgramType(sheet.id, extension); sheet = { ...sheet, program_extension: extension }; }
      activePart = { kind: 'part', label: partName, part_library_path: key, width_in: variant.bounds.width, height_in: variant.bounds.height };
      commit([...placements, candidate]);
      selectedId = candidate.id;
      await save({ quiet: true });
      await loadLibrary();
      showCamJobs = false;
      toastActions.show(`Added ${partName} to this cut`);
    } catch (error) { toastActions.show(error.message || 'Could not insert CAM job'); }
  }
  async function importPendingAutoCamFile() {
    const pending = pendingAutoCamFile;
    if (!pending || !sheet?.id) return;
    try {
      const files = await fetchFusionJobNcFiles(pending.jobId);
      const file = files.find((candidate) => candidate.name === pending.fileName);
      if (!file) throw new Error('That Fusion G-code file is no longer available');
      const { gcode } = convertGcodeToInches(atob(file.contentBase64));
      pendingAutoCamFile = null;
      await insertCamJob({ id: `${pending.jobId}:${file.name}`, name: pending.name, gcode, gcode_file_name: file.name });
    } catch (error) {
      toastActions.show(error.message || 'Could not import the selected Fusion G-code');
    }
  }
  async function renameLibraryEntry(group) {
    const name = libraryRenameName.trim();
    if (!name) return toastActions.show('Enter a part name');
    try {
      const previousPath = group.key, nextPath = await renamePartLibraryGroup(previousPath, name);
      const affectedCuts = (sheet?.nesting_cuts || []).map(cut => ({ ...cut, nesting_placements: (cut.id === activeCutId ? placements : cut.nesting_placements || []).map(item => item.part_library_path === previousPath ? { ...item, part_library_path: nextPath, label: name } : item) }));
      await Promise.all(affectedCuts.filter(cut => cut.nesting_placements.some(item => item.part_library_path === nextPath)).map(cut => savePlacements(cut.id, cut.nesting_placements)));
      sheet = { ...sheet, nesting_cuts: affectedCuts };
      if (activeCutId) restoreHistory(activeCutId, affectedCuts.find(cut => cut.id === activeCutId)?.nesting_placements || []);
      libraryRenamePath = null; libraryRenameName = '';
      await Promise.all([loadLibrary(), openLibraryBrowser()]); draw(); toastActions.show(`Renamed to ${name}`);
    } catch (error) { toastActions.show(error.message); }
  }
  function runCommand(command) {
    showCommands = false;
    if (command === 'add-cut') return addCut();
    if (command === 'duplicate') return duplicateSelected();
    if (command === 'emit') return openEmitDialog();
    if (command === 'fit') return fitView();
    if (command === 'visibility') { showInactiveCuts = !showInactiveCuts; return draw(); }
    if (command === 'library') return openLibraryBrowser();
  }
  async function readPartGroup(group) {
    const variants = await Promise.all(group.files.map(async file => parseGcodeDocument(convertGcodeToInches(await downloadText(file.path)).gcode, file.name)));
    const primary = variants[0], bounds = variants.reduce((largest, item) => item.bounds.width * item.bounds.height > largest.width * largest.height ? item.bounds : largest, primary.bounds);
    return { variants, bounds };
  }
  async function loadPlacedPrograms(items = renderedPlacements) {
    const missingPrograms = new Map();
    for (const item of items) {
      if (item.kind === 'part' && item.part_library_path && !gcodePrograms[item.part_library_path]) missingPrograms.set(item.part_library_path, item);
    }
    await Promise.all([...missingPrograms.values()].map(async item => {
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
      toastActions.show(`Click the sheet to place ${group.label}. Press Esc when finished.`);
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
    const canvasPlacements = currentRenderedPlacements();
    const canvasSelection = placements.find((item) => item.id === selectedId) || null;
    const rect = canvas.getBoundingClientRect(); canvas.width = rect.width * devicePixelRatio; canvas.height = rect.height * devicePixelRatio;
    ctx = canvas.getContext('2d'); ctx.scale(devicePixelRatio, devicePixelRatio); ctx.clearRect(0, 0, rect.width, rect.height);
    const a = sheetToScreen({ x: 0, y: 0 }, view), b = sheetToScreen({ x: Number(sheet.width_in), y: Number(sheet.height_in) }, view);
    ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 2; ctx.strokeRect(a.x, b.y, b.x - a.x, a.y - b.y);
    for (const p of canvasPlacements) {
      const s = sheetToScreen(p, view); ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(-p.rotation);
      const preview = gcodePrograms[p.part_library_path]?.variants?.[0];
      const cutColor = CUT_COLORS[p.renderCutIndex % CUT_COLORS.length];
      const placementColor = p.renderActive && invalidPlacementIds.has(p.id) ? '#ef4444' : p.renderActive && p.id === selectedId ? '#f8fafc' : cutColor;
      if (preview?.toolpath?.length) {
        ctx.scale(view.scale, -view.scale); ctx.strokeStyle = placementColor; ctx.lineWidth = (p.renderActive ? 2.25 : 1.25) / view.scale;
        for (const segment of preview.toolpath) {
          ctx.globalAlpha = segment.rapid ? .18 : 1; ctx.beginPath();
          segment.points.forEach((point, index) => { const x = point.x - preview.bounds.centerX, y = point.y - preview.bounds.centerY; if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = placementColor; ctx.globalAlpha = p.renderActive ? .94 : .5;
        if (p.kind === 'hole') { ctx.beginPath(); ctx.arc(0, 0, Math.max(4, p.width_in * view.scale / 2), 0, Math.PI * 2); ctx.fill(); }
        else ctx.fillRect(-p.width_in * view.scale / 2, -p.height_in * view.scale / 2, p.width_in * view.scale, p.height_in * view.scale);
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }
    if (canvasSelection?.kind === 'part') {
      const { center, handle, radius } = rotationHandlePoint(canvasSelection);
      ctx.save();
      ctx.setLineDash([4, 5]); ctx.strokeStyle = '#fbbf24'; ctx.globalAlpha = .6; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(center.x, center.y, radius, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.strokeStyle = '#d97706'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(center.x, center.y); ctx.lineTo(handle.x, handle.y); ctx.stroke();
      ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(center.x, center.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#fbbf24'; ctx.stroke();
      ctx.fillStyle = '#fbbf24'; ctx.beginPath(); ctx.arc(handle.x, handle.y, 9, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#7c2d12'; ctx.lineWidth = 2; ctx.stroke();
      ctx.restore();
    }
    if (measure.length) {
      const points = measure.map(point => sheetToScreen(point, view)); ctx.strokeStyle = '#fbbf24'; ctx.fillStyle = '#fbbf24'; ctx.lineWidth = 2;
      for (const point of points) { ctx.beginPath(); ctx.arc(point.x, point.y, 4, 0, Math.PI * 2); ctx.fill(); }
      if (points.length === 2) { ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y); ctx.lineTo(points[1].x, points[1].y); ctx.stroke(); }
    }
  }
  function rotationHandlePoint(placement) {
    const preview = gcodePrograms[placement.part_library_path]?.variants?.[0];
    const cuttingPoints = preview?.toolpath?.filter(segment => !segment.rapid).flatMap(segment => segment.points) || [];
    let center = sheetToScreen(placement, view);
    if (cuttingPoints.length && preview?.bounds) {
      const minX = Math.min(...cuttingPoints.map(point => point.x)), maxX = Math.max(...cuttingPoints.map(point => point.x));
      const minY = Math.min(...cuttingPoints.map(point => point.y)), maxY = Math.max(...cuttingPoints.map(point => point.y));
      const offsetX = (minX + maxX) / 2 - preview.bounds.centerX, offsetY = (minY + maxY) / 2 - preview.bounds.centerY;
      const cos = Math.cos(placement.rotation || 0), sin = Math.sin(placement.rotation || 0);
      center = sheetToScreen({ x: placement.x + offsetX * cos - offsetY * sin, y: placement.y + offsetX * sin + offsetY * cos }, view);
    }
    const radius = Math.min(64, Math.max(30, placement.height_in * view.scale / 2 + 14));
    const angle = Number(placement.rotation) || 0;
    // Match the canvas' inverse rotation so the handle stays attached to the
    // same local direction as the geometry rotates.
    return {
      center,
      radius,
      handle: {
        x: center.x - Math.sin(angle) * radius,
        y: center.y - Math.cos(angle) * radius
      }
    };
  }
  function pointerDown(event) {
    if (!sheet) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const rect = canvas.getBoundingClientRect(), point = screenToSheet({ x: event.clientX - rect.left, y: event.clientY - rect.top }, view);
    if (measuring || event.shiftKey) { measure = measure.length === 1 ? [...measure, point] : [point]; if (measure.length === 2) measuring = false; draw(); return; }
    if (selected?.kind === 'part') {
      const { center, handle } = rotationHandlePoint(selected);
      if (Math.hypot(event.clientX - rect.left - handle.x, event.clientY - rect.top - handle.y) <= 14) {
        const dx = event.clientX - rect.left - center.x, dy = event.clientY - rect.top - center.y;
        rotationDrag = {
          id: selected.id,
          center,
          startRotation: selected.rotation,
          lastPointerAngle: -Math.atan2(dx, -dy),
          accumulatedAngle: 0
        };
        return;
      }
    }
    if (placing) {
      const candidate = makePlacement({ ...placing, x: point.x, y: point.y });
      if (candidate.kind === 'hole' && !placementHasEdgeClearance(sheet, candidate, HOLE_EDGE_CLEARANCE_IN)) return toastActions.show('Holes need clearance from every sheet edge');
      if (placementConflicts(candidate)) return toastActions.show('A hole cannot be placed inside cut geometry');
      commit([...placements, candidate]); selectedId = candidate.id; return;
    }
    const hit = [...placements].reverse().find(p => placementContains(p, point.x, point.y)); selectedId = hit?.id || null;
    if (hit?.kind === 'part') activePart = { kind: hit.kind, label: hit.label, part_library_path: hit.part_library_path, width_in: hit.width_in, height_in: hit.height_in };
    drag = hit ? { id: hit.id, start: point, placement: structuredClone(hit) } : { pan: true, start: { x: event.clientX, y: event.clientY }, view: { ...view } }; draw();
  }
  // Parts may overlap during manual layout and are marked red by validation.
  // Holes are the exception: drilling through cut geometry is unsafe.
  function placementConflicts(candidate, excludedId = null) {
    return candidate.kind === 'hole' && placements.some(item => item.id !== excludedId && item.kind === 'part' && placementsOverlap(candidate, item));
  }
  function pointerMove(event) {
    if (rotationDrag) {
      const rect = canvas.getBoundingClientRect(), dx = event.clientX - rect.left - rotationDrag.center.x, dy = event.clientY - rect.top - rotationDrag.center.y;
      if (Math.hypot(dx, dy) < 12) return;
      const pointerAngle = -Math.atan2(dx, -dy);
      const delta = Math.atan2(
        Math.sin(pointerAngle - rotationDrag.lastPointerAngle),
        Math.cos(pointerAngle - rotationDrag.lastPointerAngle)
      );
      rotationDrag.lastPointerAngle = pointerAngle;
      rotationDrag.accumulatedAngle += delta;
      const rotation = rotationDrag.startRotation + rotationDrag.accumulatedAngle * ROTATION_DRAG_SENSITIVITY;
      placements = placements.map(p => p.id === rotationDrag.id ? { ...p, rotation } : p); draw(); return;
    }
    if (!drag) return;
    if (drag.pan) { view = { ...view, originX: drag.view.originX + event.clientX - drag.start.x, originY: drag.view.originY + event.clientY - drag.start.y }; draw(); return; }
    const rect = canvas.getBoundingClientRect(), point = screenToSheet({ x: event.clientX - rect.left, y: event.clientY - rect.top }, view), dx = point.x - drag.start.x, dy = point.y - drag.start.y;
    placements = placements.map(p => p.id === drag.id ? { ...p, x: drag.placement.x + dx, y: drag.placement.y + dy } : p); draw();
  }
  function pointerUp(event) { if (event?.type === 'pointerleave') return; if (event?.currentTarget?.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); if (rotationDrag) { commit(placements); rotationDrag = null; draw(); return; } if (drag && !drag.pan) { const moved = placements.find(item => item.id === drag.id); if (moved && (placementConflicts(moved, moved.id) || (moved.kind === 'hole' && !placementHasEdgeClearance(sheet, moved, HOLE_EDGE_CLEARANCE_IN)))) { placements = placements.map(item => item.id === drag.id ? drag.placement : item); toastActions.show(moved.kind === 'hole' && placementConflicts(moved, moved.id) ? 'A hole cannot be placed inside cut geometry' : 'Holes need clearance from every sheet edge'); } else commit(placements); } drag = null; draw(); }
  function wheel(event) { event.preventDefault(); const r = canvas.getBoundingClientRect(); view = zoomAt(view, { x: event.clientX - r.left, y: event.clientY - r.top }, event.deltaY < 0 ? 1.06 : .94); draw(); }
  function placeHole() { placing = { kind: 'hole', label: 'Hole', width_in: HOLE_HEAD_SIZE_IN, height_in: HOLE_HEAD_SIZE_IN }; measure = []; toastActions.show('Uses the selected sheet thickness hole program'); }
  function rotateSelected(turns = 1) { if (selected?.kind === 'part') commit(placements.map(p => p.id === selected.id ? rotatePlacement(p, -turns) : p)); }
  function rotateSelectedSmoothly() {
    if (!selected?.kind || rotationAnimationFrame) return;
    const id = selected.id;
    let previousFrame = performance.now();
    const animate = (now) => {
      const elapsedSeconds = Math.min(.05, Math.max(0, now - previousFrame) / 1000);
      previousFrame = now;
      placements = placements.map(item => item.id === id ? { ...item, rotation: item.rotation - ROTATION_KEY_RADIANS_PER_SECOND * elapsedSeconds } : item);
      draw();
      if (rotationKeyHeld && selected?.id === id) rotationAnimationFrame = requestAnimationFrame(animate);
      else {
        rotationAnimationFrame = null;
        commit(placements);
      }
    };
    rotationAnimationFrame = requestAnimationFrame(animate);
  }
  function duplicateSelected() { if (!selected) return; const copy = makePlacement({ ...selected, id: undefined, x: selected.x + .5, y: selected.y + .5, label: `${selected.label} copy` }); commit([...placements, copy]); selectedId = copy.id; }
  async function removeSelected() {
    const placement = selected;
    if (!placement) return;
    if (placement.kind !== 'hole' && !await requestConfirmation({ title: 'Delete placement', message: `Remove ${placement.label}?`, confirmLabel: 'Remove', danger: true })) return;
    commit(placements.filter(p => p.id !== placement.id));
    await save({ quiet: true });
  }
  function inspectSelected() { const program = selected && gcodePrograms[selected.part_library_path]; if (!program) return toastActions.show('Reload the part library before inspecting this part'); selectedProgram = program; showProgram = true; }
  async function ensurePrograms(items = placements) {
    for (const placement of items.filter(item => item.kind === 'part' && !gcodePrograms[item.part_library_path])) {
      const group = partGroups.find(item => item.key === placement.part_library_path);
      if (!group) throw new Error(`Part library entry is missing for ${placement.label}`);
      gcodePrograms[placement.part_library_path] = await readPartGroup(group);
    }
  }
  async function buildEmissions() {
    if (emitValidation.length) throw new Error(`Fix ${emitValidation.length} validation issue${emitValidation.length === 1 ? '' : 's'} before emitting`);
    await ensurePrograms(emitPlacements);
    const suffixes = availableSuffixes.length ? availableSuffixes : [''];
    const targets = emitSuffix === 'all' ? suffixes : [emitSuffix || suffixes[0]];
    return targets.map(suffix => {
      const toolsForGroup = nestingEmissionTools({ placements: emitPlacements, programs: gcodePrograms, suffix, dialect, thickness: sheet.thickness_key });
      const orderedTools = emitToolOrder.filter(tool => toolsForGroup.includes(tool));
      return {
        ...emitNestingGcode({ name: emitName || sheet.name, placements: emitPlacements, programs: gcodePrograms, suffix, filenameSuffix: suffix || defaultGroupLabel, suffixCount: 2, dialect, thickness: sheet.thickness_key, toolOrder: orderedTools }),
        suffix
      };
    }).filter(result => result.emitted);
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
  async function closeEmitAfterCommit() {
    const scrim = document.querySelector('.scrim');
    scrim?.classList.add('emit-success-close');
    await new Promise(resolve => setTimeout(resolve, 190));
    showEmit = false;
  }
  async function commitGcode() {
    if (committingGcode) return;
    committingGcode = true;
    try {
      const results = await buildEmissions();
      if (!results.length) throw new Error('No placed item has a program for the selected suffix.');
      for (const result of results) {
        const path = await uploadEmittedGcode(result.filename, result.text);
        await publishJprogOutput(path, result.text);
        await recordEmission({ cut_id: emitCut?.id || activeCutId, suffix: result.suffix || '', dialect, output_storage_path: path, tool_order: result.toolOrder });
      }
      await closeEmitAfterCommit(); toastActions.show(`Committed ${results.length} G-code file${results.length === 1 ? '' : 's'} to output`);
    } catch (error) { toastActions.show(error.message); } finally { committingGcode = false; }
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
  <main class="workspace"><header class="workspace-header"><div class="jprog-identity"><h1>JProg</h1><button class="btn btn-secondary" on:click={() => { screen = 'select'; goto('/jprog'); }}><FolderOpen size={16}/> JProg Home</button></div><div class="header-sheet-name"><strong>{sheet?.name}</strong><span>{sheet?.width_in} x {sheet?.height_in} in · {sheet?.thickness_key} in</span></div><div class="header-actions"><span class:save-error={saveStatus === "error"} class="save-status">{saveStatus === "saving" ? "Saving..." : saveStatus === "unsaved" ? "Unsaved" : saveStatus === "error" ? "Save failed" : "Saved"}</span><button class="btn btn-secondary" on:click={fitView}><Crosshair size={16}/> Fit sheet</button><button class:active={measuring || measure.length} class="btn btn-secondary" on:click={() => { measuring = !measuring; if (measuring) measure = []; toastActions.show(measuring ? 'Click two points to measure' : 'Measurement cancelled'); }}><Ruler size={16}/> Measure</button><button class="btn btn-secondary" disabled={!undo.canUndo} on:click={undoChange}><Undo2 size={16}/> Undo</button><button class="btn btn-secondary" disabled={!undo.canRedo} on:click={redoChange}><Redo2 size={16}/> Redo</button><button class="btn btn-secondary" on:click={save}><Save size={16}/>{saving ? 'Saving' : 'Save'}</button><button class="btn btn-primary" on:click={openEmitDialog}><Download size={16}/> Emit G-code</button></div></header>
  <div class="workspace-body"><aside><section class="sheet-specs"><strong>{sheet?.name}</strong><span>{sheet?.width_in} x {sheet?.height_in} in · {sheet?.thickness_key} in thick</span></section><section><label for="active-cut">Active cut</label><select id="active-cut" value={activeCutId} on:change={(e) => chooseCut(e.currentTarget.value)}>{#each sheet?.nesting_cuts || [] as cut}<option value={cut.id}>{cut.name}</option>{/each}</select>{#if editingCutName}<div class="cut-rename"><input aria-label="Cut name" bind:value={cutName} on:keydown={(event) => { if (event.key === 'Enter') saveCutName(); if (event.key === 'Escape') editingCutName = false; }}/><button class="icon-button" title="Save cut name" on:click={saveCutName}><Save size={15}/></button><button class="icon-button" title="Cancel rename" on:click={() => editingCutName = false}><X size={15}/></button></div>{/if}<div class="cut-actions"><button type="button" class="btn btn-secondary add-cut-button" on:click={addCut}><Plus size={15}/> Add cut</button><button type="button" class="icon-button" title="Rename cut" on:click={beginRenameCut}><Pencil size={15}/></button><button type="button" class="icon-button danger" title="Delete cut" disabled={deletingCut || (sheet?.nesting_cuts?.length || 0) <= 1} on:click={removeActiveCut}><Trash2 size={15}/></button></div></section><section class="workflow-panel"><div class="section-heading"><h2>Cut workflow</h2><span class:ready={activeValidation.length === 0} class="validation-status">{activeValidation.length ? activeValidation.length + " issue" + (activeValidation.length === 1 ? "" : "s") : "Ready"}</span></div><div class="workflow-stats"><span>{placements.filter(item => item.kind === "part").length} parts</span><span>{placements.filter(item => item.kind === "hole").length} holes</span><span>{programType.toUpperCase()}</span></div>{#if activeValidation.length}<ul class="validation-list">{#each activeValidation.slice(0, 4) as issue}<li>{issue.message}</li>{/each}{#if activeValidation.length > 4}<li>+ {activeValidation.length - 4} more</li>{/if}</ul>{:else}<p class="hint">This cut is ready to emit.</p>{/if}</section><section><h2>Place</h2><label class="btn btn-secondary upload"><Upload size={16}/> Upload to Parts Library<input type="file" accept=".ngc,.tap" multiple on:change={uploadParts}/></label><div class="row placement-actions"><button type="button" class="btn btn-secondary" on:click={openLibraryBrowser}><FolderOpen size={16}/> Library</button><button type="button" class="btn btn-secondary autocam-jobs-button" on:click={openCamJobs}><Cpu size={16}/> Upload AutoCAM</button><button type="button" class="btn btn-secondary" on:click={openSheetFiles}><FolderOpen size={16}/> Files</button><button class="btn btn-secondary placement-reload" on:click={loadLibrary}><RefreshCw size={16}/> Reload</button></div>{#if showLibrary}<div class="library-panel"><div class="section-heading"><span>Recent parts</span><span class="hint">{partGroups.length}</span></div><div class="library">{#each recentPartGroups as group}<button title={`Place ${group.label}`} on:click={() => armStoredPart(group)}>{group.label}<span>{group.files.length}</span></button>{:else}<span class="hint">No part programs on this sheet yet.</span>{/each}</div></div>{/if}<button class:active={placing?.kind === 'hole'} class="btn btn-secondary" on:click={placeHole}><Crosshair size={16}/> Add hole</button>{#if placing}<p class="hint">Click the sheet to place {placing.label}. Keep clicking to add copies, then press Esc to finish.</p>{/if}</section>{#if selected}<section><h2>Selection</h2><strong>{selected.label}</strong><div class="coordinate-grid"><label>X<input type="number" step="0.001" value={selected.x} on:change={(e) => commit(placements.map(item => item.id === selected.id ? { ...item, x: Number(e.currentTarget.value) } : item))}/></label><label>Y<input type="number" step="0.001" value={selected.y} on:change={(e) => commit(placements.map(item => item.id === selected.id ? { ...item, y: Number(e.currentTarget.value) } : item))}/></label></div><div class="selection-actions"><button class="btn btn-secondary" on:click={() => rotateSelected(-1)}><RotateCcw size={16}/> Rotate left</button><button class="btn btn-secondary" on:click={() => rotateSelected(1)}><RotateCw size={16}/> Rotate right</button><button class="btn btn-secondary" on:click={duplicateSelected}><Copy size={16}/> Duplicate</button>{#if selected.kind === 'part'}<button class="btn btn-secondary" on:click={inspectSelected}><FileCode size={16}/> Inspect G-code</button>{/if}<button class="btn btn-secondary danger" on:click={removeSelected}><Trash2 size={16}/> Delete</button></div></section>{/if}<section><h2>Measurement</h2>{#if measure.length === 2}<strong>{Math.hypot(measure[1].x - measure[0].x, measure[1].y - measure[0].y).toFixed(3)} in</strong><button class="text-button" on:click={() => { measure = []; draw(); }}>Clear measurement</button>{:else}<p class="hint">Select the ruler, then click two points.</p>{/if}</section></aside>
  <section class="canvas-wrap"><canvas bind:this={canvas} on:pointerdown={pointerDown} on:pointermove={pointerMove} on:pointerup={pointerUp} on:pointerleave={pointerUp} on:wheel={wheel}></canvas><div class="canvas-status"><MousePointer2 size={15}/> Click to place selected G-code · Esc to finish · Drag to move/pan · Wheel to zoom · R to rotate · Delete to remove</div></section></div></main>
{/if}
{#if showNewSheet}<div class="scrim"><form class="modal" on:submit|preventDefault={createNewSheet}><button type="button" class="modal-close" title="Close" on:click={() => showNewSheet = false}><X size={18}/></button><h2>New Sheet</h2><label>Name<input bind:value={newSheet.name} /></label><div class="two"><label>Width (in)<input type="number" min="1" bind:value={newSheet.width}/></label><label>Height (in)<input type="number" min="1" bind:value={newSheet.height}/></label></div><label>Thickness<select bind:value={newSheet.thickness}><option value="0.063">1/16 in</option><option value="0.09">0.090 in</option><option value="0.125">1/8 in</option><option value="0.1875">3/16 in</option><option value="0.25">1/4 in</option><option value="0.3125">5/16 in</option><option value="0.375">3/8 in</option><option value="0.5">1/2 in</option><option value="0.75">3/4 in</option></select></label><div class="row"><button type="button" class="btn btn-secondary" on:click={() => showNewSheet = false}>Cancel</button><button class="btn btn-primary">Create sheet</button></div></form></div>{/if}
{#if showCommands}<div class="scrim" role="presentation" on:click|self={() => showCommands = false}><div class="modal command-palette" role="dialog" tabindex="-1" aria-label="JProg commands"><button type="button" class="modal-close" title="Close" on:click={() => showCommands = false}><X size={18}/></button><h2>Commands</h2><button type="button" class="command-item" on:click={() => runCommand('add-cut')}><span>Add cut</span><kbd>+</kbd></button><button type="button" class="command-item" disabled={!selected} on:click={() => runCommand('duplicate')}><span>Duplicate selection</span><kbd>D</kbd></button><button type="button" class="command-item" on:click={() => runCommand('emit')}><span>Emit G-code</span><kbd>E</kbd></button><button type="button" class="command-item" on:click={() => runCommand('fit')}><span>Fit sheet</span><kbd>F</kbd></button><button type="button" class="command-item" on:click={() => runCommand('visibility')}><span>{showInactiveCuts ? 'Hide other cuts' : 'Show other cuts'}</span><kbd>V</kbd></button><button type="button" class="command-item" on:click={() => runCommand('library')}><span>Browse library</span><kbd>L</kbd></button></div></div>{/if}
{#if showLibraryModal}<div class="scrim" role="presentation" on:click|self={() => showLibraryModal = false}><div class="modal library-browser" role="dialog" tabindex="-1" aria-label="Part library"><button type="button" class="modal-close" title="Close" on:click={() => showLibraryModal = false}><X size={18}/></button><header><div><h2>{libraryTitle}</h2><p class="hint">{librarySubtitle}</p></div><button type="button" class="btn btn-secondary" on:click={() => libraryScope === "sheet" ? openSheetFiles() : openLibraryBrowser()}><RefreshCw size={16}/> Reload</button></header><div class="library-filters"><label>Search<input bind:value={librarySearch} placeholder="Search parts"/></label><label>From<input type="date" bind:value={libraryDateFrom}/></label><label>To<input type="date" bind:value={libraryDateTo}/></label></div><div class="library-browser-list">{#if loadingLibraryModal}<div class="library-loading" aria-live="polite"><span class="loading-spinner" aria-hidden="true"></span><span>Loading library...</span></div>{:else}{#each visibleAllPartGroups as group}<article class="library-browser-item">{#if libraryRenamePath === group.key}<div class="rename-library"><input aria-label="Part name" bind:value={libraryRenameName} on:keydown={(event) => { if (event.key === 'Enter') renameLibraryEntry(group); if (event.key === 'Escape') libraryRenamePath = null; }}/><button type="button" class="icon-button" title="Save name" on:click={() => renameLibraryEntry(group)}><Save size={15}/></button><button type="button" class="icon-button" title="Cancel rename" on:click={() => libraryRenamePath = null}><X size={15}/></button></div>{:else}<button type="button" class="library-open" on:click={() => { armStoredPart(group); showLibraryModal = false; }}><strong>{group.label}</strong><span>{group.files.length} file{group.files.length === 1 ? '' : 's'} · {group.programType?.toUpperCase() || 'mixed'} · Added {group.updatedAt ? new Date(group.updatedAt).toLocaleString() : 'unknown date'}</span></button><button type="button" class="icon-button" title={`Rename ${group.label}`} on:click={() => { libraryRenamePath = group.key; libraryRenameName = group.label; }}><Pencil size={15}/></button>{/if}</article>{:else}<p class="hint">No programs match these filters.</p>{/each}{/if}</div></div></div>{/if}
{#if showCamJobs}<div class="scrim" role="presentation" on:click|self={() => (showCamJobs = false)}><div class="modal cam-jobs-modal" role="dialog" tabindex="-1" aria-label="AutoCAM jobs"><button type="button" class="modal-close" title="Close" on:click={() => (showCamJobs = false)}><X size={18}/></button><h2>AutoCAM jobs</h2><div class="cam-job-filters"><label>Search<input aria-label="Search CAM jobs" placeholder="Search files" bind:value={camJobSearch}/></label><label>From<input type="date" bind:value={camJobDateFrom}/></label><label>To<input type="date" bind:value={camJobDateTo}/></label></div>{#if loadingCamJobs}<div class="library-loading" aria-live="polite"><span class="loading-spinner" aria-hidden="true"></span><span>Loading CAM jobs...</span></div>{:else if !visibleCamJobs.length}<p class="hint">No completed CAM jobs with G-code are available.</p>{:else}<div class="cam-job-list">{#each visibleCamJobs as job}<button type="button" class="cam-job-item" on:click={() => insertCamJob(job)}><strong>{job.name || job.gcode_file_name || "Untitled job"}</strong><span>{job.operation_type || "CAM"} · {job.created_at ? new Date(job.created_at).toLocaleString() : "unknown date"}</span></button>{/each}</div>{/if}</div></div>{/if}
{#if showEmit}
  <div class="scrim">
    <form class="modal" on:submit|preventDefault={commitGcode}>
      <button type="button" class="modal-close" title="Close" on:click={() => showEmit = false}><X size={18}/></button>
      <h2>Emit G-code</h2>
      <label>Cut<select bind:value={emitCutId} on:change={() => { emitSuffix = 'all'; void ensurePrograms(emitPlacements).then(() => gcodePrograms = { ...gcodePrograms }); }}>{#each sheet?.nesting_cuts || [] as cut}<option value={cut.id}>{cut.name}</option>{/each}</select></label>
      <label>Program name<input bind:value={emitName}/></label>
      <p class="hint">{programType === 'tap' ? 'WinCNC (.tap)' : '971 / LinuxCNC (.ngc)'}</p>
      {#if emitValidation.length}<div class="emit-validation"><AlertTriangle size={16}/><span>Fix {emitValidation.length} validation issue{emitValidation.length === 1 ? '' : 's'} before emitting.</span></div>{/if}
      <fieldset><legend>Program group</legend><label class="radio"><input type="radio" bind:group={emitSuffix} value="all"/> All available groups</label>{#each availableSuffixes as suffix}<label class="radio"><input type="radio" bind:group={emitSuffix} value={suffix}/> {suffix || defaultGroupLabel}</label>{/each}{#if !availableSuffixes.length}<p class="hint">Add a part or hole before emitting.</p>{/if}</fieldset>
      {#if dialect === 'wincnc' && (emitToolOrderDisplay.length > 1 || emitHolesInScope)}
        <fieldset class="tool-order"><legend>Tool order</legend><p class="hint">WinCNC will complete every part with each tool in this order.</p>{#if emitHolesInScope}<div class="tool-order-row tool-order-row-fixed"><strong>T1</strong><span>Holes / Unchangeable</span></div>{/if}{#each emitToolOrderDisplay as tool, index}<div class="tool-order-row"><strong>T{tool}</strong><span>{index + 1} of {emitToolOrderDisplay.length}</span><div><button type="button" class="icon-button" title={`Move T${tool} earlier`} aria-label={`Move T${tool} earlier`} disabled={index === 0} on:click={() => moveEmitTool(tool, -1)}><ArrowUp size={15}/></button><button type="button" class="icon-button" title={`Move T${tool} later`} aria-label={`Move T${tool} later`} disabled={index === emitToolOrderDisplay.length - 1} on:click={() => moveEmitTool(tool, 1)}><ArrowDown size={15}/></button></div></div>{/each}</fieldset>
      {/if}
      <div class="row emit-actions"><button type="button" class="btn btn-secondary" on:click={() => showEmit = false}>Cancel</button><button type="button" class="btn btn-secondary" on:click={downloadGcode} disabled={!emitPlacements.length || !availableSuffixes.length || emitValidation.length}><Download size={16}/> Download</button><button class="btn btn-primary" disabled={!emitPlacements.length || !availableSuffixes.length || emitValidation.length}><Upload size={16}/> Commit to Output</button></div>
    </form>
  </div>
{/if}
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
  .workspace-header .header-sheet-name { justify-self: start; text-align: left; padding-top: 9px; }
  .workspace { position: relative; left: 0; width: auto; }
  .workspace-body { margin-left: 0; width: auto; }
  .workspace-output-link { position: fixed; right: 16px; bottom: 16px; z-index: 3; }
  @media (max-width: 900px) { .workspace-header .header-actions { flex-wrap: wrap; } }
  @media (max-width: 720px) { .workspace-body { margin-left: 0; width: auto; } }
  .icon-button { width: 2rem; height: 2rem; padding: 0; border: 1px solid var(--border-color, #d0d5dd); border-radius: 4px; background: var(--card-bg, #fff); display: inline-flex; align-items: center; justify-content: center; }
  .icon-button:disabled { opacity: .45; cursor: not-allowed; }
  .modal label:has(> select) { position: relative; }
  .modal label:has(> select)::after { content: ''; position: absolute; right: 15px; bottom: 15px; width: 8px; height: 8px; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; transform: rotate(45deg); pointer-events: none; }
  .modal select { width: 100%; min-width: 0; box-sizing: border-box; height: 44px; padding: 8px 3rem 8px 12px; line-height: 1.4; white-space: nowrap; text-overflow: clip; appearance: none; -webkit-appearance: none; }
  .library-panel { display: grid; gap: 6px; min-height: 0; }
  .library-search { width: 100%; min-width: 0; box-sizing: border-box; }
  .library { height: min(220px, 30vh); max-height: min(220px, 30vh); overflow-y: auto; overscroll-behavior: contain; align-content: start; }
  .library button { min-height: 40px; white-space: normal; overflow-wrap: anywhere; line-height: 1.25; align-items: center; }
  /* The part library is the primary placement surface, so keep it visible. */
  aside section:nth-child(3) .row button:first-child { outline: 2px solid var(--primary, #2563eb); outline-offset: -2px; }
  .emit-success-close { pointer-events: none; animation: emit-scrim-out 190ms ease forwards; }
  .emit-success-close .modal { animation: emit-modal-out 190ms cubic-bezier(.4,0,.2,1) forwards; }
  .emit-actions { justify-content: flex-end; }
  .emit-actions > :first-child { margin-right: auto; }
  @keyframes emit-scrim-out { to { opacity: 0; } }
  @keyframes emit-modal-out { to { opacity: 0; transform: translateY(-12px) scale(.96); } }
  .save-status { color: var(--muted-text, #667085); font-size: .78rem; white-space: nowrap; }
  .save-status.save-error { color: #b42318; }
  .section-heading, .workflow-stats { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .workflow-stats { justify-content: flex-start; flex-wrap: wrap; color: var(--muted-text, #667085); font-size: .78rem; }
  .workflow-stats span { padding: 3px 6px; border: 1px solid var(--border-color, #d0d5dd); border-radius: 999px; }
  .validation-status { color: #b42318; font-size: .78rem; font-weight: 600; }
  .validation-status.ready { color: #067647; }
  .validation-list { margin: 0; padding-left: 18px; color: #b42318; font-size: .8rem; display: grid; gap: 3px; }
  .library-browser { width: min(860px, calc(100vw - 32px)); min-height: min(620px, calc(100vh - 64px)); }
  .library-browser > header { display: flex; justify-content: space-between; align-items: start; gap: 16px; padding-right: 34px; }
  .library-browser > header p { margin: 4px 0 0; }
  .library-filters { display: grid; grid-template-columns: minmax(0, 1fr) 145px 145px; gap: 10px; }
  .library-browser-list { display: grid; gap: 7px; overflow: auto; align-content: start; min-height: 0; max-height: 440px; padding-right: 2px; }
  .library-browser-item { display: flex; gap: 8px; border: 1px solid var(--border-color, #d0d5dd); border-radius: 5px; padding: 8px; }
  .library-open { appearance: none; border: 0; background: transparent; color: inherit; text-align: left; min-width: 0; flex: 1; display: grid; gap: 3px; padding: 3px; }
  .library-open:hover strong { color: var(--primary, #2563eb); }
  .library-open span { color: var(--muted-text, #667085); font-size: .8rem; overflow-wrap: anywhere; }
  .rename-library { display: flex; gap: 8px; width: 100%; }
  .rename-library input { flex: 1; min-width: 0; }
  .command-palette { width: min(430px, calc(100vw - 32px)); }
  .command-item { display: flex; justify-content: space-between; align-items: center; width: 100%; padding: 10px; border: 1px solid var(--border-color, #d0d5dd); border-radius: 4px; background: var(--card-bg, #fff); text-align: left; color: inherit; }
  .command-item:hover:not(:disabled) { border-color: var(--primary, #2563eb); background: var(--primary-soft, #eff6ff); }
  .command-item:disabled { opacity: .45; }
  kbd { border: 1px solid var(--border-color, #d0d5dd); border-bottom-width: 2px; border-radius: 3px; color: var(--muted-text, #667085); padding: 1px 5px; font-size: .72rem; }
  .emit-validation { display: flex; align-items: center; gap: 7px; color: #b42318; font-size: .85rem; }
  .tool-order { display: grid; gap: 7px; }
  .tool-order .hint { margin: 0; font-size: .8rem; }
  .tool-order-row { display: grid; grid-template-columns: minmax(3rem, 1fr) minmax(4rem, auto) auto; align-items: center; gap: 8px; padding: 7px 8px; border: 1px solid var(--border-color, #d0d5dd); border-radius: 4px; }
  .tool-order-row span { color: var(--muted-text, #667085); font-size: .78rem; }
  .tool-order-row > div { display: flex; gap: 4px; }
  .tool-order-row-fixed { grid-template-columns: minmax(3rem, 1fr) auto; background: var(--surface-secondary, #f2f4f7); cursor: default; }
  .tool-order-row-fixed span { font-style: italic; }
  .workspace-body aside .placement-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .workspace-body aside .placement-actions .btn { min-width: 0; width: 100%; min-height: 38px; padding-inline: 8px; white-space: nowrap; font-size: .82rem; justify-content: center; }
  .workspace-body aside .placement-actions .btn svg { flex: 0 0 auto; }
  .cam-jobs-modal { width: min(620px, calc(100vw - 32px)); }
  .cam-job-filters { display: grid; grid-template-columns: minmax(0, 1fr) 145px 145px; gap: 8px; }
  .cam-job-filters input { width: 100%; min-width: 0; box-sizing: border-box; }
  .cam-job-list { display: grid; gap: 7px; max-height: 55vh; overflow: auto; }
  .cam-job-item { display: grid; gap: 3px; padding: 10px; border: 1px solid var(--border-color, #d0d5dd); background: var(--card-bg, #fff); text-align: left; color: inherit; }
  .cam-job-item:hover, .cam-job-item:focus-visible { border-color: var(--primary, #2563eb); background: var(--primary-soft, #eff6ff); outline: none; }
  .cam-job-item span { color: var(--muted-text, #667085); font-size: .8rem; }
  .library-loading { min-height: 180px; display: grid; place-items: center; align-content: center; gap: 10px; color: var(--muted-text, #667085); }
  .loading-spinner { width: 24px; height: 24px; border: 3px solid var(--border-color, #d0d5dd); border-top-color: var(--primary, #2563eb); border-radius: 50%; animation: library-spin .75s linear infinite; }
  @keyframes library-spin { to { transform: rotate(360deg); } }
  @media (max-width: 640px) { .library-filters { grid-template-columns: 1fr; } .save-status { display: none; } }
</style>
