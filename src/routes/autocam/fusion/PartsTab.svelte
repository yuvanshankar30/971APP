<script>
  import { requestConfirmation } from '$lib/confirmation.js';
  import { onMount } from 'svelte';
  import { toastActions } from '$lib/toast.js';
  import { supabase } from '$lib/supabase.js';
  import {
    fetchParts, createPart, deletePart, renamePart, updatePartQuantity, fetchPartCategories, installFusionPartCad,
    fetchPlates, createPlate, assignPartToPlate, removePartFromPlate, queueFusionJob, fetchFusionFolderTree
  } from '$lib/fusionCam.js';
  import { platePartQuantity } from '$autocam/fusion/grouping.js';
  import { PACIFIC_TIME_ZONE, formatPacificDateTime } from '$lib/timezone.js';
  import { fetchStepMeshes } from '$lib/stepMeshLoader.js';
  import { extractRoutingContoursFromMeshes } from '$autocam/stepProfile.js';
  import CadViewer from '$lib/components/CadViewer.svelte';
  import FolderTreeNode from './FolderTreeNode.svelte';
  import { Plus, Trash2, Package, Pencil, Check, X, Sparkles, Box, Download, Send } from 'lucide-svelte';

  export let user;
  export let canManage;
  // Deep link from Manufacturing's "Open Fusion CAM" button (see
  // /autocam/fusion/+page.svelte) - the id of a public.parts row to
  // pre-fill the Add Part form from: name, STEP file (carried over, not
  // re-uploaded), and a depth estimate read straight off that STEP file's
  // geometry. Material/thickness is deliberately left for the user to pick
  // and cross-check against the detected depth - see handlePrefill below.
  export let initialManufacturingPartId = null;

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
  $: stockGroups = buildStockGroups(parts, plates, categories);

  function buildStockGroups(currentParts, currentPlates, currentCategories) {
    const knownCategories = new Map(currentCategories.map((category) => [String(category.id), category]));
    const groups = new Map();
    function groupFor(key, category) {
      if (!groups.has(key)) groups.set(key, { key, categoryId: category ? String(category.id) : null, category: category || null, parts: [], plates: [], remainingQuantity: 0 });
      return groups.get(key);
    }
    for (const part of currentParts) {
      const categoryId = part.category_id == null ? null : String(part.category_id);
      const category = knownCategories.get(categoryId);
      const group = groupFor(category ? `category:${categoryId}` : `unresolved-part:${part.id}`, category);
      group.parts.push(part);
      const quantity = Number(part.quantity);
      if (Number.isSafeInteger(quantity) && quantity > 0) group.remainingQuantity += quantity;
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
  let loading = true;

  let showAddPartForm = false;
  let newPart = { name: '', epic: '', ticket: '', quantity: 1, categoryId: '', manufacturingPartId: '', fusionFileName: '' };
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
  // match the rest of the app's date conventions) - defaults to today
  // each time the popup opens, clearable to see every part regardless of
  // when it was added.
  let queuePickerOpen = false;
  let queuePickerCategoryId = '';
  let queuePickerDate = '';

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
    queuePickerDate = pacificDateKey(new Date());
  }

  function closeQueuePicker() {
    queuePickerOpen = false;
    queuePickerCategoryId = '';
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
      .select('id, name, project_id, workflow, file_name, file_url')
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
      manufacturingPartId: linkedPart.id
    };
    if (!newPart.fusionFileName) {
      const derived = (linkedPart.name || '').trim().replace(/\s+/g, '');
      if (derived) newPart.fusionFileName = derived;
    }
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
        .select('id, name, project_id, workflow, file_name, file_url')
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
      await loadManufacturingParts();
      const { data: machineRows } = await supabase.from('cam_machines').select('*').eq('can_run_plates', true).eq('enabled', true).order('name');
      machines = machineRows || [];
      const { data: machineToolRows } = await supabase
        .from('cam_machine_tools')
        .select('machine_id, cam_tools(id, name, diameter, tool_type)')
        .in('machine_id', machines.map((m) => m.id));
      machineTools = {};
      for (const row of machineToolRows || []) {
        if (!row.cam_tools) continue;
        (machineTools[row.machine_id] ||= []).push(row.cam_tools);
      }
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

  // Picking a router pre-selects that machine's default tool (if it's
  // actually installed on it) rather than leaving the tool blank - same
  // "profile picks reasonable defaults, human can still override" pattern
  // applyMachineDefaults() uses on the main /autocam page. Clears the
  // selection if the previous tool isn't valid for the newly-picked router.
  function handleMachineChange(categoryId, machineId) {
    categoryMachineSelections = { ...categoryMachineSelections, [categoryId]: machineId };
    const eligible = toolsForMachine(machineId);
    const machine = machines.find((m) => String(m.id) === String(machineId));
    const stillValid = eligible.some((t) => String(t.id) === String(categoryToolSelections[categoryId]));
    if (!stillValid) {
      const defaultTool = eligible.find((t) => String(t.id) === String(machine?.default_tool_id));
      categoryToolSelections = { ...categoryToolSelections, [categoryId]: defaultTool?.id || '' };
    }
  }

  function handleFileChange(event) {
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
  }

  // Strips spaces as you type rather than rejecting on submit - this
  // becomes the Fusion document name (see camPlate.py), which treats it as
  // one filename token. Matches the DB check constraint.
  function handleFusionFileNameInput(event) {
    newPart.fusionFileName = event.target.value.replace(/\s+/g, '');
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
    try {
      await createPart({
        name: newPart.name,
        epic: newPart.epic,
        ticket: newPart.ticket,
        quantity: Number(newPart.quantity),
        categoryId: newPart.categoryId,
        stepFile,
        createdBy: user?.id,
        partId: newPart.manufacturingPartId || null,
        fusionFileName: newPart.fusionFileName || null
      });
      newPart = { name: '', epic: '', ticket: '', quantity: 1, categoryId: '', manufacturingPartId: '', fusionFileName: '' };
      stepFile = null;
      stepCarriedOverFrom = null;
      detectedDepthInches = null;
      showAddPartForm = false;
      await load(false);
      toastActions.show('Part added - send it to Fusion CAM from its stock group below');
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
    newPart = { name: '', epic: '', ticket: '', quantity: 1, categoryId: '', manufacturingPartId: '', fusionFileName: '' };
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

  // How much of this part is already committed to a pending/queued Fusion
  // job in this stock group - summed across the group's plate(s), which in
  // practice is always zero or one plate now (see resolveCategoryPlateId).
  // Kept as a sum rather than assuming exactly one plate so a category that
  // somehow still has more than one plate (pre-existing data from before
  // this change) reports correctly instead of silently undercounting.
  function committedQuantity(group, part) {
    return group.plates.reduce((sum, plate) => sum + platePartQuantity(plate, part), 0);
  }

  function maximumQueueQuantity(group, part) {
    return Number(part.quantity) + committedQuantity(group, part);
  }

  // Parts a human can still pick for a CAM job from this stock group -
  // either stock still remains, or some is already committed (so its
  // quantity can be adjusted rather than the part disappearing from the
  // picker the moment it's fully committed).
  function queueableParts(group) {
    return group.parts.filter((part) =>
      (Number(part.quantity) > 0 || committedQuantity(group, part) > 0)
      && (!queuePickerDate || pacificDateKey(part.created_at) === queuePickerDate)
    );
  }

  // Flattened list of { part, quantity, plateId } already committed to a
  // job in this group, for the "already queued" chips and their remove
  // buttons - the only remaining trace of "plates" a human ever sees, and
  // only as a quantity + a way to undo it, never a name or size to manage.
  function committedParts(group) {
    const rows = [];
    for (const plate of group.plates) {
      for (const assignment of plate.fusion_part_category_assignments || []) {
        const part = group.parts.find((p) => p.id === assignment.fusion_parts?.id) || assignment.fusion_parts;
        if (part) rows.push({ part, quantity: assignment.quantity, plateId: plate.id });
      }
    }
    return rows;
  }

  async function handleRemoveCommitted(plateId, part) {
    if (!await requestConfirmation({ title: 'Remove from queue', message: `Remove ${part.name} from the Fusion CAM queue for this stock group?`, confirmLabel: 'Remove', danger: true })) return;
    try {
      await removePartFromPlate({ plateId, partId: part.id });
      await load(false);
      toastActions.show(`${part.name} removed from the queue`);
    } catch (e) {
      toastActions.show(e.message || 'Failed to remove from the queue');
    }
  }

  function handleSinglePartPick(group) {
    const categoryId = group.categoryId;
    const part = group.parts.find((p) => p.id === categorySinglePartSelections[categoryId]);
    if (!part) return;
    const remaining = Number(part.quantity);
    categorySinglePartQuantities = {
      ...categorySinglePartQuantities,
      [categoryId]: remaining > 0 ? remaining : (committedQuantity(group, part) || 1)
    };
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
      const remaining = Number(part.quantity);
      quantities[part.id] = remaining > 0 ? remaining : (committedQuantity(group, part) || 1);
    }
    categoryGroupedPartSelections = { ...categoryGroupedPartSelections, [categoryId]: [...selected] };
    categoryGroupedPartQuantities = { ...categoryGroupedPartQuantities, [categoryId]: quantities };
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
    // originally was before routers were made explicit too.
    if (!categoryToolSelections[categoryId]) return 'Choose a tool before queueing';
    const mode = categoryQueueModes[categoryId];
    if (!['single', 'grouped'].includes(mode)) return 'Choose single-part or grouped CAM';
    if (mode === 'single') {
      const partId = categorySinglePartSelections[categoryId];
      if (!partId) return 'Choose a part for single-part CAM';
      const quantity = Number(categorySinglePartQuantities[categoryId]);
      if (!Number.isInteger(quantity) || quantity <= 0) return 'Quantity must be a whole number greater than zero';
      const part = group.parts.find((p) => p.id === partId);
      if (part && quantity > maximumQueueQuantity(group, part)) return `Only ${maximumQueueQuantity(group, part)} of ${part.name} is available`;
    }
    if (mode === 'grouped') {
      const selected = categoryGroupedPartSelections[categoryId] || [];
      if (selected.length < 2) return 'Select at least two part types for grouped CAM';
      for (const partId of selected) {
        const quantity = Number(categoryGroupedPartQuantities[categoryId]?.[partId]);
        if (!Number.isInteger(quantity) || quantity <= 0) return 'Every selected part needs a whole-number quantity greater than zero';
        const part = group.parts.find((p) => p.id === partId);
        if (part && quantity > maximumQueueQuantity(group, part)) return `Only ${maximumQueueQuantity(group, part)} of ${part.name} is available`;
      }
    }
    return null;
  }

  // The one plate a stock category ever has, created transparently on
  // first use with the same sizing convention the placeholder-stock
  // migration seeded for every category that existed before this change -
  // a human never names or sizes it.
  async function resolveCategoryPlateId(group) {
    if (group.plates[0]) return group.plates[0].id;
    const created = await createPlate({
      name: `Auto stock - ${categoryLabel(group.category)}`,
      width: 24,
      length: 24,
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
      if (mode === 'single') {
        const partId = categorySinglePartSelections[categoryId];
        const quantity = Number(categorySinglePartQuantities[categoryId]);
        await assignPartToPlate({ categoryId, plateId, partId, quantity });
      } else {
        const selected = categoryGroupedPartSelections[categoryId] || [];
        for (const partId of selected) {
          const quantity = Number(categoryGroupedPartQuantities[categoryId]?.[partId]);
          await assignPartToPlate({ categoryId, plateId, partId, quantity });
        }
      }
      await load(false);
      const refreshedGroup = buildStockGroups(parts, plates, categories).find((g) => g.categoryId === categoryId) || group;
      queueModalPlate = refreshedGroup.plates.find((p) => p.id === plateId) || { id: plateId };
      queueModalCategoryId = categoryId;
      queueModalLabel = mode === 'single'
        ? (refreshedGroup.parts.find((p) => p.id === categorySinglePartSelections[categoryId])?.name || categoryLabel(group.category))
        : categoryLabel(group.category);
      queueFileName = queueModalLabel.replace(/\s+/g, '');
      queueFolderPath = '';
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
  }

  async function confirmQueue() {
    const plate = queueModalPlate;
    const categoryId = queueModalCategoryId;
    if (!plate || !categoryId || queueSubmitting) return;
    const mode = categoryQueueModes[categoryId];
    const selectedPartId = mode === 'single' ? categorySinglePartSelections[categoryId] : null;
    const selectedPartIds = mode === 'grouped' ? (categoryGroupedPartSelections[categoryId] || []) : null;
    queueSubmitting = true;
    try {
      await queueFusionJob({
        fusionJobKind: 'plate:cam',
        plateId: plate.id,
        machineId: categoryMachineSelections[categoryId],
        // The real cam_materials id, NOT plate.category_id (a
        // fusion_part_categories id) - cam_jobs.material_id has a foreign
        // key straight to cam_materials, so passing the category id here
        // would fail the insert outright with a foreign-key violation any
        // time the plate actually has a valid category.
        materialId: plate.fusion_part_categories?.material_id || null,
        toolId: categoryToolSelections[categoryId] || null,
        groupingMode: mode,
        selectedPartId,
        selectedPartIds,
        requestedBy: user?.id,
        name: `${mode === 'grouped' ? 'Grouped Fusion CAM' : 'Fusion CAM'}: ${queueModalLabel}`,
        fusionFileName: queueFileName.trim() || null,
        fusionFolderPath: queueFolderPath || null
      });
      toastActions.show('Queued for the Fusion Runner');
      categoryQueueModes = { ...categoryQueueModes, [categoryId]: '' };
      categorySinglePartSelections = { ...categorySinglePartSelections, [categoryId]: '' };
      categoryGroupedPartSelections = { ...categoryGroupedPartSelections, [categoryId]: [] };
      closeQueueModal();
    } catch (e) {
      toastActions.show(e.message || 'Failed to queue job');
    } finally {
      queueSubmitting = false;
    }
  }
</script>

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
        <h3>New Part</h3>
        <button type="button" class="btn btn-ghost btn-sm" title="Close" aria-label="Close without adding a part" on:click={handleCancelAddPart}><X size={16} /></button>
      </div>
      <p class="cam-form-hint">A named quantity of stock waiting to be sent to Fusion CAM.</p>
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
        <div class="form-group">
          <label class="form-label" for="part-quantity">Quantity</label>
          <input id="part-quantity" type="number" min="1" class="form-input" bind:value={newPart.quantity} />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="part-epic">Epic (optional)</label>
          <input id="part-epic" class="form-input" bind:value={newPart.epic} />
        </div>
        <div class="form-group">
          <label class="form-label" for="part-ticket">Ticket (optional)</label>
          <input id="part-ticket" class="form-input" bind:value={newPart.ticket} />
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
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="part-fusion-file-name">Fusion file name (optional, no spaces)</label>
          <input
            id="part-fusion-file-name"
            class="form-input"
            value={newPart.fusionFileName}
            on:input={handleFusionFileNameInput}
            placeholder="e.g. GearboxSidePlate"
          />
          <p class="cam-form-hint">Used as the saved Fusion document name instead of the default job-name default.</p>
        </div>
      </div>
      <div class="form-row">
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
      <div class="cam-list-actions">
        <button class="btn btn-primary" disabled={submitting} on:click={handleAddPart}>{submitting ? 'Adding...' : 'Add Part'}</button>
        <button type="button" class="btn btn-ghost" disabled={submitting} on:click={handleCancelAddPart}>Cancel</button>
      </div>
    </div>
  {/if}

  {#if stockGroups.length === 0}
    <p class="empty-state">No parts yet. {canManage ? 'Add one above to get started.' : 'Ask a manufacturing lead to add one.'}</p>
  {:else}
    {#each stockGroups as group (group.key)}
      <section class="stock-group">
        <div class="cam-list-header group-header">
          <div>
            <h3>{group.category ? categoryLabel(group.category) : 'Stock category unavailable'}</h3>
            <p class="cam-form-hint">{group.parts.length} part types &middot; {group.remainingQuantity} remaining to queue</p>
          </div>
        </div>

        {#if group.parts.length === 0}
          <p class="cam-form-hint">No parts in this stock group yet.</p>
        {:else}
          <div class="cam-list">
            {#each group.parts as part (part.id)}
              <div class="card cam-list-item">
                <div class="cam-list-header">
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
                  <span class="tag">{categoryLabel(part.fusion_part_categories)}</span>
                </div>
                <p class="cam-form-hint">
                  {#if editingQuantityId === part.id}
                    <span class="rename-control quantity-control">
                      Total needed:
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
                      {part.original_quantity} needed total - {part.quantity} remaining to queue
                      {#if part.original_quantity - part.quantity > 0}
                        ({part.original_quantity - part.quantity} already queued)
                      {/if}
                      {#if canManage}
                        <button type="button" class="btn btn-ghost btn-sm" title="Edit total quantity needed" on:click={() => startEditQuantity(part)}><Pencil size={13} /></button>
                      {/if}
                    </span>
                  {/if}
                  {#if part.epic} - {part.epic}{/if}
                  {#if part.ticket} - {part.ticket}{/if}
                  {#if part.parts} - linked to <strong>{part.parts.name}</strong>{/if}
                  {#if part.fusion_file_name} - Fusion file name: <strong>{part.fusion_file_name}</strong>{/if}
                  {#if part.created_at} - added {formatPacificDateTime(part.created_at)}{/if}
                </p>
                <div class="cam-list-actions">
                  {#if part.step_file_name}
                    <button class="btn btn-secondary btn-sm" on:click={() => (cadModalPart = part)}>
                      <Box size={14} /> View CAD
                    </button>
                    <button class="btn btn-secondary btn-sm" on:click={() => handleInstallCad(part)}>
                      <Download size={14} /> Install CAD
                    </button>
                  {/if}
                  {#if canManage}
                    <button class="btn btn-ghost btn-sm" on:click={() => handleDeletePart(part)}>
                      <Trash2 size={14} /> Delete
                    </button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}

        {#if group.categoryId && committedParts(group).length}
          <div class="queue-subsection">
            <h4 class="queue-subheader"><Send size={15} /> Fusion CAM</h4>
            <div class="cam-list-actions">
              <span class="cam-form-hint">Already queued:</span>
              {#each committedParts(group) as row}
                <span class="cam-form-hint">{row.quantity}x {row.part.name}</span>
                {#if canManage}
                  <button class="btn btn-ghost btn-sm" type="button" title="Remove {row.part.name} from the queue" aria-label="Remove {row.part.name} from the queue" on:click={() => handleRemoveCommitted(row.plateId, row.part)}>×</button>
                {/if}
              {/each}
            </div>
          </div>
        {/if}
      </section>
    {/each}
  {/if}
{/if}

{#if canManage && queuePickerOpen}
  <div class="modal-overlay" role="presentation" on:click={closeQueuePicker}>
    <div class="modal queue-picker-modal" role="dialog" aria-labelledby="queue-picker-title" on:click|stopPropagation>
      <div class="modal-header">
        <h3 id="queue-picker-title">Send to Fusion CAM</h3>
        <button type="button" class="btn btn-ghost btn-sm" title="Close" on:click={closeQueuePicker}><X size={16} /></button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="queue-picker-date">Parts created on</label>
            <div class="date-with-clear">
              <input id="queue-picker-date" type="date" class="form-input" bind:value={queuePickerDate} />
              <button type="button" class="btn btn-ghost btn-sm" disabled={!queuePickerDate} on:click={() => (queuePickerDate = '')}>Show all dates</button>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label" for="queue-picker-category">Stock category</label>
            <select id="queue-picker-category" class="form-select" bind:value={queuePickerCategoryId}>
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
                      <option value={part.id}>{part.name} ({part.quantity} remaining)</option>
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
              <fieldset class="group-part-picker">
                <legend>Select parts for grouped CAM</legend>
                {#each queueable as part}
                  {@const checked = (categoryGroupedPartSelections[group.categoryId] || []).includes(part.id)}
                  <label>
                    <input type="checkbox" {checked} on:change={() => toggleGroupedPart(group, part)} />
                    {part.name}
                  </label>
                  {#if checked}
                    <input
                      type="number"
                      min="1"
                      max={maximumQueueQuantity(group, part)}
                      step="1"
                      class="form-input grouped-qty-input"
                      aria-label="Quantity of {part.name}"
                      bind:value={categoryGroupedPartQuantities[group.categoryId][part.id]}
                    />
                  {/if}
                {/each}
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
              <div class="form-group">
                <label class="form-label" for={`queue-tool-${group.categoryId}`}>Tool</label>
                <select id={`queue-tool-${group.categoryId}`} class="form-select" bind:value={categoryToolSelections[group.categoryId]} disabled={!categoryMachineSelections[group.categoryId]}>
                  <option value="">{toolsForMachine(categoryMachineSelections[group.categoryId]).length ? 'Choose a tool...' : 'No tools installed on this router'}</option>
                  {#each toolsForMachine(categoryMachineSelections[group.categoryId]) as t}
                    <option value={t.id}>{toolLabel(t)}</option>
                  {/each}
                </select>
              </div>
            </div>
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
          <span class="form-label">Save to folder</span>
          {#if folderTreeRow?.tree}
            <div class="folder-tree-box">
              <FolderTreeNode node={folderTreeRow.tree} selectedPath={queueFolderPath} onSelect={(path) => (queueFolderPath = path)} />
            </div>
            <p class="cam-form-hint">
              {queueFolderPath ? `Selected: ${queueFolderPath}` : "Using the default AutoCAM folder - click a folder above to save somewhere else."}
              Folder list as of {new Date(folderTreeRow.synced_at).toLocaleString()}.
            </p>
          {:else}
            <p class="cam-form-hint">No folder list yet - a Fusion Runner needs to have run at least once to share it. This will save to the default AutoCAM folder.</p>
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
  .tab-actions { margin-bottom: 1rem; display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .form-row { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
  .form-row .form-group { flex: 1; min-width: 160px; }
  .cam-list { display: flex; flex-direction: column; gap: 0.75rem; }
  .cam-list-item { padding: 1rem; }
  .cam-list-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .rename-control { display: flex; align-items: center; gap: 0.35rem; min-width: 0; }
  .rename-input { padding: 0.2rem 0.4rem; height: auto; width: auto; min-width: 10rem; }
  .quantity-control { display: inline-flex; }
  .quantity-input { min-width: 4rem; width: 4rem; }
  .cam-list-actions { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem; flex-wrap: wrap; }
  .group-part-picker { display: flex; align-items: center; gap: 0.65rem; flex-wrap: wrap; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0.4rem 0.6rem; }
  .group-part-picker legend { color: var(--text-muted); font-size: 0.75rem; padding: 0 0.25rem; }
  .group-part-picker label { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.85rem; }
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
  .queue-subheader { display: flex; align-items: center; gap: 0.4rem; margin: 0 0 0.5rem; font-size: 0.95rem; }
  .queue-modal { max-width: 32rem; }
  .queue-picker-modal { --modal-width: 46rem; }
  .date-with-clear { display: flex; align-items: center; gap: 0.5rem; }
  .date-with-clear .form-input { flex: 1; min-width: 0; }
  .folder-tree-box {
    max-height: 16rem;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.35rem;
  }
</style>
