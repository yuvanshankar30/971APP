<script>
  import { requestConfirmation } from '$lib/confirmation.js';
  import { onMount, tick } from 'svelte';
  import { toastActions } from '$lib/toast.js';
  import { supabase } from '$lib/supabase.js';
  import {
    fetchParts, createPart, deletePart, deleteParts, renamePart, updatePartStepFile, updatePartQuantity, fetchPartCategories, installFusionPartCad,
    fetchPlates, createPlate, queueFusionPlateJob, fetchFusionFolderTree, fetchCompletedFusionStockIds
  } from '$lib/fusionCam.js';
  import { PACIFIC_TIME_ZONE, formatPacificDateTime } from '$lib/timezone.js';
  import { fetchStepMeshes, readStepMeshes } from '$lib/stepMeshLoader.js';
  import stockData from '$lib/stock.json';
  import { buildStockMaterialIndex, materialIdForStockAssignment, stockCatalogIdForStockAssignment } from '$autocam/stockMaterial.js';
  import { extractRoutingContoursFromMeshes } from '$autocam/stepProfile.js';
  import CadViewer from '$lib/components/CadViewer.svelte';
  import FolderTreeNode from './FolderTreeNode.svelte';
  import SeasonFilter from '$lib/components/SeasonFilter.svelte';
  import { getAllSeasonBuckets, passesSeasonFilter } from '$lib/frcSeason.js';
  import { searchFolderTree } from '$lib/fusionFolderSearch.js';
  import { Plus, Trash2, Package, Pencil, Check, X, Sparkles, Box, Download, Send, Folder, Wrench, FilterX, Upload, Filter, Link as LinkIcon } from 'lucide-svelte';
  import AtcSlotConfig from '$autocam/components/AtcSlotConfig.svelte';

  export let user;
  export let canManage;
  // Deep link from Manufacturing's "Open Fusion CAM" button (see
  // /autocam/fusion/+page.svelte) - the id of a public.parts row to
  // pre-fill the Add Part form from: name, STEP file (carried over, not
  // re-uploaded), and a depth estimate read straight off that STEP file's
  // geometry. Material/thickness is deliberately left for the user to pick
  // and cross-check against the detected depth - see handlePrefill below.
  export let initialManufacturingPartId = null;
  const manufacturingStockMaterialIndex = buildStockMaterialIndex(stockData);

  // Parts and Plates used to be two separate tabs, then briefly a single
  // tab with Plates still a manually-managed entity inside it. Direct
  // instruction: "why do we even need a plate workflow? ... the dimensions
  // of the plate, and the material - the material is already covered by
  // the part creation ... you should just be able to add parts, group them
  // or use them singularly and put them into Fusion. no need for plates -
  // this is just redundant." A plate is still a real row in fusion_plates
  // under the hood - the Fusion Runner's nesting/toolpath code needs SOME
  // stock-sheet size to nest parts onto - but it is never shown, named, or
  // sized by a human anymore. Each stock category gets exactly one
  // auto-sized plate (see resolveCategoryPlateId), created on first use the
  // same way the placeholder-stock migration seeded one for every existing
  // category. Queueing a CAM job for a category's parts silently commits
  // them onto that category's one plate right before queueing.
  let parts = [];
  let plates = [];
  let categories = [];
  // fusion_parts.id set captured by a completed CAM output job's immutable
  // queue snapshot - see fetchCompletedFusionStockIds.
  let completedPartIds = new Set();
  $: stockGroups = buildStockGroups(parts, plates, categories);
  $: partsByCreatedAt = [...parts].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  // Free-text search over the main parts list (separate from the queue
  // picker's own "Recent parts" search above) - matches name, the linked
  // manufacturing project id, and stock category label, since those are
  // the fields shown on each card and the ones a user would actually
  // search by.
  $: partsListSearchTerm = partsListSearch.trim().toLowerCase();
  // Dedicated Project/Season filters, same catalog-browsing convention
  // /manufacture's own filter bar already uses (see getAllSeasonBuckets/
  // passesSeasonFilter in $lib/frcSeason.js) - defaults to "show
  // everything" rather than /manufacture's own "current season" default,
  // since this list is a short-lived working catalog, not a season-long
  // request backlog, and silently hiding an older-but-still-active part
  // behind a season filter someone forgot they'd set would be a real
  // regression from today's "no filtering at all" behavior.
  let filterProject = '';
  let filterSeason = '';
  $: projectIds = Array.from(new Set(parts.map((part) => part.project_id).filter(Boolean))).sort();
  $: seasonOptions = getAllSeasonBuckets(parts);
  $: filteredPartsByCreatedAt = partsByCreatedAt.filter((part) =>
    (!partsListSearchTerm
      || part.name?.toLowerCase().includes(partsListSearchTerm)
      || part.project_id?.toLowerCase().includes(partsListSearchTerm)
      || categoryLabel(part.fusion_part_categories).toLowerCase().includes(partsListSearchTerm))
    && (!filterProject || part.project_id === filterProject)
    && passesSeasonFilter(part.created_at, filterSeason)
  );

  // Bulk-select-and-delete for the parts list - a plain Set of part ids,
  // separate from any single-row action so selecting for bulk delete never
  // interferes with rename/quantity-edit/queue state on the same card.
  let selectedPartIds = new Set();
  let bulkDeletingParts = false;
  // Read-only derivation, not a pruning reassignment - a part filtered out
  // of view by search stays selected (so switching the search term back
  // doesn't silently lose the selection), this just keeps the "select
  // all" checkbox's own indicator honest about what's visible right now.
  $: visibleSelectedCount = filteredPartsByCreatedAt.filter((p) => selectedPartIds.has(p.id)).length;
  function togglePartSelected(partId) {
    const next = new Set(selectedPartIds);
    if (next.has(partId)) next.delete(partId); else next.add(partId);
    selectedPartIds = next;
  }
  function toggleSelectAllParts() {
    if (visibleSelectedCount === filteredPartsByCreatedAt.length && filteredPartsByCreatedAt.length > 0) {
      const visibleIds = new Set(filteredPartsByCreatedAt.map((p) => p.id));
      selectedPartIds = new Set([...selectedPartIds].filter((id) => !visibleIds.has(id)));
    } else {
      selectedPartIds = new Set([...selectedPartIds, ...filteredPartsByCreatedAt.map((p) => p.id)]);
    }
  }
  async function handleBulkDeleteParts() {
    const ids = [...selectedPartIds];
    if (!ids.length) return;
    if (!await requestConfirmation({
      title: 'Delete parts',
      message: `Delete ${ids.length} selected part${ids.length === 1 ? '' : 's'}? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true
    })) return;
    bulkDeletingParts = true;
    try {
      const removed = await deleteParts(ids);
      const removedSet = new Set(ids);
      parts = parts.filter((p) => !removedSet.has(p.id));
      selectedPartIds = new Set();
      toastActions.show(`Deleted ${removed} part${removed === 1 ? '' : 's'}`);
    } catch (e) {
      toastActions.show(e.message || 'Failed to delete selected parts');
    } finally {
      bulkDeletingParts = false;
    }
  }

  // Once a stock category is chosen (picked directly, or implied by a
  // just-selected recent part), narrow "Recent parts" to that category
  // instead of mixing every category together - a category already in
  // focus means recent parts from OTHER categories aren't useful here.
  $: queueableByCreatedAt = partsByCreatedAt
    .filter((part) => Number(part.original_quantity) > 0)
    .filter((part) => !queuePickerCategoryId || String(part.category_id) === String(queuePickerCategoryId));
  $: recentPartsSearchTerm = recentPartsSearch.trim().toLowerCase();
  $: recentQueueableParts = recentPartsSearchTerm
    ? queueableByCreatedAt.filter((part) => part.name?.toLowerCase().includes(recentPartsSearchTerm))
    : queueableByCreatedAt.slice(0, 6);
  $: groupedPartsSearchTerm = groupedPartsSearch.trim().toLowerCase();
  $: selectedQueuePickerCategory = queuePickerCategoryId
    ? stockGroups.find((g) => g.categoryId === queuePickerCategoryId)?.category
    : null;
  // Which "Recent parts" cards are part of the pending job, so a click
  // actually shows something happened - previously nothing on the card
  // itself changed, so it read as a button that did nothing. Derived from
  // the same selection state the form below binds to (a single Set covers
  // grouped mode's several simultaneously-selected parts the same way
  // single mode's one is covered) so it can never drift from what's
  // actually selected.
  $: selectedRecentPartIds = (() => {
    if (!queuePickerCategoryId) return new Set();
    if (categoryQueueModes[queuePickerCategoryId] === 'grouped') {
      return new Set((categoryGroupedPartSelections[queuePickerCategoryId] || []).map(String));
    }
    const single = categorySinglePartSelections[queuePickerCategoryId];
    return single ? new Set([String(single)]) : new Set();
  })();

  function buildStockGroups(currentParts, currentPlates, currentCategories) {
    const knownCategories = new Map(currentCategories.map((category) => [String(category.id), category]));
    const groups = new Map();
    function groupFor(key, category) {
      if (!groups.has(key)) groups.set(key, { key, categoryId: category ? String(category.id) : null, category: category || null, parts: [], plates: [] });
      return groups.get(key);
    }
    for (const part of currentParts) {
      const categoryId = part.category_id == null ? null : String(part.category_id);
      const category = knownCategories.get(categoryId);
      const group = groupFor(category ? `category:${categoryId}` : `unresolved-part:${part.id}`, category);
      group.parts.push(part);
    }
    for (const plate of currentPlates) {
      const categoryId = plate.category_id == null ? null : String(plate.category_id);
      const category = knownCategories.get(categoryId);
      // A plate's category should always resolve via its foreign key; kept
      // as its own bucket rather than silently dropped in the rare case a
      // category was removed out from under an existing plate.
      const group = groupFor(category ? `category:${categoryId}` : `unresolved-plate:${plate.id}`, category);
      group.plates.push(plate);
    }
    return [...groups.values()];
  }

  // Real manufacturing requests this Fusion part can optionally be linked
  // to - see the migration that added fusion_parts.part_id. Kept separate
  // from Fusion's own catalog (fusion_parts) on purpose: /autocam/fusion
  // stays its own section for now, this is just the connecting reference.
  let manufacturingParts = [];
  let machines = [];
  // machine_id -> cam_tools rows actually installed on that machine
  // (cam_machine_tools) - "job creation only offers the tools installed on
  // its machine" is this app's own existing convention (see the main
  // /autocam page's tool picker), not a new rule invented here.
  let machineTools = {};
  let atcTools = []; // full cam_tools catalog, for the ATC Slots modal
  let loading = true;

  // Search box above the main parts list itself, not the queue picker's.
  let partsListSearch = '';

  let showAddPartForm = false;
  // True when the New Part form was opened from the page-level "Quick
  // Queue" button (see openQuickQueue below) rather than the normal "Add
  // Part" button - on save, chains straight into the queue picker with
  // this part pre-selected instead of just closing the form, so adding a
  // brand new part and sending it to Fusion CAM is one flow instead of two.
  let quickQueueMode = false;
  let newPart = { name: '', quantity: 1, categoryId: '', manufacturingPartId: '', fusionFileName: '', projectId: '', stockAssignment: '' };
  let stepFile = null;
  let submitting = false;
  let renamingPartId = null;
  let renamePartValue = '';
  let editingQuantityId = null;
  let quantityValue = '';

  // Queueing state, keyed by categoryId - not by any plate id, since a
  // human never picks or sees a specific plate anymore. One router/tool/
  // mode/selection per stock category.
  let categoryMachineSelections = {};
  let categoryToolSelections = {};
  let categorySingleToolModes = {};
  let categoryQueueModes = {};
  let categorySinglePartSelections = {};
  let categorySinglePartQuantities = {};
  let categoryGroupedPartSelections = {};
  let categoryGroupedPartQuantities = {};
  let queueing = {};
  // The single "Send to Fusion CAM" popup (CAM mode, part/quantity
  // pickers, router, tool) - one global entry point, not one per stock
  // group. Direct instruction: this belongs as a page-level action (see
  // openQueuePicker, called from the page header in +page.svelte via
  // bind:this), not a button buried under every stock group in the list.
  // queuePickerCategoryId is which stock category is currently chosen
  // inside the popup - '' until the user picks one. queuePickerDate
  // narrows the part pickers to parts created on one day (Pacific, to
  // match the rest of the app's date conventions). An empty value is the
  // default all-dates view.
  let queuePickerOpen = false;
  let queuePickerCategoryId = '';
  let queuePickerDate = '';
  // Free-text search over "Recent parts" - empty shows the 6 most recent
  // queueable parts (recentQueueableParts is already newest-first), typing
  // searches every queueable part by name instead of only the newest 10.
  let recentPartsSearch = '';
  // Same idea, scoped to the grouped-CAM picker's current stock category -
  // empty shows its 6 most recently created part types, typing searches
  // every queueable part type in that category.
  let groupedPartsSearch = '';

  // 'YYYY-MM-DD' in Pacific time, matching a <input type="date">'s own
  // value format - lets a part's created_at be compared directly against
  // queuePickerDate without a timezone-naive string slice.
  function pacificDateKey(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    return new Intl.DateTimeFormat('en-CA', { timeZone: PACIFIC_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  }

  // Called externally via bind:this from +page.svelte's header button.
  export function openQueuePicker() {
    queuePickerOpen = true;
    queuePickerDate = '';
    recentPartsSearch = '';
    groupedPartsSearch = '';
  }

  // Called externally via bind:this from +page.svelte's "Quick Queue"
  // button, after the user has already chosen "Plate" there. Opens the
  // same New Part form used everywhere else - handleAddPart below checks
  // quickQueueMode to chain into the queue picker on save instead of just
  // closing the form.
  export function openQuickQueue() {
    quickQueueMode = true;
    showAddPartForm = true;
  }

  function closeQueuePicker() {
    queuePickerOpen = false;
    queuePickerCategoryId = '';
    recentPartsSearch = '';
    groupedPartsSearch = '';
  }

  function clearQueuePickerFilters() {
    queuePickerDate = '';
    queuePickerCategoryId = '';
    recentPartsSearch = '';
    groupedPartsSearch = '';
  }

  $: hasQueuePickerFilters = Boolean(
    queuePickerDate || queuePickerCategoryId || recentPartsSearch || groupedPartsSearch
  );

  // First Escape clears whichever search box has text (matching the
  // "search box, then close" convention of most filterable pickers) -
  // only once both are already empty does a second Escape close the
  // picker itself, rather than the first press unexpectedly closing it
  // out from under someone still refining a search.
  function handleQueuePickerKeydown(event) {
    if (!queuePickerOpen || event.key !== 'Escape') return;
    if (recentPartsSearch || groupedPartsSearch) {
      recentPartsSearch = '';
      groupedPartsSearch = '';
      return;
    }
    closeQueuePicker();
  }

  // Fusion filename + folder picker, shown as a confirmation step right
  // before a job actually queues. folderTreeRow is the cached Data Panel
  // tree (see fetchFusionFolderTree) - null until a Runner has synced at
  // least once, in which case the modal just falls back to the server's
  // own default folder with a note explaining why there's no tree to pick
  // from yet.
  let folderTreeRow = null;
  let queueModalPlate = null;
  let queueModalCategoryId = null;
  let queueModalLabel = '';
  let queueFileName = '';
  let queueFolderPath = '';
  // Optional operator override for how many release tabs this job's
  // parts get, instead of the automatic perimeter-based target - blank
  // (the default) means stay automatic, this job's existing behavior.
  // Bounded to the same [4, 20] range TabPlacement.py's own
  // DEFAULT_MIN_TABS/DEFAULT_MAX_TABS already treat as reasonable for
  // the automatic target - direct instruction: this "cannot be too
  // much," re-clamped server-side (buildJobPayload) and again in the
  // Runner itself, not just enforced by this input's own min/max.
  const TAB_COUNT_MIN = 4;
  const TAB_COUNT_MAX = 20;
  let queueTabCount = '';
  // Free-text search over the synced Data Panel tree. The picker walks from
  // the "2026 Season CAM" project root, which has far too many nested
  // subsystem folders to browse by scrolling - typing filters to a flat
  // list of matches instead of expanding the tree by hand.
  let folderSearch = '';
  $: folderSearchTerm = folderSearch.trim();
  $: folderSearchResults = folderSearchTerm
    ? searchFolderTree(folderTreeRow?.tree, folderSearchTerm)
    : [];
  let queueSubmitting = false;

  // State for the "Open Fusion CAM" deep-link prefill - see
  // initialManufacturingPartId and applyManufacturingPrefill below.
  let prefillApplied = false;
  let stepCarriedOverFrom = null;
  let detectingDepth = false;
  let detectedDepthInches = null;

  async function loadFolderTree() {
    try {
      folderTreeRow = await fetchFusionFolderTree();
    } catch (e) {
      console.warn('Could not load Fusion folder tree:', e.message);
    }
  }

  async function loadManufacturingParts() {
    const { data, error } = await supabase
      .from('parts')
    .select('id, name, project_id, workflow, quantity, file_name, file_url, stock_assignment')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) {
      console.warn('Could not load manufacturing requests to link:', error.message);
      return;
    }
    manufacturingParts = data || [];
  }

  // Same file_url convention manufacture/+page.svelte's own
  // getStepFileName/getFileMeta use - a JSON blob { step_file, ... } for
  // router parts, with file_name kept as a plain-string fallback for
  // backward compat (see manufacture/create/+page.svelte's insert).
  function manufacturingStepFileName(mp) {
    if (!mp) return null;
    try {
      const meta = JSON.parse(mp.file_url);
      if (meta?.step_file) return meta.step_file;
    } catch {}
    if (mp.file_name && /\.(step|stp)$/i.test(mp.file_name)) return mp.file_name;
    return null;
  }

  // Direct invariant: "if a part is linked to a manufacturing request, it
  // should have the same step file" - so once a link with a real STEP file
  // is picked, the manual STEP picker is disabled rather than left as a
  // soft, overridable suggestion (see handleFileChange). Only true when the
  // linked request actually HAS a resolvable STEP file - a request with no
  // STEP of its own has nothing to enforce, so the manual picker stays
  // available for that case rather than leaving the part stuck with none.
  $: manufacturingHasStepFile = !!manufacturingStepFileName(
    manufacturingParts.find((mp) => mp.id === newPart.manufacturingPartId)
  );

  // Best-effort carry-over of the linked request's STEP file (so the user
  // doesn't have to re-download-then-re-upload it) and a depth estimate read
  // straight off its geometry (extractRoutingContoursFromMeshes's own
  // thickness - the same measure CadViewer.svelte's bounding-box readout and
  // the routing G-code generator both already trust). Neither is required
  // for the form to work - a part with no STEP, or geometry this extractor
  // can't parse (not a flat routed profile), just skips that part quietly.
  async function applyManufacturingPrefill(linkedPart) {
    newPart = {
      ...newPart,
      name: newPart.name || linkedPart.name || '',
      quantity: newPart.quantity === 1 && Number.isInteger(Number(linkedPart.quantity)) && Number(linkedPart.quantity) > 0
        ? Number(linkedPart.quantity)
        : newPart.quantity,
      manufacturingPartId: linkedPart.id,
      projectId: linkedPart.project_id || '',
      stockAssignment: linkedPart.stock_assignment || ''
    };
    if (!newPart.fusionFileName) {
      const derived = (linkedPart.name || '').trim().replace(/\s+/g, '');
      if (derived) newPart.fusionFileName = derived;
    }
    const { data: materials } = await supabase.from('cam_materials').select('id, name').eq('enabled', true);
    const materialId = materialIdForStockAssignment(manufacturingStockMaterialIndex, materials || [], linkedPart.stock_assignment, stockData);
    const stockId = stockCatalogIdForStockAssignment(stockData, linkedPart.stock_assignment);
    const thickness = (stockData.router || []).find((stock) => stock.id === stockId)?.thickness;
    const stockCategory = categories.find((category) => String(category.material_id) === String(materialId) && Number.isFinite(thickness) && Math.abs(Number(category.thickness) - thickness) < 0.002);
    if (stockCategory) newPart = { ...newPart, categoryId: String(stockCategory.id) };
    showAddPartForm = true;

    const stepPath = manufacturingStepFileName(linkedPart);
    if (!stepPath) return;

    // Never leave an older manually picked file attached while this link is
    // loading. If the linked file cannot be downloaded, handleAddPart below
    // blocks creation rather than silently associating the request with
    // unrelated geometry.
    stepFile = null;
    stepCarriedOverFrom = null;
    try {
      const { data: blob, error: downloadError } = await supabase.storage
        .from('manufacturing-files')
        .download(stepPath);
      if (downloadError || !blob) throw downloadError || new Error('Empty download');
      stepFile = new File([blob], stepPath.split('/').pop(), { type: blob.type || 'application/step' });
      stepCarriedOverFrom = linkedPart.name;
    } catch (e) {
      console.warn('Could not carry over the linked request\'s STEP file:', e.message || e);
      toastActions.show('Could not load the linked request STEP file');
    }

    detectingDepth = true;
    try {
      const meshes = await fetchStepMeshes(stepPath);
      const { thickness } = extractRoutingContoursFromMeshes(meshes);
      detectedDepthInches = thickness;
    } catch (e) {
      console.warn('Could not estimate depth from this STEP file:', e.message || e);
    } finally {
      detectingDepth = false;
    }
  }

  // Picking a request from the dropdown carries its STEP file over too,
  // not just arriving via the "Open Fusion CAM" deep link. A part linked to
  // a manufacturing request is meant to BE that request's part, so it
  // should already have that request's STEP file - previously the carry-over
  // only ran on the deep-link path, so linking a request by hand left the
  // file picker empty and the same STEP had to be downloaded from the
  // request and re-uploaded here by hand.
  //
  // A file the user chose themselves is never replaced: only a carried-over
  // file (stepCarriedOverFrom) or an empty picker is filled in, so
  // re-pointing the link can't silently swap out a deliberate upload.
  async function handleManufacturingLinkChange() {
    const selectedId = newPart.manufacturingPartId;
    if (!selectedId) {
      // Unlinking clears a file that only came from the previous link -
      // leaving it attached would quietly ship the wrong geometry.
      if (stepCarriedOverFrom) {
        stepFile = null;
        stepCarriedOverFrom = null;
        detectedDepthInches = null;
      }
      return;
    }
    const linkedPart = manufacturingParts.find((mp) => mp.id === selectedId);
    if (!linkedPart) return;
    // Direct invariant: "if a part is linked to a manufacturing request, it
    // should have the same step file." A manual pick made BEFORE choosing
    // this link no longer wins - linking always carries the request's own
    // file over, same as manufacturingHasStepFile disables the picker
    // going forward. Only skipped when the linked request has no STEP file
    // of its own to carry over (manufacturingStepFileName returns null) -
    // there is nothing to enforce, so whatever manual file is already
    // picked is left alone rather than being cleared for no replacement.
    if (!manufacturingStepFileName(linkedPart) && stepFile && !stepCarriedOverFrom) return;
    await applyManufacturingPrefill(linkedPart);
  }

  // Runs once, as soon as both the deep-link target and the manufacturing
  // parts list it needs to be found in are available. Falls back to a
  // direct fetch if the request isn't among the most-recent 200 (the
  // dropdown's own cap) - a deep link can point at an older request.
  $: if (!prefillApplied && canManage && initialManufacturingPartId && manufacturingParts.length) {
    prefillApplied = true;
    const linkedPart = manufacturingParts.find((mp) => mp.id === initialManufacturingPartId);
    if (linkedPart) {
      applyManufacturingPrefill(linkedPart);
    } else {
      supabase
        .from('parts')
        .select('id, name, project_id, workflow, quantity, file_name, file_url, stock_assignment')
        .eq('id', initialManufacturingPartId)
        .maybeSingle()
        .then(({ data, error }) => {
          if (error || !data) {
            console.warn('Could not load the linked manufacturing request:', error?.message);
            return;
          }
          manufacturingParts = [data, ...manufacturingParts];
          applyManufacturingPrefill(data);
        });
    }
  }

  // showLoading=false for refreshes after an action (add/delete/queue/etc.) -
  // flipping loading back to true mid-interaction replaced the whole list
  // with a loading state and back, a jarring flash for what should be a
  // quiet re-fetch. Only the initial mount needs it.
  async function load(showLoading = true) {
    if (showLoading) loading = true;
    try {
      [parts, categories, plates] = await Promise.all([fetchParts(), fetchPartCategories(), fetchPlates()]);
      const { fusionPartIds } = await fetchCompletedFusionStockIds();
      completedPartIds = fusionPartIds;
      await loadManufacturingParts();
      const { data: machineRows } = await supabase.from('cam_machines').select('*').eq('can_run_plates', true).eq('enabled', true).order('name');
      machines = machineRows || [];
      const { data: machineToolRows } = await supabase
        .from('cam_machine_tools')
        .select('machine_id, cam_tools(id, name, diameter, tool_type, tool_number, tip_angle, tool_library_guid, source_tool_library_file)')
        .in('machine_id', machines.map((m) => m.id));
      machineTools = {};
      for (const row of machineToolRows || []) {
        if (!row.cam_tools) continue;
        (machineTools[row.machine_id] ||= []).push(row.cam_tools);
      }
      // Full catalog (not just what's already loaded) - the ATC Slots
      // modal needs every candidate tool per slot, not only the ones
      // currently in cam_machine_tools.
      const { data: toolRows } = await supabase.from('cam_tools').select('*');
      atcTools = toolRows || [];
    } catch (e) {
      toastActions.show(e.message || 'Failed to load parts');
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    load();
    loadFolderTree();
  });

  function toolsForMachine(machineId) {
    return machineId ? machineTools[machineId] || [] : [];
  }

  function toolLabel(tool) {
    return `${tool.name}${tool.diameter ? ` (${tool.diameter}")` : ''}`;
  }

  function isNewRouter(machineId) {
    return machines.find((machine) => String(machine.id) === String(machineId))?.name?.trim().toLowerCase() === 'new router';
  }

  function isAluminum6061(group) {
    const material = String(group?.category?.cam_materials?.name || '').trim().toLowerCase();
    return ['aluminum 6061', 'aluminium 6061', '6061 aluminum', '6061 aluminium'].includes(material);
  }

  function canUseAutoMultiTool(group, machineId) {
    return isNewRouter(machineId) && isAluminum6061(group);
  }

  // The real, physical 971 Main Bit's own stable tool-library GUID
  // (tools/971-outside-plate.tools and tools/Normal router tools (use
  // this).tools both use this same GUID for it) - matched on this rather
  // than the tool's own name, which real, confirmed history has already
  // shown can drift ("971 Main Bit 0.1575 in Flat End Mill" vs. "ShopSabre
  // 1 971 Main Bit (0.1575in)" turned out to be two separate duplicate
  // cam_tools rows for this exact physical bit) and previously made an
  // exact-name match here silently never find it at all.
  const MAIN_BIT_GUID = '10a2caeb-dec0-49b2-8701-96fdb212bad9';

  function _looksLikeMainBit(tool) {
    if (tool?.tool_library_guid === MAIN_BIT_GUID) return true;
    return String(tool?.name || '').trim().toLowerCase().includes('971 main bit');
  }

  function mainBitForMachine(machineId) {
    return toolsForMachine(machineId).find(_looksLikeMainBit);
  }

  // Only 971 Main Bit ships a real, reviewed feed/speed preset for every
  // material this shop actually cuts (see tools/971-outside-plate.tools) -
  // every other loaded New Router cutter only has a bare "Default preset",
  // which templateTools.py's own _choose_preset() only accepts for
  // Aluminum 6061 (a deliberately narrow exception, not a general
  // fallback). Selecting one of those other tools for any other material
  // queues a job that is guaranteed to fail once Fusion actually tries to
  // apply feeds/speeds - disabled here instead of failing minutes later,
  // deep into a real machine run.
  function toolHasReviewedPresetForGroup(tool, group) {
    if (isAluminum6061(group)) return true;
    return _looksLikeMainBit(tool);
  }

  // ATC Slots, reachable right from the queue picker (not only the /autocam
  // admin page) - an operator who notices a missing tool here shouldn't
  // have to leave this modal to go fix it.
  let showAtcModal = false;
  let atcModalMachineId = null;
  let atcModalMachineName = '';
  function openAtcModal(machineId) {
    const machine = machines.find((m) => String(m.id) === String(machineId));
    if (!machine) return;
    atcModalMachineId = machine.id;
    atcModalMachineName = machine.name;
    showAtcModal = true;
  }

  function isEndmill(tool) {
    return /end\s*mill/i.test(String(tool?.tool_type || ''));
  }

  // Picking a router pre-selects that machine's default tool (if it's
  // actually installed on it) rather than leaving the tool blank - same
  // "profile picks reasonable defaults, human can still override" pattern
  // applyMachineDefaults() uses on the main /autocam page. Clears the
  // selection if the previous tool isn't valid for the newly-picked router.
  function handleMachineChange(categoryId, machineId) {
    categoryMachineSelections = { ...categoryMachineSelections, [categoryId]: machineId };
    const eligible = toolsForMachine(machineId);
    const machine = machines.find((m) => String(m.id) === String(machineId));
    const group = stockGroups.find((candidate) => String(candidate.categoryId) === String(categoryId));
    const singleToolMode = isNewRouter(machineId);
    const eligibleForMode = isNewRouter(machineId) ? eligible.filter(isEndmill) : eligible;
    categorySingleToolModes = { ...categorySingleToolModes, [categoryId]: singleToolMode };
    const stillValid = eligibleForMode.some((t) => String(t.id) === String(categoryToolSelections[categoryId]));
    if (!stillValid) {
      // Aluminum 6061 can choose its own single cutter or use ATC planning.
      // Every other New Router material is deliberately single-tool and
      // starts on the physically loaded 971 Main Bit.
      if (isNewRouter(machineId)) {
        const mainBit = !canUseAutoMultiTool(group, machineId) ? mainBitForMachine(machineId) : null;
        categoryToolSelections = { ...categoryToolSelections, [categoryId]: mainBit?.id || '' };
      } else {
        const defaultTool = eligibleForMode.find((t) => String(t.id) === String(machine?.default_tool_id));
        categoryToolSelections = { ...categoryToolSelections, [categoryId]: defaultTool?.id || eligibleForMode[0]?.id || '' };
      }
    }
  }

  async function detectStepThickness(bytes) {
    detectingDepth = true;
    detectedDepthInches = null;
    try {
      const meshes = await readStepMeshes(bytes);
      const { thickness } = extractRoutingContoursFromMeshes(meshes);
      detectedDepthInches = thickness;
      const matchingCategory = categories.find((category) => Math.abs(Number(category.thickness) - thickness) <= 0.002);
      if (matchingCategory) newPart = { ...newPart, categoryId: String(matchingCategory.id) };
    } catch (e) {
      console.warn('Could not estimate depth from this STEP file:', e.message || e);
    } finally {
      detectingDepth = false;
    }
  }

  async function handleFileChange(event) {
    // Direct invariant: "if a part is linked to a manufacturing request, it
    // should have the same step file" - not a soft suggestion a manual pick
    // can silently override. The file input is disabled in the markup
    // whenever a link with a real STEP file is selected (see
    // manufacturingHasStepFile below); this guard is defense in depth for
    // an event that fires anyway (a disabled input's change handler should
    // never run, but nothing here should trust that from the DOM alone).
    if (manufacturingHasStepFile) return;
    stepFile = event.target.files?.[0] || null;
    stepCarriedOverFrom = null; // user picked their own file - the carry-over hint no longer applies
    // A STEP file picked before the name is typed suggests a real filename
    // like "BellyPan.step" the operator would otherwise just retype by
    // hand into Name - only when Name is still empty, so this never
    // overwrites a name someone already typed in.
    if (stepFile && !newPart.name.trim()) {
      const derivedName = stepFile.name.replace(/\.(step|stp)$/i, '').trim();
      if (derivedName) newPart = { ...newPart, name: derivedName };
    }
    if (stepFile) await detectStepThickness(new Uint8Array(await stepFile.arrayBuffer()));
    else detectedDepthInches = null;
  }

  async function handleAddPart() {
    if (!newPart.name || !newPart.categoryId || !newPart.quantity) {
      toastActions.show('Name, category, and quantity are required');
      return;
    }
    if (manufacturingHasStepFile && !stepFile) {
      toastActions.show('The linked request STEP file is still unavailable');
      return;
    }
    submitting = true;
    const wasQuickQueue = quickQueueMode;
    try {
      const created = await createPart({
        name: newPart.name,
        quantity: Number(newPart.quantity),
        categoryId: newPart.categoryId,
        stepFile,
        createdBy: user?.id,
        partId: newPart.manufacturingPartId || null,
        fusionFileName: newPart.fusionFileName || null,
        projectId: newPart.projectId || null,
        stockAssignment: newPart.stockAssignment || null
      });
      newPart = { name: '', quantity: 1, categoryId: '', manufacturingPartId: '', fusionFileName: '', projectId: '', stockAssignment: '' };
      stepFile = null;
      stepCarriedOverFrom = null;
      detectedDepthInches = null;
      showAddPartForm = false;
      quickQueueMode = false;
      await load(false);
      if (wasQuickQueue && created) {
        // stockGroups is a reactive derivation off `parts` (just refreshed
        // above by load()) - wait for it to actually recompute before
        // selectRecentPart looks up this brand-new part's category group,
        // which may not have existed in stockGroups before this part did.
        await tick();
        openQueuePicker();
        selectRecentPart(created);
        toastActions.show('Part added - choose a router and tool to queue it');
      } else {
        toastActions.show('Part added - send it to Fusion CAM when you are ready');
      }
    } catch (e) {
      toastActions.show(e.message || 'Failed to add part');
    } finally {
      submitting = false;
    }
  }

  // Closes the New Part form without creating anything - same reset
  // handleAddPart does on a successful save, so reopening the form later
  // starts clean instead of showing whatever was left half-filled-in.
  function handleCancelAddPart() {
    showAddPartForm = false;
    quickQueueMode = false;
    newPart = { name: '', quantity: 1, categoryId: '', manufacturingPartId: '', fusionFileName: '', projectId: '', stockAssignment: '' };
    stepFile = null;
    stepCarriedOverFrom = null;
    detectedDepthInches = null;
  }

  async function handleDeletePart(part) {
    if (!await requestConfirmation({ title: 'Delete part', message: `Delete part "${part.name}"?`, confirmLabel: 'Delete', danger: true })) return;
    try {
      await deletePart(part.id);
      // Splice locally instead of re-fetching everything just to drop one
      // row - a real report: even with load()'s loading-flash fix, a full
      // re-fetch still visibly "reloaded" the list on every delete.
      parts = parts.filter((p) => p.id !== part.id);
      if (selectedPartIds.has(part.id)) {
        const next = new Set(selectedPartIds);
        next.delete(part.id);
        selectedPartIds = next;
      }
    } catch (e) {
      toastActions.show(e.message || 'Failed to delete part');
    }
  }

  function startRenamePart(part) {
    renamingPartId = part.id;
    renamePartValue = part.name;
  }

  function cancelRenamePart() {
    renamingPartId = null;
    renamePartValue = '';
  }

  async function saveRenamePart(part) {
    const trimmed = renamePartValue.trim();
    if (!trimmed) {
      toastActions.show('Name cannot be empty');
      return;
    }
    if (trimmed === part.name) {
      cancelRenamePart();
      return;
    }
    try {
      const updated = await renamePart(part.id, trimmed);
      parts = parts.map((p) => (p.id === part.id ? { ...p, ...updated } : p));
      cancelRenamePart();
    } catch (e) {
      toastActions.show(e.message || 'Failed to rename part');
    }
  }

  function startEditQuantity(part) {
    editingQuantityId = part.id;
    quantityValue = String(part.original_quantity);
  }

  function cancelEditQuantity() {
    editingQuantityId = null;
    quantityValue = '';
  }

  async function saveQuantity(part) {
    const parsed = Number(quantityValue);
    if (!Number.isInteger(parsed) || parsed < 0) {
      toastActions.show('Quantity must be a whole number, zero or more');
      return;
    }
    if (parsed === part.original_quantity) {
      cancelEditQuantity();
      return;
    }
    try {
      const updated = await updatePartQuantity(part.id, parsed);
      parts = parts.map((p) => (p.id === part.id ? { ...p, ...updated } : p));
      cancelEditQuantity();
    } catch (e) {
      toastActions.show(e.message || 'Failed to update quantity');
    }
  }

  function categoryLabel(cat) {
    if (!cat) return 'Unknown';
    const material = cat.cam_materials?.name || 'Material';
    return `${material} - ${cat.thickness}"`;
  }

  // View CAD / Install CAD - fetchParts already selects fusion_parts.*, so
  // step_file_name is on the row directly here, unlike JobQueueTab.svelte
  // (a Fusion job's own step_file_name is always null; it has to resolve
  // this through its linked part instead - see fetchFusionPartStepFiles).
  let cadModalPart = null;

  async function handleInstallCad(part) {
    try {
      const url = await installFusionPartCad(part.step_file_name);
      window.open(url, '_blank');
    } catch (e) {
      toastActions.show(e.message || 'Failed to download STEP file');
    }
  }

  // Attach/replace STEP - real gap this closes: a part created without CAD
  // (or needing a corrected STEP) had no fix short of deleting and
  // recreating the whole record, losing its quantity history and plate
  // assignment in the process.
  let attachStepModalPart = null;
  let attachStepFile = null;
  let attachingStep = false;

  function openAttachStepModal(part) {
    attachStepModalPart = part;
    attachStepFile = null;
  }

  function closeAttachStepModal() {
    if (attachingStep) return;
    attachStepModalPart = null;
    attachStepFile = null;
  }

  async function saveAttachStep() {
    if (!attachStepFile) return toastActions.show('Choose a STEP file first');
    attachingStep = true;
    try {
      const updated = await updatePartStepFile(attachStepModalPart.id, attachStepFile);
      parts = parts.map((item) => (item.id === updated.id ? updated : item));
      toastActions.show('STEP file saved');
      attachStepModalPart = null;
      attachStepFile = null;
    } catch (e) {
      toastActions.show(e.message || 'Failed to save STEP file');
    } finally {
      attachingStep = false;
    }
  }

  // Quantity for queueing purposes is the part's full requested quantity,
  // not a shrinking "remaining unassigned" count - a part can be requeued
  // as many times as needed (reprints, retries), so there's no reason to
  // cap or hide it once it's been queued once.
  function maximumQueueQuantity(group, part) {
    return Number(part.original_quantity);
  }

  function queueableParts(group) {
    return group.parts.filter((part) =>
      Number(part.original_quantity) > 0
      && (!queuePickerDate || pacificDateKey(part.created_at) === queuePickerDate)
    );
  }

  function selectRecentPart(part) {
    const group = stockGroups.find((candidate) =>
      candidate.categoryId && String(candidate.categoryId) === String(part.category_id)
    );
    if (!group) return;
    // A recent part can be outside an active date filter. Clear it so the
    // bound category and part selections always remain available.
    queuePickerDate = '';
    queuePickerCategoryId = group.categoryId;
    groupedPartsSearch = '';
    categoryQueueModes = { ...categoryQueueModes, [group.categoryId]: 'single' };
    categorySinglePartSelections = { ...categorySinglePartSelections, [group.categoryId]: part.id };
    handleSinglePartPick(group);
  }

  function handleSinglePartPick(group) {
    const categoryId = group.categoryId;
    const part = group.parts.find((p) => p.id === categorySinglePartSelections[categoryId]);
    if (!part) return;
    categorySinglePartQuantities = { ...categorySinglePartQuantities, [categoryId]: Number(part.original_quantity) };
  }

  function toggleGroupedPart(group, part) {
    const categoryId = group.categoryId;
    const selected = new Set(categoryGroupedPartSelections[categoryId] || []);
    const quantities = { ...(categoryGroupedPartQuantities[categoryId] || {}) };
    if (selected.has(part.id)) {
      selected.delete(part.id);
      delete quantities[part.id];
    } else {
      selected.add(part.id);
      quantities[part.id] = Number(part.original_quantity);
    }
    categoryGroupedPartSelections = { ...categoryGroupedPartSelections, [categoryId]: [...selected] };
    categoryGroupedPartQuantities = { ...categoryGroupedPartQuantities, [categoryId]: quantities };
  }

  function selectAllGroupedParts(group, queueable) {
    const categoryId = group.categoryId;
    const quantities = {};
    for (const part of queueable) quantities[part.id] = Number(part.original_quantity);
    categoryGroupedPartSelections = { ...categoryGroupedPartSelections, [categoryId]: queueable.map((p) => p.id) };
    categoryGroupedPartQuantities = { ...categoryGroupedPartQuantities, [categoryId]: quantities };
  }

  function clearGroupedParts(group) {
    const categoryId = group.categoryId;
    categoryGroupedPartSelections = { ...categoryGroupedPartSelections, [categoryId]: [] };
    categoryGroupedPartQuantities = { ...categoryGroupedPartQuantities, [categoryId]: {} };
  }

  // Everything queueing a job actually needs, checked before the filename/
  // folder confirmation modal even opens - failing fast here (as a toast)
  // reads better than opening the modal only to reject it on confirm.
  function queueValidationError(group) {
    const categoryId = group.categoryId;
    if (!categoryMachineSelections[categoryId]) return 'Choose a router before queueing';
    // The Runner's own fallback (auto-picking a tool when none is given)
    // calls an API endpoint that doesn't exist in this app yet - without
    // an explicit tool, a queued job has no real way to resolve one, so
    // this is required here rather than left optional like machineId
    // originally was before routers were made explicit too. New Router's
    // Auto multi-tool mode is the one real exception: the tool selection is
    // deliberately cleared for it (a single manual choice doesn't apply -
    // resolveLoadedToolItems/plan_endmills pick from every loaded tool
    // server-side), so nothing to require here in that case.
    const isAutoMultiTool = canUseAutoMultiTool(group, categoryMachineSelections[categoryId]) && !categorySingleToolModes[categoryId];
    if (!isAutoMultiTool && !categoryToolSelections[categoryId]) return 'Choose a tool before queueing';
    const usesSingleTool = !isAutoMultiTool && isNewRouter(categoryMachineSelections[categoryId]);
    if (usesSingleTool) {
      const selectedTool = toolsForMachine(categoryMachineSelections[categoryId])
        .find((tool) => String(tool.id) === String(categoryToolSelections[categoryId]));
      if (!isEndmill(selectedTool)) return 'Single-tool CAM requires an endmill';
      if (isNewRouter(categoryMachineSelections[categoryId]) && !toolHasReviewedPresetForGroup(selectedTool, group)) {
        return 'Selected tool has no reviewed feed/speed preset for this material';
      }
    }
    const mode = categoryQueueModes[categoryId];
    if (!['single', 'grouped'].includes(mode)) return 'Choose single-part or grouped CAM';
    if (mode === 'single') {
      const partId = categorySinglePartSelections[categoryId];
      if (!partId) return 'Choose a part for single-part CAM';
      const quantity = Number(categorySinglePartQuantities[categoryId]);
      if (!Number.isInteger(quantity) || quantity <= 0) return 'Quantity must be a whole number greater than zero';
      const part = group.parts.find((p) => p.id === partId);
      if (part && quantity > maximumQueueQuantity(group, part)) return `Only ${maximumQueueQuantity(group, part)} of ${part.name} is available`;
      // Real, confirmed gap: nothing here checked for a STEP file at all -
      // the UI let a part with none through, only for buildJobPayload.js's
      // own signedUrl() to reject the whole job server-side minutes later
      // with "Part X is missing its STEP file." Caught here instead, same
      // as every other queueing prerequisite this function already fails
      // fast on.
      if (part && !part.step_file_name) return `${part.name} has no STEP file uploaded yet`;
    }
    if (mode === 'grouped') {
      const selected = categoryGroupedPartSelections[categoryId] || [];
      if (selected.length < 2) return 'Select at least two part types for grouped CAM';
      for (const partId of selected) {
        const quantity = Number(categoryGroupedPartQuantities[categoryId]?.[partId]);
        if (!Number.isInteger(quantity) || quantity <= 0) return 'Every selected part needs a whole-number quantity greater than zero';
        const part = group.parts.find((p) => p.id === partId);
        if (part && quantity > maximumQueueQuantity(group, part)) return `Only ${maximumQueueQuantity(group, part)} of ${part.name} is available`;
        if (part && !part.step_file_name) return `${part.name} has no STEP file uploaded yet`;
      }
    }
    return null;
  }

  // The one plate a stock category ever has, created transparently on
  // first use - a human never names or sizes it. 100x100in default: a
  // plate's declared size only bounds how much room the Runner's Arrange
  // solver has to nest parts in, not the real CAM stock (that's sized to
  // the actual imported geometry regardless - see SetupGenerator.py), so a
  // generous default costs nothing real. The Runner also grows a category's
  // plate further on its own the first time a part doesn't fit even this
  // (see AutoArrange.py's required_plate_dimensions), so this is a
  // starting point, not a hard ceiling.
  async function resolveCategoryPlateId(group) {
    if (group.plates[0]) return group.plates[0].id;
    const created = await createPlate({
      name: `Auto stock - ${categoryLabel(group.category)}`,
      width: 100,
      length: 100,
      trueDepth: Number(group.category?.thickness) || 0.25,
      categoryId: group.categoryId
    });
    plates = [...plates, created];
    return created.id;
  }

  async function openQueueModal(group) {
    const error = queueValidationError(group);
    if (error) {
      toastActions.show(error);
      return;
    }
    const categoryId = group.categoryId;
    const mode = categoryQueueModes[categoryId];
    queueing = { ...queueing, [categoryId]: true };
    try {
      const plateId = await resolveCategoryPlateId(group);
      queueModalPlate = group.plates.find((p) => p.id === plateId) || { id: plateId };
      queueModalCategoryId = categoryId;
      queueModalLabel = mode === 'single'
        ? (group.parts.find((p) => p.id === categorySinglePartSelections[categoryId])?.name || categoryLabel(group.category))
        : categoryLabel(group.category);
      queueFileName = queueModalLabel.replace(/\s+/g, '');
      queueFolderPath = '';
      queueTabCount = '';
      folderSearch = '';
      closeQueuePicker();
    } catch (e) {
      toastActions.show(e.message || 'Failed to prepare this job for queueing');
    } finally {
      queueing = { ...queueing, [categoryId]: false };
    }
  }

  function closeQueueModal() {
    queueModalPlate = null;
    queueModalCategoryId = null;
    // Otherwise a stale search term hides the whole tree the next time this
    // modal opens, which reads as "the folder list disappeared."
    folderSearch = '';
    queueTabCount = '';
  }

  async function confirmQueue() {
    const plate = queueModalPlate;
    const categoryId = queueModalCategoryId;
    if (!plate || !categoryId || queueSubmitting) return;
    const mode = categoryQueueModes[categoryId];
    const selectedPartId = mode === 'single' ? categorySinglePartSelections[categoryId] : null;
    const selectedPartIds = mode === 'grouped' ? (categoryGroupedPartSelections[categoryId] || []) : null;
    const assignments = (mode === 'single' ? [selectedPartId] : selectedPartIds).map((partId) => ({
      partId,
      quantity: Number(mode === 'single'
        ? categorySinglePartQuantities[categoryId]
        : categoryGroupedPartQuantities[categoryId]?.[partId])
    }));
    const group = stockGroups.find((candidate) => String(candidate.categoryId) === String(categoryId));
    const multiToolMode = canUseAutoMultiTool(group, categoryMachineSelections[categoryId])
      && !categorySingleToolModes[categoryId];
    queueSubmitting = true;
    try {
      await queueFusionPlateJob({
        plateId: plate.id,
        assignments,
        machineId: categoryMachineSelections[categoryId],
        toolId: categoryToolSelections[categoryId] || null,
        requestedBy: user?.id,
        groupingMode: mode,
        name: `${mode === 'grouped' ? 'Grouped Fusion CAM' : 'Fusion CAM'}: ${queueModalLabel}`,
        fusionFileName: queueFileName.trim() || null,
        fusionFolderPath: queueFolderPath || null,
        tabCount: queueTabCount === '' ? null : queueTabCount,
        singleToolMode: isNewRouter(categoryMachineSelections[categoryId]) && !multiToolMode,
        multiToolMode,
      });
      toastActions.show('Queued for the Fusion Runner');
      categoryQueueModes = { ...categoryQueueModes, [categoryId]: '' };
      categorySinglePartSelections = { ...categorySinglePartSelections, [categoryId]: '' };
      categoryGroupedPartSelections = { ...categoryGroupedPartSelections, [categoryId]: [] };
      closeQueueModal();
      await load(false);
    } catch (e) {
      toastActions.show(e.message || 'Failed to queue job');
    } finally {
      queueSubmitting = false;
    }
  }
</script>

<svelte:window on:keydown={handleQueuePickerKeydown} />

{#if loading}
  <p>Loading parts...</p>
{:else}
  {#if canManage}
    <div class="tab-actions">
      <button class="btn btn-primary" on:click={() => (showAddPartForm = !showAddPartForm)}>
        <Plus size={16} /> Add Part
      </button>
    </div>
  {/if}

  {#if showAddPartForm && canManage}
    <div class="card">
      <div class="cam-list-header">
        <h3>{quickQueueMode ? 'Quick Queue: New Part' : 'New Part'}</h3>
        <button type="button" class="btn btn-ghost btn-sm" title="Close" aria-label="Close without adding a part" on:click={handleCancelAddPart}><X size={16} /></button>
      </div>
      <p class="cam-form-hint">
        {quickQueueMode
          ? 'Fill this in, then choose a router and tool on the next screen to queue it right away.'
          : 'A named quantity of stock waiting to be sent to Fusion CAM.'}
      </p>
      {#if newPart.manufacturingPartId && prefillApplied}
        <p class="prefill-banner">
          <Sparkles size={14} /> Pre-filled from the linked manufacturing request - check material/thickness below before saving.
        </p>
      {/if}
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="part-name">Name</label>
          <input id="part-name" class="form-input" bind:value={newPart.name} placeholder="e.g. Gearbox Side Plate" />
        </div>
        <div class="form-group">
          <label class="form-label" for="part-step">STEP file {manufacturingHasStepFile ? '(from linked request)' : '(optional)'}</label>
          {#if manufacturingHasStepFile}
            <!-- A real <input type="file"> can only ever show a filename the
                 BROWSER put there via its own picker - assigning our
                 downloaded/carried-over File to the `stepFile` variable
                 never updates its native "No file chosen" text, which read
                 as if nothing were attached even though a real file is
                 already staged for upload. Shown as a locked readout of the
                 actual carried-over file instead of a disabled native input. -->
            <div class="form-input locked-step-file" id="part-step">
              <Check size={14} /> {stepFile?.name || 'Loading the linked STEP file...'}
            </div>
            <p class="cam-form-hint">Locked to the linked request's own STEP file - a linked part always has the same file. Unlink the request above to upload a different one.</p>
          {:else}
            <input
              id="part-step"
              type="file"
              accept=".step,.stp"
              class="form-input"
              on:change={handleFileChange}
            />
            {#if stepCarriedOverFrom}
              <p class="cam-form-hint">Carried over from "{stepCarriedOverFrom}" - pick a different file above to replace it.</p>
            {/if}
          {/if}
        </div>
        <div class="form-group">
          <label class="form-label" for="part-category">Material / Thickness</label>
          <select id="part-category" class="form-select" bind:value={newPart.categoryId}>
            <option value="">Select...</option>
            {#each categories as cat}
              <option value={cat.id}>{categoryLabel(cat)}</option>
            {/each}
          </select>
          {#if detectingDepth}
            <p class="cam-form-hint">Estimating depth from the CAD file...</p>
          {:else if detectedDepthInches != null}
            <p class="cam-form-hint depth-hint">
              Detected depth from CAD: <strong>{detectedDepthInches.toFixed(detectedDepthInches < 0.1 ? 4 : 3)}"</strong> - pick the material/thickness that matches.
            </p>
          {/if}
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="part-quantity">Quantity</label>
          <input id="part-quantity" type="number" min="1" class="form-input" bind:value={newPart.quantity} />
        </div>
        <div class="form-group">
          <label class="form-label" for="part-manufacturing-link">Manufacturing request (optional)</label>
          <select id="part-manufacturing-link" class="form-select" bind:value={newPart.manufacturingPartId} on:change={handleManufacturingLinkChange}>
            <option value="">Not linked to a request</option>
            {#each manufacturingParts as mp}
              <option value={mp.id}>{mp.name}{mp.project_id ? ` (${mp.project_id})` : ''}</option>
            {/each}
          </select>
          <p class="cam-form-hint">Traces this stock back to the real request it's for - leave unlinked for ad-hoc/prototype stock. Linking one carries its STEP file over automatically.</p>
        </div>
      </div>
      <div class="form-row form-row-final">
        <div class="form-group">
          <label class="form-label" for="part-project-id">Project ID (optional)</label>
          <input id="part-project-id" class="form-input" list="part-project-ids" bind:value={newPart.projectId} />
          <datalist id="part-project-ids">{#each [...new Set(manufacturingParts.map((part) => part.project_id).filter(Boolean))].sort() as projectId}<option value={projectId} />{/each}</datalist>
        </div>
      </div>
      <div class="cam-list-actions">
        <button class="btn btn-primary" disabled={submitting} on:click={handleAddPart}>{submitting ? 'Adding...' : (quickQueueMode ? 'Add & Continue to Queue' : 'Add Part')}</button>
        <button type="button" class="btn btn-secondary" disabled={submitting} on:click={handleCancelAddPart}>Cancel</button>
      </div>
    </div>
  {/if}

  {#if partsByCreatedAt.length === 0}
    <p class="empty-state">No parts yet. {canManage ? 'Add one above to get started.' : 'Ask a manufacturing lead to add one.'}</p>
  {:else}
    <div class="filters tab-filters">
      <div class="form-group">
        <label class="form-label" for="parts-search">Search</label>
        <input
          id="parts-search"
          type="search"
          class="form-input"
          placeholder="Search parts by name, project, or material..."
          bind:value={partsListSearch}
          aria-label="Search parts"
        />
      </div>
      <div class="form-group">
        <label class="form-label" for="parts-project-filter"><Filter size={14} /> Project</label>
        <select id="parts-project-filter" class="form-select" bind:value={filterProject}>
          <option value="">All Projects</option>
          {#each projectIds as pid}<option value={pid}>{pid}</option>{/each}
        </select>
      </div>
      <SeasonFilter options={seasonOptions} bind:value={filterSeason} />
    </div>
    {#if filteredPartsByCreatedAt.length === 0}
      <p class="empty-state">No parts match "{partsListSearch}".</p>
    {/if}
    {#if canManage && filteredPartsByCreatedAt.length > 0}
      <div class="bulk-select-bar">
        <label class="bulk-select-all">
          <input
            type="checkbox"
            checked={visibleSelectedCount > 0 && visibleSelectedCount === filteredPartsByCreatedAt.length}
            indeterminate={visibleSelectedCount > 0 && visibleSelectedCount < filteredPartsByCreatedAt.length}
            on:change={toggleSelectAllParts}
          />
          {visibleSelectedCount > 0 ? `${visibleSelectedCount} selected` : 'Select all'}
        </label>
        {#if visibleSelectedCount > 0}
          <button type="button" class="btn btn-ghost btn-sm" disabled={bulkDeletingParts} on:click={handleBulkDeleteParts}>
            <Trash2 size={14} /> {bulkDeletingParts ? 'Deleting...' : `Delete ${visibleSelectedCount} selected`}
          </button>
        {/if}
      </div>
    {/if}
    {#each [{ key: 'all-parts', parts: filteredPartsByCreatedAt }] as group (group.key)}
      <section class="stock-group">
          <div class="cam-list">
            {#each group.parts as part (part.id)}
              <div class="card cam-list-item">
                <div class="cam-list-header">
                  <span class="cam-list-header-left">
                    {#if canManage}
                      <input
                        type="checkbox"
                        class="bulk-select-checkbox"
                        checked={selectedPartIds.has(part.id)}
                        on:change={() => togglePartSelected(part.id)}
                        aria-label={`Select ${part.name}`}
                      />
                    {/if}
                    {#if renamingPartId === part.id}
                      <span class="rename-control">
                        <Package size={16} />
                        <input
                          class="form-input rename-input"
                          bind:value={renamePartValue}
                          on:keydown={(e) => { if (e.key === 'Enter') saveRenamePart(part); if (e.key === 'Escape') cancelRenamePart(); }}
                        />
                        <button type="button" class="btn btn-ghost btn-sm" title="Save" on:click={() => saveRenamePart(part)}><Check size={14} /></button>
                        <button type="button" class="btn btn-ghost btn-sm" title="Cancel" on:click={cancelRenamePart}><X size={14} /></button>
                      </span>
                    {:else}
                      <span class="rename-control">
                        <strong><Package size={16} /> {part.name}</strong>
                        {#if canManage}
                          <button type="button" class="btn btn-ghost btn-sm" title="Rename" on:click={() => startRenamePart(part)}><Pencil size={13} /></button>
                        {/if}
                      </span>
                    {/if}
                  </span>
                  <span class="cam-list-header-right">
                    <span class="tag">{categoryLabel(part.fusion_part_categories)}</span>
                    {#if completedPartIds.has(part.id)}
                      <span class="tag tag-completed"><Check size={13} /> Completed</span>
                    {:else}
                      <span class="tag tag-pending">Pending</span>
                    {/if}
                  </span>
                </div>
                <p class="cam-form-hint">
                  {#if editingQuantityId === part.id}
                    <span class="rename-control quantity-control">
                      Quantity:
                      <input
                        type="number"
                        min="0"
                        step="1"
                        class="form-input rename-input quantity-input"
                        bind:value={quantityValue}
                        on:keydown={(e) => { if (e.key === 'Enter') saveQuantity(part); if (e.key === 'Escape') cancelEditQuantity(); }}
                      />
                      <button type="button" class="btn btn-ghost btn-sm" title="Save" on:click={() => saveQuantity(part)}><Check size={14} /></button>
                      <button type="button" class="btn btn-ghost btn-sm" title="Cancel" on:click={cancelEditQuantity}><X size={14} /></button>
                    </span>
                  {:else}
                    <span class="rename-control quantity-control">
                      Quantity: {part.original_quantity}
                      {#if canManage}
                        <button type="button" class="btn btn-ghost btn-sm" title="Edit quantity" on:click={() => startEditQuantity(part)}><Pencil size={13} /></button>
                      {/if}
                    </span>
                  {/if}
                  {#if part.epic} - {part.epic}{/if}
                  {#if part.ticket} - {part.ticket}{/if}
                  {#if part.project_id} - project <strong>{part.project_id}</strong>{/if}
                  {#if part.stock_assignment} - stock <strong>{part.stock_assignment}</strong>{/if}
                  {#if part.parts} - linked to <strong>{part.parts.name}</strong>{/if}
                  {#if part.fusion_file_name} - Fusion file name: <strong>{part.fusion_file_name}</strong>{/if}
                  {#if part.created_at} - added {formatPacificDateTime(part.created_at)}{/if}
                </p>
                <div class="cam-list-actions">
                  {#if part.parts}
                    <a class="btn btn-secondary btn-sm" href="/manufacture?part={part.part_id}">
                      <LinkIcon size={14} /> View manufacturing request
                    </a>
                  {/if}
                  {#if part.step_file_name}
                    <button class="btn btn-secondary btn-sm" on:click={() => (cadModalPart = part)}>
                      <Box size={14} /> View CAD
                    </button>
                    <button class="btn btn-secondary btn-sm" on:click={() => handleInstallCad(part)}>
                      <Download size={14} /> Install CAD
                    </button>
                  {/if}
                  {#if canManage}
                    <button class="btn btn-secondary btn-sm" on:click={() => openAttachStepModal(part)}>
                      <Upload size={14} /> {part.step_file_name ? 'Replace STEP' : 'Attach STEP'}
                    </button>
                    <button class="btn btn-ghost btn-sm" on:click={() => handleDeletePart(part)}>
                      <Trash2 size={14} /> Delete
                    </button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
      </section>
    {/each}
  {/if}
{/if}

{#if canManage && queuePickerOpen}
  <div class="modal-overlay" role="presentation" on:click={closeQueuePicker}>
    <div class="modal queue-picker-modal" role="dialog" aria-labelledby="queue-picker-title" on:click|stopPropagation>
      <div class="modal-header">
        <h3 id="queue-picker-title">Send to Fusion CAM</h3>
        <div class="modal-header-actions">
          <button type="button" class="btn btn-ghost btn-sm" disabled={!hasQueuePickerFilters} on:click={clearQueuePickerFilters}>
            <FilterX size={15} /> Clear filters
          </button>
          <button type="button" class="btn btn-ghost btn-sm" title="Close" on:click={closeQueuePicker}><X size={16} /></button>
        </div>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="queue-picker-date">Parts created on</label>
            <div class="date-with-clear">
              <input id="queue-picker-date" type="date" class="form-input" bind:value={queuePickerDate} />
              {#if queuePickerDate}
                <button type="button" class="btn btn-ghost btn-sm" on:click={() => (queuePickerDate = '')}>Show all dates</button>
              {:else}
                <span class="cam-form-hint">All dates</span>
              {/if}
            </div>
          </div>
          <div class="form-group">
            <label class="form-label" for="queue-picker-category">Stock category</label>
            <select id="queue-picker-category" class="form-select" bind:value={queuePickerCategoryId} on:change={() => (groupedPartsSearch = '')}>
              <option value="">Choose a stock category...</option>
              {#each stockGroups.filter((g) => g.categoryId && queueableParts(g).length) as g}
                <option value={g.categoryId}>{categoryLabel(g.category)}</option>
              {/each}
            </select>
          </div>
        </div>
        {#if queuePickerDate && !stockGroups.some((g) => g.categoryId && queueableParts(g).length)}
          <p class="cam-form-hint">No parts were created on this date - try another date or "Show all dates".</p>
        {/if}
        {#if queueableByCreatedAt.length}
          <div class="recent-queue-picker">
            <div class="recent-queue-header">
              <span class="form-label">
                {#if recentPartsSearchTerm}
                  Search results
                {:else if selectedQueuePickerCategory}
                  Recent parts in {categoryLabel(selectedQueuePickerCategory)}
                {:else}
                  Recent parts
                {/if}
              </span>
              <input
                type="search"
                class="form-input recent-queue-search"
                placeholder="Search parts by name..."
                bind:value={recentPartsSearch}
                aria-label="Search recent parts by name"
              />
            </div>
            {#if recentQueueableParts.length}
              <div class="recent-queue-grid">
                {#each recentQueueableParts as part}
                  {@const isSelected = selectedRecentPartIds.has(String(part.id))}
                  <button
                    type="button"
                    class="recent-queue-button"
                    class:selected={isSelected}
                    aria-pressed={isSelected}
                    title={part.name}
                    on:click={() => selectRecentPart(part)}
                  >
                    <span class="recent-queue-name">
                      {#if isSelected}<Check size={12} />{/if}{part.name}
                    </span>
                    <span class="recent-queue-detail">{categoryLabel(part.fusion_part_categories)} &middot; qty {part.original_quantity}</span>
                  </button>
                {/each}
              </div>
            {:else}
              <p class="cam-form-hint">No parts match "{recentPartsSearch}".</p>
            {/if}
          </div>
        {/if}
        {#if queuePickerCategoryId}
          {@const group = stockGroups.find((g) => g.categoryId === queuePickerCategoryId)}
          {#if group}
            {@const queueable = queueableParts(group)}
            <div class="form-row">
              <div class="form-group">
                <label class="form-label" for={`queue-mode-${group.categoryId}`}>CAM mode</label>
                <select id={`queue-mode-${group.categoryId}`} class="form-select" bind:value={categoryQueueModes[group.categoryId]} aria-label="CAM mode for {categoryLabel(group.category)}">
                  <option value="">Choose CAM mode...</option>
                  <option value="single">Single part</option>
                  <option value="grouped" disabled={queueable.length < 2}>Grouped ({queueable.length} part types)</option>
                </select>
              </div>
            </div>
            {#if categoryQueueModes[group.categoryId] === 'single'}
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label" for={`queue-single-part-${group.categoryId}`}>Part</label>
                  <select id={`queue-single-part-${group.categoryId}`} class="form-select" bind:value={categorySinglePartSelections[group.categoryId]} on:change={() => handleSinglePartPick(group)}>
                    <option value="">{queueable.length ? 'Choose a part...' : 'No parts available'}</option>
                    {#each queueable as part}
                      <option value={part.id}>{part.name} (qty {part.original_quantity})</option>
                    {/each}
                  </select>
                </div>
                {#if categorySinglePartSelections[group.categoryId]}
                  {@const chosenPart = group.parts.find((p) => p.id === categorySinglePartSelections[group.categoryId])}
                  <div class="form-group">
                    <label class="form-label" for={`queue-single-qty-${group.categoryId}`}>Quantity</label>
                    <input id={`queue-single-qty-${group.categoryId}`} type="number" min="1" max={chosenPart ? maximumQueueQuantity(group, chosenPart) : undefined} step="1" class="form-input" bind:value={categorySinglePartQuantities[group.categoryId]} />
                  </div>
                {/if}
              </div>
            {:else if categoryQueueModes[group.categoryId] === 'grouped'}
              {@const selectedIds = categoryGroupedPartSelections[group.categoryId] || []}
              {@const selectedCount = selectedIds.length}
              {@const totalPieces = selectedIds.reduce((sum, id) => sum + (Number(categoryGroupedPartQuantities[group.categoryId]?.[id]) || 0), 0)}
              {@const displayedQueueable = groupedPartsSearchTerm
                ? queueable.filter((part) => part.name?.toLowerCase().includes(groupedPartsSearchTerm))
                : queueable.filter((part, index) => index < 6 || selectedIds.includes(part.id))}
              <fieldset class="group-part-picker">
                <legend>Select parts for grouped CAM</legend>
                <div class="group-part-summary">
                  <span>
                    {#if selectedCount}
                      {selectedCount} of {queueable.length} part {selectedCount === 1 ? 'type' : 'types'} selected &middot; {totalPieces} piece{totalPieces === 1 ? '' : 's'} total
                    {:else}
                      No parts selected yet
                    {/if}
                  </span>
                  <div class="group-part-summary-actions">
                    <button type="button" class="btn btn-ghost btn-sm" on:click={() => selectAllGroupedParts(group, queueable)} disabled={selectedCount === queueable.length}>Select all</button>
                    <button type="button" class="btn btn-ghost btn-sm" on:click={() => clearGroupedParts(group)} disabled={!selectedCount}>Clear</button>
                  </div>
                </div>
                {#if queueable.length > 6}
                  <input
                    type="search"
                    class="form-input group-part-search"
                    placeholder="Search this category's parts by name..."
                    bind:value={groupedPartsSearch}
                    aria-label="Search this stock category's parts by name"
                  />
                {/if}
                <div class="group-part-grid">
                  {#each displayedQueueable as part}
                    {@const checked = selectedIds.includes(part.id)}
                    <div class="group-part-card" class:selected={checked}>
                      <button
                        type="button"
                        class="group-part-toggle"
                        aria-pressed={checked}
                        on:click={() => toggleGroupedPart(group, part)}
                      >
                        <span class="group-part-check"><Check size={13} /></span>
                        <span class="group-part-info">
                          <span class="group-part-name">{part.name}</span>
                          <span class="group-part-available">qty {part.original_quantity}</span>
                        </span>
                      </button>
                      {#if checked}
                        <label class="group-part-qty">
                          Qty
                          <input
                            type="number"
                            min="1"
                            max={maximumQueueQuantity(group, part)}
                            step="1"
                            class="form-input grouped-qty-input"
                            aria-label="Quantity of {part.name}"
                            bind:value={categoryGroupedPartQuantities[group.categoryId][part.id]}
                          />
                        </label>
                      {/if}
                    </div>
                  {/each}
                </div>
                {#if groupedPartsSearchTerm && !displayedQueueable.length}
                  <p class="cam-form-hint">No parts match "{groupedPartsSearch}".</p>
                {:else if queueable.length < 2}
                  <p class="cam-form-hint">Only {queueable.length} part {queueable.length === 1 ? 'type is' : 'types are'} available for this date filter - try "Show all dates" above to see more parts to group.</p>
                {/if}
              </fieldset>
            {/if}
            <div class="form-row">
              <div class="form-group">
                <label class="form-label" for={`queue-router-${group.categoryId}`}>Router</label>
                <select id={`queue-router-${group.categoryId}`} class="form-select" value={categoryMachineSelections[group.categoryId]} on:change={(e) => handleMachineChange(group.categoryId, e.currentTarget.value)}>
                  <option value={undefined}>Choose a router...</option>
                  {#each machines as m}
                    <option value={m.id}>{m.name}</option>
                  {/each}
                </select>
              </div>
              {#if !isNewRouter(categoryMachineSelections[group.categoryId]) || categorySingleToolModes[group.categoryId] || !canUseAutoMultiTool(group, categoryMachineSelections[group.categoryId])}
                <div class="form-group">
                  <label class="form-label" for={`queue-tool-${group.categoryId}`}>Tool</label>
                  <select id={`queue-tool-${group.categoryId}`} class="form-select" bind:value={categoryToolSelections[group.categoryId]} disabled={!categoryMachineSelections[group.categoryId]}>
                    <option value="">{toolsForMachine(categoryMachineSelections[group.categoryId]).length ? 'Choose a tool...' : 'No tools installed'}</option>
                    {#each toolsForMachine(categoryMachineSelections[group.categoryId]).filter((tool) => !isNewRouter(categoryMachineSelections[group.categoryId]) || isEndmill(tool)) as t}
                      <option
                        value={t.id}
                        disabled={isNewRouter(categoryMachineSelections[group.categoryId]) && !toolHasReviewedPresetForGroup(t, group)}
                      >
                        {toolLabel(t)}{isNewRouter(categoryMachineSelections[group.categoryId]) && !toolHasReviewedPresetForGroup(t, group) ? ' (no preset for this material)' : ''}
                      </option>
                    {/each}
                  </select>
                </div>
              {:else}
                <div class="form-group">
                  <span class="form-label">Tool</span>
                  <p class="cam-form-hint queue-tool-auto-note">Chosen automatically - see Auto multi-tool below.</p>
                </div>
              {/if}
            </div>
            {#if isNewRouter(categoryMachineSelections[group.categoryId])}
              <div class="form-group queue-tool-mode">
                <div class="queue-tool-mode-header">
                  <span class="form-label">Tool mode</span>
                  <button type="button" class="btn btn-ghost btn-sm" on:click={() => openAtcModal(categoryMachineSelections[group.categoryId])}>
                    <Wrench size={14} /> ATC Slots
                  </button>
                </div>
                {#if canUseAutoMultiTool(group, categoryMachineSelections[group.categoryId])}
                  <div class="segmented-control" aria-label="Tool mode for New Router">
                    <button type="button" class:active={categorySingleToolModes[group.categoryId]} on:click={() => (categorySingleToolModes = { ...categorySingleToolModes, [group.categoryId]: true })}>Single tool</button>
                    <button type="button" class:active={!categorySingleToolModes[group.categoryId]} on:click={() => {
                      categorySingleToolModes = { ...categorySingleToolModes, [group.categoryId]: false };
                      categoryToolSelections = { ...categoryToolSelections, [group.categoryId]: '' };
                    }}>Auto multi-tool</button>
                  </div>
                  <p class="cam-form-hint">Auto multi-tool considers every loaded cutter, then uses only the high-throughput cutter and any smaller cutter required for detail. Unused candidates do not create a tool swap.</p>
                {:else}
                  <p class="cam-form-hint">Single-tool CAM uses the loaded 971 Main Bit. Tool swaps are available only for Aluminum 6061.</p>
                {/if}
              </div>
            {/if}
          {/if}
        {/if}
      </div>
      <div class="modal-footer-actions">
        <button class="btn btn-ghost" type="button" on:click={closeQueuePicker}>Cancel</button>
        {#if queuePickerCategoryId}
          {@const group = stockGroups.find((g) => g.categoryId === queuePickerCategoryId)}
          <button class="btn btn-primary" type="button" disabled={!group || queueing[queuePickerCategoryId] || !!queueValidationError(group)} on:click={() => openQueueModal(group)}>
            <Send size={14} /> Queue {categoryQueueModes[queuePickerCategoryId] === 'grouped' ? 'Grouped ' : ''}CAM Job
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<AtcSlotConfig
  bind:open={showAtcModal}
  machineId={atcModalMachineId}
  machineName={atcModalMachineName}
  tools={atcTools}
  userId={user?.id || null}
  on:applied={() => load(false)}
  on:toolsChanged={() => load(false)}
/>

{#if cadModalPart}
  <div class="modal-backdrop" on:click|self={() => (cadModalPart = null)} role="button" tabindex="0"
       on:keydown={(e) => { if (e.key === 'Escape') (cadModalPart = null); }}>
    <div class="modal cad-modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h3>CAD Preview - {cadModalPart.name}</h3>
        <button type="button" class="modal-close-button" aria-label="Close" on:click={() => (cadModalPart = null)}><X size={18} /></button>
      </div>
      <div class="modal-body">
        <CadViewer part={null} stepFileName={cadModalPart.step_file_name} />
        <p class="cam-form-hint">Drag to rotate &middot; scroll to zoom &middot; right-drag to pan</p>
      </div>
    </div>
  </div>
{/if}

{#if attachStepModalPart}
  <div class="modal-overlay" role="presentation" on:click={closeAttachStepModal}>
    <div class="modal" role="dialog" aria-labelledby="attach-step-title" on:click|stopPropagation>
      <div class="modal-header">
        <h3 id="attach-step-title">{attachStepModalPart.step_file_name ? 'Replace' : 'Attach'} STEP file - {attachStepModalPart.name}</h3>
        <button type="button" class="btn btn-ghost btn-sm" title="Close" on:click={closeAttachStepModal}><X size={16} /></button>
      </div>
      <div class="modal-body">
        {#if attachStepModalPart.step_file_name}
          <p class="cam-form-hint">This part already has a STEP file. Choosing a new one replaces it - the old file is not automatically removed from storage.</p>
        {/if}
        <div class="form-group">
          <label class="form-label" for="attach-step-input">STEP file</label>
          <input
            id="attach-step-input"
            type="file"
            accept=".step,.stp"
            class="form-input"
            on:change={(e) => (attachStepFile = e.currentTarget.files?.[0] || null)}
          />
        </div>
      </div>
      <div class="modal-footer-actions">
        <button class="btn btn-ghost" type="button" on:click={closeAttachStepModal}>Cancel</button>
        <button class="btn btn-primary" type="button" disabled={attachingStep || !attachStepFile} on:click={saveAttachStep}>
          <Upload size={14} /> {attachingStep ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if queueModalPlate}
  <div class="modal-overlay" role="presentation" on:click={closeQueueModal}>
    <div class="modal queue-modal" role="dialog" aria-labelledby="queue-modal-title" on:click|stopPropagation>
      <div class="modal-header">
        <h3 id="queue-modal-title">Queue "{queueModalLabel}"</h3>
        <button type="button" class="btn btn-ghost btn-sm" title="Close" on:click={closeQueueModal}><X size={16} /></button>
      </div>
      <div class="modal-body">
        <p class="cam-form-hint">This saves a new Fusion document for the job. Name it and pick where it goes - both default to something reasonable if you skip them.</p>
        <div class="form-group">
          <label class="form-label" for="queue-file-name">Fusion file name</label>
          <input
            id="queue-file-name"
            class="form-input"
            value={queueFileName}
            on:input={(e) => (queueFileName = e.currentTarget.value.replace(/\s+/g, ''))}
            placeholder="e.g. GearboxSidePlate"
          />
          <p class="cam-form-hint">No spaces - this becomes the saved document's name in Fusion's Data Panel.</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="queue-tab-count">Release tab count <span class="text-muted">(optional)</span></label>
          <input
            id="queue-tab-count"
            class="form-input"
            type="number"
            min={TAB_COUNT_MIN}
            max={TAB_COUNT_MAX}
            step="1"
            bind:value={queueTabCount}
            placeholder="Automatic"
          />
          <p class="cam-form-hint">Overrides the automatic tab count ({TAB_COUNT_MIN}-{TAB_COUNT_MAX}) for this job - leave blank to size tabs from the part automatically. Too many tabs adds real cutting time for no real stability benefit; only ask for more than the automatic default if a specific part needs it.</p>
        </div>
        <div class="form-group">
          <div class="folder-picker-header">
            <span class="form-label">Save to folder</span>
            {#if folderTreeRow?.tree}
              <input
                type="search"
                class="form-input folder-search"
                placeholder="Search folders..."
                bind:value={folderSearch}
                aria-label="Search folders by name"
              />
            {/if}
          </div>
          {#if folderTreeRow?.tree}
            <div class="folder-tree-box">
              {#if folderSearchTerm}
                {#if folderSearchResults.length}
                  {#each folderSearchResults as result (result.path)}
                    <button
                      type="button"
                      class="folder-search-result"
                      class:selected={result.path === queueFolderPath}
                      title={result.path}
                      on:click={() => (queueFolderPath = result.path)}
                    >
                      <Folder size={15} />
                      <span class="folder-search-name">{result.name}</span>
                      <span class="folder-search-path">{result.path}</span>
                    </button>
                  {/each}
                {:else}
                  <p class="cam-form-hint">No folders match "{folderSearch}".</p>
                {/if}
              {:else}
                <FolderTreeNode node={folderTreeRow.tree} selectedPath={queueFolderPath} onSelect={(path) => (queueFolderPath = path)} />
              {/if}
            </div>
            <p class="cam-form-hint">
              {queueFolderPath ? `Selected: ${queueFolderPath}` : "Using the 2026 Season CAM project root - click a folder above to save somewhere else."}
              Folder list as of {new Date(folderTreeRow.synced_at).toLocaleString()}.
            </p>
          {:else}
            <p class="cam-form-hint">No folder list yet - a Fusion Runner needs to have run at least once to share it. This will save to the 2026 Season CAM project root.</p>
          {/if}
        </div>
      </div>
      <div class="modal-footer-actions">
        <button class="btn btn-ghost" type="button" on:click={closeQueueModal}>Cancel</button>
        <button class="btn btn-primary" type="button" disabled={queueSubmitting} on:click={confirmQueue}>
          <Send size={14} /> {queueSubmitting ? 'Queueing…' : 'Queue Job'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .cad-modal { width: min(900px, 94vw); }
  .cad-modal .modal-body { min-height: 60vh; }
  .stock-group { margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid var(--border); }
  .stock-group:first-of-type { margin-top: 1rem; padding-top: 0; border-top: none; }
  .group-header { flex-wrap: wrap; margin-bottom: 0.75rem; }
  .group-header h3 { margin: 0; }
  .recent-queue-picker { margin: 0.75rem 0; }
  .recent-queue-header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
  .recent-queue-search { max-width: 240px; width: 100%; }
  .recent-queue-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.45rem; }
  .recent-queue-button {
    display: grid;
    gap: 0.15rem;
    min-width: 0;
    min-height: 3.6rem;
    padding: 0.5rem 0.6rem;
    text-align: left;
    color: var(--text);
    background: var(--surface-2, #f7f7f5);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 6px);
    cursor: pointer;
  }
  .recent-queue-button { transition: border-color 0.15s, background 0.15s, box-shadow 0.15s; }
  .recent-queue-button:hover, .recent-queue-button:focus-visible { border-color: var(--accent); background: var(--surface); outline: none; }
  .recent-queue-button.selected {
    border-color: var(--accent);
    /* A tint of the theme's own accent rather than a hardcoded color, so
       this reads as "picked" in every Spartans Hub theme instead of just
       the one it was designed against. */
    background: color-mix(in srgb, var(--accent) 12%, var(--primary));
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .recent-queue-name, .recent-queue-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .recent-queue-name { font-weight: 600; font-size: 0.8rem; display: flex; align-items: center; gap: 0.25rem; }
  .recent-queue-detail { color: var(--text-muted); font-size: 0.72rem; }
  @media (max-width: 640px) { .recent-queue-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .tab-actions { margin-bottom: 1rem; display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .tab-filters { margin-bottom: 1rem; --filters-columns: 2fr 1fr 1fr; }
  .form-row { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
  .form-row-final { padding-top: 0.75rem; border-top: 1px solid var(--border); }
  .form-row .form-group { flex: 1; min-width: 160px; }
  .cam-list { display: flex; flex-direction: column; gap: 0.75rem; }
  .cam-list-item { padding: 1rem; }
  .cam-list-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .rename-control { display: flex; align-items: center; gap: 0.35rem; min-width: 0; }
  .rename-input { padding: 0.2rem 0.4rem; height: auto; width: auto; min-width: 10rem; }
  .cam-list-header-left { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
  .cam-list-header-right { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }
  .bulk-select-checkbox { width: 1rem; height: 1rem; flex-shrink: 0; cursor: pointer; }
  .bulk-select-bar { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.5rem 0.75rem; margin-bottom: 0.6rem; border: 1px solid var(--border); border-radius: var(--radius-md, 10px); background: var(--surface-2, #f7f7f5); flex-wrap: wrap; }
  .bulk-select-all { display: flex; align-items: center; gap: 0.5rem; font-size: 0.82rem; font-weight: 500; color: var(--text-muted); cursor: pointer; }
  .bulk-select-all input { width: 1rem; height: 1rem; cursor: pointer; }
  .quantity-control { display: inline-flex; }
  .quantity-input { min-width: 4rem; width: 4rem; }
  .cam-list-actions { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem; flex-wrap: wrap; }
  .group-part-picker { border: 1px solid var(--border); border-radius: var(--radius-md, 10px); padding: 0.85rem 0.9rem; margin: 0 0 0.75rem; background: var(--surface-2, #f7f7f5); }
  .group-part-picker legend { color: var(--text-muted); font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; padding: 0 0.35rem; }
  .group-part-summary { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap; font-size: 0.8rem; font-weight: 500; color: var(--text-muted); margin-bottom: 0.6rem; }
  .group-part-search { height: 2.1rem; padding: 0.3rem 0.6rem; font-size: 0.8rem; margin-bottom: 0.6rem; }
  .group-part-summary-actions { display: flex; gap: 0.3rem; }
  .group-part-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 0.55rem; }
  .group-part-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 8px);
    background: var(--primary);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
    transition: border-color 0.15s, background 0.15s, box-shadow 0.15s, transform 0.1s;
  }
  .group-part-card:hover { border-color: var(--accent); box-shadow: 0 2px 6px rgba(0, 0, 0, 0.06); }
  .group-part-card.selected { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, var(--primary)); box-shadow: 0 2px 6px rgba(0, 0, 0, 0.06); }
  .group-part-toggle {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    width: 100%;
    padding: 0.6rem 0.7rem;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: inherit;
  }
  .group-part-check {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.15rem;
    height: 1.15rem;
    border: 1.5px solid var(--border);
    border-radius: 5px;
    color: transparent;
    background: var(--primary);
    transition: background 0.15s, border-color 0.15s;
  }
  .group-part-card.selected .group-part-check { color: var(--accent-contrast, #fff); background: var(--accent); border-color: var(--accent); }
  .group-part-info { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
  .group-part-name { font-weight: 600; font-size: 0.83rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  .group-part-available { font-size: 0.71rem; color: var(--text-muted); }
  .group-part-qty {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-muted);
    padding: 0 0.7rem 0.6rem;
    border-top: 1px solid var(--border);
    padding-top: 0.5rem;
    margin-top: 0.1rem;
  }
  .grouped-qty-input { min-width: 4rem; width: 4rem; height: var(--control-height, 2.25rem); }
  .empty-state { color: var(--text-muted, #888); padding: 2rem 0; text-align: center; }
  .cam-form-hint { color: var(--text-muted, #888); font-size: 0.85rem; margin: 0.25rem 0 0; }
  .depth-hint strong { color: var(--text, #111); }
  .locked-step-file {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--text-muted, #6b7280);
    background: var(--surface-2, #f3f4f6);
    cursor: not-allowed;
  }
  .prefill-banner {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--accent, #2563eb);
    font-size: 0.85rem;
    margin: 0 0 0.75rem;
  }
  .queue-subsection { margin-top: 1rem; padding-left: 0.75rem; border-left: 2px solid var(--border); }
  .queue-tool-mode { margin-bottom: 0.75rem; }
  .queue-tool-mode-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.35rem; }
  .queue-tool-mode-header .form-label { margin: 0; }
  .queue-tool-auto-note { margin-top: 0.4rem; }
  .segmented-control { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius-sm, 6px); overflow: hidden; }
  .segmented-control button { min-height: 2rem; padding: 0.35rem 0.65rem; border: 0; border-right: 1px solid var(--border); background: var(--surface-2, #f7f7f5); color: var(--text); font: inherit; cursor: pointer; }
  .segmented-control button:last-child { border-right: 0; }
  .segmented-control button.active { background: var(--accent); color: var(--accent-contrast, #fff); }
  .segmented-control button:disabled { color: var(--text-muted); cursor: not-allowed; }
  .queue-subheader { display: flex; align-items: center; gap: 0.4rem; margin: 0 0 0.5rem; font-size: 0.95rem; }
  .queue-modal { max-width: 32rem; }
  .queue-picker-modal { --modal-width: 46rem; }
  .modal-header-actions { display: inline-flex; align-items: center; gap: 0.25rem; }
  .date-with-clear { display: flex; align-items: center; gap: 0.5rem; }
  .date-with-clear .form-input { flex: 1; min-width: 0; }
  .folder-tree-box {
    max-height: 16rem;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.35rem;
  }
  .folder-picker-header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.4rem; }
  .folder-search { max-width: 220px; height: 2rem; padding: 0.25rem 0.5rem; font-size: 0.8rem; }
  .folder-search-result {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    padding: 0.4rem 0.6rem;
    border-radius: var(--radius-sm, 6px);
    cursor: pointer;
    color: var(--text);
    font-size: 0.9rem;
  }
  .folder-search-result:hover { background: var(--surface-2); }
  .folder-search-result.selected { background: var(--accent-soft, rgba(47, 129, 247, 0.14)); color: var(--accent); font-weight: 600; }
  .folder-search-name { flex-shrink: 0; }
  /* The full path is what disambiguates two folders with the same leaf
     name, so it stays visible - but it yields the horizontal space first. */
  .folder-search-path { color: var(--text-muted); font-size: 0.75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
