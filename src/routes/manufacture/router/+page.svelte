<script>
  import { onMount } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { page } from '$app/stores';
  import { userStore, loadUserFromUUID } from '$lib/stores/user.js';
  import { Package, GripVertical, Download, ChevronUp, ChevronDown, Calendar, Eye, Pencil, AlertCircle, X } from 'lucide-svelte';
  import { getDisplayStatus, BUTTONS } from '$lib/statuses.js';
  import { getRouterStageCounts, summarizeRouterStages, isFullyCut, isFullyKitted, advanceRouterStageCounts, buildRouterProgressUpdate } from '$lib/router_progress.js';
  import { isManufacturingLead } from '$lib/permissions.js';
  import stockData from '$lib/stock.json';
  import { formatPacificDate } from '$lib/timezone.js';

  // ==================== State ====================
  let parts = [];
  let loading = true;
  let groupMap = {};
  let useDedicatedTables = true;
  let user = null;
  $: canCamReview = isManufacturingLead(user);

  // Edit Mode vs View Mode
  let editMode = false;

  // The subtab determines router vs postprocessing — driven by local state

  // Drag-and-drop state
  let dragPart = null;
  let dragOverTarget = null;

  // Group editing state
  let editingGroupId = null;
  let editingGroupName = '';

  // Stock options from stock.json
  const routerStockOptions = stockData.router || [];

  // Two machines
  const MACHINES = ['UNC Router', 'ShopSabre'];

  // Machine color map
  const MACHINE_COLORS = {
    'UNC Router': { bg: 'var(--blue-soft)', text: 'var(--blue-strong)', border: 'var(--blue-base)' },
    'ShopSabre': { bg: 'var(--purple-soft)', text: 'var(--purple-strong)', border: 'var(--purple-base, #9c27b0)' }
  };

  // Stock color map — color by material type
  function getStockColor(stock) {
    if (!stock) return { bg: 'var(--surface-2)', text: 'var(--text-muted)', border: 'var(--border)' };
    const s = stock.toLowerCase();
    if (s.includes('polycarbonate')) return { bg: 'var(--blue-soft)', text: 'var(--blue-strong)', border: 'var(--blue-base)' };
    if (s.includes('tube')) return { bg: 'var(--green-soft)', text: 'var(--green-strong)', border: 'var(--green-base)' };
    // Aluminum sheets (default for router)
    return { bg: 'var(--brand-gold-soft)', text: 'var(--brand-gold-strong)', border: 'var(--brand-gold-base)' };
  }

  function getMachineColor(machine) {
    return MACHINE_COLORS[machine] || { bg: 'var(--surface-2)', text: 'var(--text-muted)', border: 'var(--border)' };
  }

  // ==================== Helper Functions ====================
  function parseMeta(part) {
    try { return JSON.parse(part.file_url || '{}') || {}; } catch { return {}; }
  }

  function getStatusColors(status) {
    if (status === BUTTONS.JPROGGED || status === 'Jprogged') return { bg: 'var(--green-soft)', text: 'var(--green-strong)', border: 'var(--green-base)' };
    if (status === BUTTONS.MACHINED || status === 'Machined') return { bg: 'var(--blue-soft)', text: 'var(--blue-strong)', border: 'var(--blue-base)' };
    if (status === BUTTONS.CAM_REVIEWED || status === 'CAM Reviewed') return { bg: 'var(--purple-soft)', text: 'var(--purple-strong)', border: 'var(--purple-base, #9c27b0)' };
    return { bg: 'var(--brand-gold-soft)', text: 'var(--brand-gold-strong)', border: 'var(--brand-gold-base)' };
  }

  async function updateMeta(part, updates) {
    let root = {};
    try { root = JSON.parse(part.file_url || '{}') || {}; } catch { root = {}; }
    root = { ...root, ...updates };
    await supabase.from('parts').update({ file_url: JSON.stringify(root), updated_at: new Date().toISOString() }).eq('id', part.id);
  }

  function groupIsCut(g) {
    if (!g || !g.parts || g.parts.length === 0) return false;
    return g.parts.every((p) => isFullyCut(p));
  }

  function groupIsKitted(g) {
    if (!g || !g.parts || g.parts.length === 0) return false;
    return g.parts.every((p) => isFullyKitted(p));
  }

  function getGroupDisplayStatus(g) {
    if (g.status) return g.status;
    if (!g || !g.parts || g.parts.length === 0) return BUTTONS.PENDING;
    if (groupIsCut(g)) return BUTTONS.MACHINED;
    const allTravis = g.parts.every((p) => {
      const counts = getRouterStageCounts(p);
      const queued = counts.queued || 0;
      const total = p.quantity || 1;
      return queued >= total;
    });
    if (allTravis) return BUTTONS.JPROGGED;
    const allCammed = g.parts.every((p) => {
      const counts = getRouterStageCounts(p);
      const cammed = counts.cammed || 0;
      const total = p.quantity || 1;
      return cammed >= total;
    });
    if (allCammed) return BUTTONS.CAM_REVIEWED;
    return BUTTONS.PENDING;
  }

  function getGroupMismatches(g) {
    const mismatches = { status: null, stock: null };
    if (!g || !g.parts || g.parts.length <= 1) return mismatches;
    const groupStatus = g.status || getGroupDisplayStatus(g);
    const groupStock = g.stock || '';
    const statusMismatchParts = g.parts.filter(p => {
      const partStatus = getDisplayStatus(p.status, parseMeta(p));
      return partStatus !== groupStatus;
    });
    if (statusMismatchParts.length > 0 && statusMismatchParts.length < g.parts.length) {
      const minorityStatus = getDisplayStatus(statusMismatchParts[0].status, parseMeta(statusMismatchParts[0]));
      mismatches.status = { count: statusMismatchParts.length, label: minorityStatus };
    }
    const stockMismatchParts = g.parts.filter(p => (p.stock_assignment || '') !== groupStock);
    if (stockMismatchParts.length > 0 && stockMismatchParts.length < g.parts.length) {
      mismatches.stock = { count: stockMismatchParts.length, label: stockMismatchParts[0].stock_assignment || 'None' };
    }
    return mismatches;
  }

  // Auto-fill stock based on most common among parts
  function getMostCommonValue(items, key) {
    const counts = {};
    for (const item of items) {
      const val = item[key] || '';
      if (val) counts[val] = (counts[val] || 0) + 1;
    }
    let best = '';
    let bestCount = 0;
    for (const [val, count] of Object.entries(counts)) {
      if (count > bestCount) { bestCount = count; best = val; }
    }
    return best;
  }

  function getPartStageCount(part, stage) {
    return getRouterStageCounts(part)[stage] || 0;
  }

  function updatePartInGroups(partId, updates) {
    let changed = false;
    const nextGroupMap = {};

    for (const [groupId, group] of Object.entries(groupMap)) {
      let groupChanged = false;
      const nextParts = group.parts.map((part) => {
        if (part.id !== partId) return part;
        groupChanged = true;
        changed = true;
        return { ...part, ...updates };
      });

      nextGroupMap[groupId] = groupChanged ? { ...group, parts: nextParts } : group;
    }

    if (changed) {
      groupMap = nextGroupMap;
    }
  }

  function updateGroupInMap(gid, updates) {
    const group = groupMap[gid];
    if (!group) return;
    groupMap = {
      ...groupMap,
      [gid]: { ...group, ...updates }
    };
  }

  async function movePartStage(part, fromStage, toStage) {
    if (fromStage === 'cam_review' && toStage === 'cammed' && !canCamReview) {
      alert('Only manufacturing leads can CAM review parts.');
      return;
    }

    const nextCounts = advanceRouterStageCounts(part, fromStage, toStage, 1);
    if (!nextCounts) return;
    const update = buildRouterProgressUpdate(part, nextCounts);

    const { error } = await supabase
      .from('parts')
      .update(update)
      .eq('id', part.id);

    if (error) {
      console.error('Failed to update router part progress', error);
      alert('Failed to update router part progress.');
      return;
    }

    updatePartInGroups(part.id, update);
  }

  // ==================== Data Loading ====================
  async function loadParts() {
    loading = true;
    const { data, error } = await supabase
      .from('parts')
      .select('*')
      .eq('workflow', 'router')
      .order('created_at', { ascending: false });

    if (!error) {
      parts = (data || []).filter(p => {
        if (p.status === 'complete' || p.status === 'kitted') return false;
        return true;
      });
    }

    await loadGroups();
    loading = false;
  }

  async function loadGroups() {
    if (useDedicatedTables) {
      const { data: groups, error: gErr } = await supabase
        .from('router_groups')
        .select('id, name, created_at, machine, material, status, stock, queue_position, target_date, post_processing_stage')
        .order('queue_position', { ascending: true, nullsFirst: false });

      const { data: links, error: lErr } = await supabase
        .from('router_group_parts')
        .select('group_id, part_id');

      if (gErr || lErr) {
        console.log('Failed to load dedicated tables, falling back to JSON', { gErr, lErr });
        useDedicatedTables = false;
        buildGroupsFromJSON();
      } else {
        const gmap = {};
        (groups || []).forEach(g => {
          gmap[g.id] = {
            id: g.id,
            name: g.name || g.id,
            parts: [],
            machine: g.machine || '',
            material: g.material || '',
            status: g.status || '',
            stock: g.stock || '',
            queue_position: g.queue_position ?? 999,
            target_date: g.target_date || null,
            post_processing_stage: g.post_processing_stage || null
          };
        });

        const { data: allRouterParts } = await supabase
          .from('parts')
          .select('*')
          .eq('workflow', 'router');

        const partById = Object.fromEntries((allRouterParts || []).map(p => [p.id, p]));
        (links || []).forEach(l => {
          if (gmap[l.group_id] && partById[l.part_id]) {
            gmap[l.group_id].parts.push(partById[l.part_id]);
          }
        });

        // Auto-fill stock/material for groups that don't have them set
        for (const g of Object.values(gmap)) {
          if (!g.stock && g.parts.length > 0) {
            g.stock = getMostCommonValue(g.parts, 'stock_assignment');
          }
        }

        groupMap = gmap;
      }
    } else {
      buildGroupsFromJSON();
    }
  }

  function buildGroupsFromJSON() {
    groupMap = {};
    for (const p of parts) {
      const meta = parseMeta(p);
      if (meta.router_group_id) {
        if (!groupMap[meta.router_group_id]) {
          groupMap[meta.router_group_id] = {
            id: meta.router_group_id,
            name: meta.router_group_name || meta.router_group_id,
            parts: [],
            machine: '',
            material: '',
            status: '',
            stock: '',
            queue_position: 999,
            target_date: null,
            post_processing_stage: null
          };
        }
        groupMap[meta.router_group_id].parts.push(p);
      }
    }
  }

  // ==================== Computed Values ====================
  $: groupedIdSet = new Set(Object.values(groupMap).flatMap((g) => g.parts.map((p) => p.id)));
  $: ungroupedParts = parts.filter((p) => !groupedIdSet.has(p.id));

  // Router groups: not yet cut
  $: routerGroups = Object.values(groupMap)
    .filter(g => g.parts.length > 0 && !groupIsCut(g))
    .sort((a, b) => (a.queue_position ?? 999) - (b.queue_position ?? 999));

  // Per-machine status summaries for View Mode
  $: machineGroups = (() => {
    const result = {};
    for (const machine of MACHINES) {
      const groups = routerGroups.filter(g => g.machine === machine);
      const cutting = groups.find(g =>
        g.status === BUTTONS.JPROGGED || getGroupDisplayStatus(g) === BUTTONS.JPROGGED
      ) || (groups.length > 0 ? groups[0] : null);
      const upNext = groups.find(g => g !== cutting) || null;
      result[machine] = { cutting, upNext };
    }
    // Also include unassigned machine groups
    const unassigned = routerGroups.filter(g => !g.machine || !MACHINES.includes(g.machine));
    if (unassigned.length > 0) {
      result['Unassigned'] = {
        cutting: unassigned[0] || null,
        upNext: unassigned.length > 1 ? unassigned[1] : null
      };
    }
    return result;
  })();

  // ==================== Group Actions ====================
  function getStock(part) {
    return part.stock_assignment || '';
  }

  function makeGroupName(part) {
    const base = (getStock(part).split(' ')[0] || 'Group').replace(/[^A-Za-z0-9]/g, '');
    const rand = Math.floor(10 + Math.random() * 90);
    return `${base}${rand}`;
  }

  async function saveGroupName(gid) {
    if (!gid) return;
    const newName = editingGroupName.trim();
    if (!newName) { editingGroupId = null; editingGroupName = ''; return; }
    let saved = false;
    try {
      if (useDedicatedTables) {
        await supabase.from('router_groups').update({ name: newName }).eq('id', gid);
      } else {
        const group = groupMap[gid];
        if (group) {
          for (const p of group.parts) {
            const meta = parseMeta(p);
            meta.router_group_name = newName;
            await supabase.from('parts').update({ file_url: JSON.stringify(meta), updated_at: new Date().toISOString() }).eq('id', p.id);
          }
        }
      }
      saved = true;
    } catch (e) {
      console.error('Rename failed', e);
      alert('Failed to rename group');
    } finally {
      editingGroupId = null;
      editingGroupName = '';
      if (saved) {
        updateGroupInMap(gid, { name: newName });
      }
    }
  }

  async function updateGroupField(gid, field, value) {
    if (!useDedicatedTables) return;
    try {
      await supabase.from('router_groups').update({ [field]: value }).eq('id', gid);
      updateGroupInMap(gid, { [field]: value });
    } catch (e) {
      console.error(`Failed to update ${field}`, e);
    }
  }

  async function moveGroupInQueue(gid, direction) {
    const groups = [...routerGroups];
    const idx = groups.findIndex(g => g.id === gid);
    if (idx === -1) return;
    const newIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= groups.length) return;
    const temp = groups[idx];
    groups[idx] = groups[newIdx];
    groups[newIdx] = temp;
    try {
      for (let i = 0; i < groups.length; i++) {
        await supabase.from('router_groups').update({ queue_position: i }).eq('id', groups[i].id);
      }
      const nextGroupMap = { ...groupMap };
      for (let i = 0; i < groups.length; i++) {
        const group = nextGroupMap[groups[i].id];
        if (group) {
          nextGroupMap[groups[i].id] = { ...group, queue_position: i };
        }
      }
      groupMap = nextGroupMap;
    } catch (e) {
      console.error('Failed to reorder queue', e);
    }
  }

  // ==================== Drag and Drop ====================
  function handleDragStart(event, part) {
    dragPart = part;
    event.dataTransfer.effectAllowed = 'move';
  }

  function handleDragOver(event, target) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    dragOverTarget = target;
  }

  function handleDragLeave() {
    dragOverTarget = null;
  }

  async function handleDropOnGroup(event, group) {
    event.preventDefault();
    event.stopPropagation(); // don't bubble to the panel's "create new group" drop
    dragOverTarget = null;
    if (!dragPart) return;
    await addPartToGroup(dragPart, group.id);
    dragPart = null;
    await loadParts();
  }

  async function handleDropOnPart(event, targetPart) {
    event.preventDefault();
    event.stopPropagation(); // don't bubble to the panel's "create new group" drop
    dragOverTarget = null;
    if (!dragPart || dragPart.id === targetPart.id) return;
    const targetGroupId = findGroupIdForPart(targetPart);
    const dragGroupId = findGroupIdForPart(dragPart);
    if (useDedicatedTables) {
      if (!targetGroupId && !dragGroupId) {
        const newId = crypto.randomUUID();
        const autoStock = getMostCommonValue([targetPart, dragPart], 'stock_assignment');
        await supabase.from('router_groups').insert({
          id: newId,
          name: makeGroupName(targetPart),
          queue_position: routerGroups.length,
          stock: autoStock
        });
        await supabase.from('router_group_parts').insert([
          { group_id: newId, part_id: targetPart.id },
          { group_id: newId, part_id: dragPart.id }
        ]);
      } else if (targetGroupId && !dragGroupId) {
        await addPartToGroup(dragPart, targetGroupId);
      } else if (!targetGroupId && dragGroupId) {
        await addPartToGroup(targetPart, dragGroupId);
      } else if (targetGroupId && dragGroupId && targetGroupId !== dragGroupId) {
        await supabase.from('router_group_parts').delete().match({ group_id: dragGroupId, part_id: dragPart.id });
        await addPartToGroup(dragPart, targetGroupId);
      }
    }
    dragPart = null;
    await loadParts();
  }

  async function handleDropOnEmptySpace(event) {
    event.preventDefault();
    dragOverTarget = null;
    if (!dragPart) return;
    if (useDedicatedTables) {
      const newId = crypto.randomUUID();
      await supabase.from('router_groups').insert({
        id: newId,
        name: makeGroupName(dragPart),
        queue_position: routerGroups.length,
        stock: dragPart.stock_assignment || ''
      });
      await supabase.from('router_group_parts').insert({ group_id: newId, part_id: dragPart.id });
    }
    dragPart = null;
    await loadParts();
  }

  async function addPartToGroup(part, groupId) {
    if (!useDedicatedTables) return;
    await supabase.from('router_group_parts').delete().match({ part_id: part.id });
    const { data: existing } = await supabase.from('router_group_parts').select('*').match({ group_id: groupId, part_id: part.id });
    if (!existing || existing.length === 0) {
      await supabase.from('router_group_parts').insert({ group_id: groupId, part_id: part.id });
    }
  }

  function findGroupIdForPart(part) {
    for (const g of Object.values(groupMap)) {
      if (g.parts.some(p => p.id === part.id)) return g.id;
    }
    return null;
  }

  async function removeFromGroup(part) {
    if (useDedicatedTables) {
      let gid = findGroupIdForPart(part);
      await supabase.from('router_group_parts').delete().match({ part_id: part.id });
      if (gid) {
        const { count } = await supabase.from('router_group_parts').select('part_id', { count: 'exact', head: true }).eq('group_id', gid);
        if (!count || count === 0) {
          await supabase.from('router_groups').delete().eq('id', gid);
        }
      }
    }
    await loadParts();
  }

  // ==================== Download Functions ====================
  async function downloadStepFromOnshape(part) {
    try {
      const params = new URLSearchParams({
        action: 'translate-part',
        documentId: part.onshape_document_id,
        elementId: part.onshape_element_id,
        partId: part.onshape_part_id,
        wvm: part.onshape_wvm || 'v',
        wvmId: part.onshape_wvmid,
        format: 'STEP'
      });
      const resp = await fetch(`/api/onshape?${params}`);
      if (!resp.ok) throw new Error('Onshape STEP download failed');
      const blob = await resp.blob();
      const fname = `${(part.name || 'part').replace(/[^A-Za-z0-9]/g, '_')}.step`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = fname; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch (e) { throw e; }
  }

  async function downloadDXFFromOnshape(part) {
    try {
      const params = new URLSearchParams({
        action: 'convert-to-dxf',
        documentId: part.onshape_document_id,
        elementId: part.onshape_element_id,
        partId: part.onshape_part_id,
        wvm: part.onshape_wvm || 'v',
        wvmId: part.onshape_wvmid
      });
      const resp = await fetch(`/api/onshape?${params}`);
      if (!resp.ok) throw new Error('Onshape DXF download failed');
      const blob = await resp.blob();
      const fname = `${(part.name || 'part').replace(/[^A-Za-z0-9]/g, '_')}.dxf`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = fname; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch (e) { throw e; }
  }

  async function downloadFromStorage(fileName) {
    try {
      let { data, error } = await supabase.storage.from('manufacturing-files').createSignedUrl(fileName, 60);
      if (error) throw error;
      window.open(data.signedUrl, '_blank');
    } catch (e) { throw e; }
  }

  // ==================== Group Status Change ====================
  // Map each selectable status to the router stage it should set on every part.
  const STATUS_TO_STAGE = {
    [BUTTONS.PENDING]: 'pending',
    [BUTTONS.IN_PROGRESS]: 'cam_ing',
    [BUTTONS.CAM_REVIEW_PENDING]: 'cam_review',
    [BUTTONS.CAM_REVIEWED]: 'cammed',
    [BUTTONS.POSTPROCESSED]: 'postprocessed',
    [BUTTONS.JPROGGED]: 'queued',
    [BUTTONS.MACHINED]: 'cut',
    [BUTTONS.KITTED]: 'kitted'
  };

  async function handleGroupStatusChange(gid, newStatus) {
    await updateGroupField(gid, 'status', newStatus);
    const group = groupMap[gid];
    if (!group) return;
    const stage = STATUS_TO_STAGE[newStatus];
    if (!stage) return;
    for (const p of group.parts) {
      const update = buildRouterProgressUpdate(p, { [stage]: p.quantity || 1 });
      await supabase.from('parts').update(update).eq('id', p.id);
      updatePartInGroups(p.id, update);
    }
  }

  function getGroupSummary(g) {
    if (!g || !g.parts) return '';
    const stockDesc = g.stock || g.parts[0]?.stock_assignment || '';
    const totalQty = g.parts.reduce((sum, part) => sum + (part.quantity || 1), 0);
    return `${stockDesc}${stockDesc ? ' · ' : ''}${totalQty} qty`;
  }

  // ==================== Lifecycle ====================
  onMount(async () => {
    const unsub = userStore.subscribe((value) => {
      user = value;
    });
    await loadUserFromUUID(supabase);
    await loadParts();
    return unsub;
  });
</script>

<svelte:head><title>Router Management</title></svelte:head>

<div class="page-header">
  <h1>Router</h1>
  <div class="page-actions">
    <button
      type="button"
      class="btn {editMode ? 'btn-primary' : 'btn-secondary'}"
      on:click={() => editMode = !editMode}
    >
      {#if editMode}
        <Eye size={16} />
        View Mode
      {:else}
        <Pencil size={16} />
        Edit Mode
      {/if}
    </button>
  </div>
</div>

<div class="subtabs subtabs-tight">
  <a href="/manufacture" class:active={$page.url.pathname === '/manufacture'}>ToDo</a>
  <a href="/manufacture/completed" class:active={$page.url.pathname === '/manufacture/completed'}>Completed</a>
  <a href="/manufacture/router" class:active={$page.url.pathname === '/manufacture/router'}>Router</a>
  <a href="/manufacture/post-processing" class:active={$page.url.pathname === '/manufacture/post-processing'}>Post Processing</a>
  <a href="/manufacture/bins" class:active={$page.url.pathname === '/manufacture/bins'}>Bins</a>
  <a href="/manufacture/gcode-converter" class:active={$page.url.pathname === '/manufacture/gcode-converter'}>G-code Converter</a>
  <a href="/manufacture/files" class:active={$page.url.pathname === '/manufacture/files'}>Files</a>
</div>

{#if loading}
  <div class="card"><p>Loading...</p></div>
{:else}

  <!-- ==================== ROUTER VIEW ==================== -->
    <!-- View Mode: Per-Machine Status Summary -->
    {#if !editMode}
      <div class="machine-status-grid">
        {#each Object.entries(machineGroups) as [machine, data]}
          {@const mc = getMachineColor(machine)}
          <div class="card machine-section">
            <div class="machine-header" style="border-left: 3px solid {mc.border};">
              <span class="machine-name">{machine}</span>
            </div>
            <div class="machine-status-cards">
              <div class="status-summary-card">
                <span class="status-label">Cutting</span>
                {#if data.cutting}
                  <span class="status-group-name">{data.cutting.name}</span>
                  <span class="status-group-meta">{getGroupSummary(data.cutting)}</span>
                  {#if data.cutting.target_date}
                    <span class="status-target-date">
                      <Calendar size={12} />
                      {formatPacificDate(data.cutting.target_date)}
                    </span>
                  {/if}
                {:else}
                  <span class="text-muted">—</span>
                {/if}
              </div>
              <div class="status-summary-card">
                <span class="status-label">Up Next</span>
                {#if data.upNext}
                  <span class="status-group-name">{data.upNext.name}</span>
                  <span class="status-group-meta">{getGroupSummary(data.upNext)}</span>
                  {#if data.upNext.target_date}
                    <span class="status-target-date">
                      <Calendar size={12} />
                      {formatPacificDate(data.upNext.target_date)}
                    </span>
                  {/if}
                {:else}
                  <span class="text-muted">—</span>
                {/if}
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <div class="router-layout" class:edit-mode={editMode}>
      <!-- Edit Mode: Left Panel - Ungrouped Parts Bank -->
      {#if editMode}
        <div class="card ungrouped-bank">
          <h2 class="section-title">Ungrouped Parts</h2>
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="ungrouped-list"
            role="list"
            on:dragover={(e) => { e.preventDefault(); }}
            on:drop={handleDropOnEmptySpace}
          >
            {#each ungroupedParts as part (part.id)}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="ungrouped-part"
                role="listitem"
                draggable="true"
                on:dragstart={(e) => handleDragStart(e, part)}
                class:dragging={dragPart?.id === part.id}
              >
                <GripVertical size={14} class="drag-handle" />
                <span class="part-name">{part.name}</span>
              </div>
            {:else}
              <p class="text-muted" style="text-align:center; padding: var(--space-4); font-size: var(--font-xs);">All parts are grouped</p>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Groups Panel -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="groups-panel"
        class:panel-drag-over={editMode && dragOverTarget === '__new_group__'}
        on:dragover={(e) => { if (editMode && dragPart) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; dragOverTarget = '__new_group__'; } }}
        on:dragleave={handleDragLeave}
        on:drop={(e) => editMode && handleDropOnEmptySpace(e)}
      >
        <h2 class="section-title">Router Queue</h2>

        {#if routerGroups.length === 0}
          <div class="empty-state">
            <Package size={32} />
            <h3>No Router Groups</h3>
            <p>{editMode ? 'Drag parts together to create groups.' : 'Switch to Edit Mode to create groups.'}</p>
          </div>
        {:else}
          <div class="groups-list">
            {#each routerGroups as g, idx (g.id)}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="group-card"
                role="article"
                class:drag-over={dragOverTarget === g.id}
                on:dragover={(e) => handleDragOver(e, g.id)}
                on:dragleave={handleDragLeave}
                on:drop={(e) => handleDropOnGroup(e, g)}
              >
                <div class="group-card-inner">
                  <!-- Left Half: Part List -->
                  <div class="group-parts">
                    <div class="group-header">
                      {#if editingGroupId === g.id}
                        <input
                          class="group-name-input"
                          bind:value={editingGroupName}
                          on:keydown={(e) => { if (e.key === 'Enter') saveGroupName(g.id); else if (e.key === 'Escape') { editingGroupId = null; editingGroupName = ''; } }}
                          on:blur={() => saveGroupName(g.id)}
                        />
                      {:else}
                        <button type="button" class="group-name-btn" on:click={() => { editingGroupId = g.id; editingGroupName = g.name || g.id; }}>
                          {g.name || g.id}
                        </button>
                      {/if}

                      <!-- Mismatch Indicators -->
                      {#if getGroupMismatches(g).status}
                        <span class="mismatch-badge status-mismatch" title="{getGroupMismatches(g).status.count} parts: {getGroupMismatches(g).status.label}">
                          <AlertCircle size={12} />
                          {getGroupMismatches(g).status.count}: {getGroupMismatches(g).status.label}
                        </span>
                      {/if}
                      {#if getGroupMismatches(g).stock}
                        <span class="mismatch-badge stock-mismatch" title="{getGroupMismatches(g).stock.count} parts: {getGroupMismatches(g).stock.label}">
                          <AlertCircle size={12} />
                          {getGroupMismatches(g).stock.count}: {getGroupMismatches(g).stock.label}
                        </span>
                      {/if}
                    </div>

                    <div class="parts-list">
                      {#each g.parts as p (p.id)}
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <div
                          class="part-row"
                          role="listitem"
                          draggable={editMode}
                          on:dragstart={(e) => editMode && handleDragStart(e, p)}
                          on:dragover={(e) => editMode && handleDragOver(e, p.id)}
                          on:dragleave={handleDragLeave}
                          on:drop={(e) => editMode && handleDropOnPart(e, p)}
                          class:drag-over={dragOverTarget === p.id}
                        >
                          {#if editMode}
                            <GripVertical size={12} class="drag-handle" />
                          {/if}
                          <div class="part-content">
                            <span class="part-name">{p.name}</span>
                            <span class="part-progress">{summarizeRouterStages(p)}</span>
                            {#if !editMode}
                              <div class="part-actions-inline">
                                {#if getPartStageCount(p, 'pending') > 0}
                                  <button type="button" class="btn btn-secondary btn-sm" on:click={() => movePartStage(p, 'pending', 'cam_ing')}>Start 1</button>
                                {/if}
                                {#if getPartStageCount(p, 'cam_ing') > 0}
                                  <button type="button" class="btn btn-secondary btn-sm" on:click={() => movePartStage(p, 'cam_ing', 'cam_review')}>CAM Done 1</button>
                                {/if}
                                {#if getPartStageCount(p, 'cam_review') > 0}
                                  {#if canCamReview}
                                    <button type="button" class="btn btn-secondary btn-sm" on:click={() => movePartStage(p, 'cam_review', 'cammed')}>Review 1</button>
                                  {/if}
                                {/if}
                                {#if getPartStageCount(p, 'cammed') > 0}
                                  <button type="button" class="btn btn-secondary btn-sm" on:click={() => movePartStage(p, 'cammed', 'queued')}>Jprogg 1</button>
                                {/if}
                                {#if getPartStageCount(p, 'queued') > 0}
                                  <button type="button" class="btn btn-secondary btn-sm" on:click={() => movePartStage(p, 'queued', 'cut')}>Cut 1</button>
                                {/if}
                              </div>
                            {/if}
                          </div>
                          {#if editMode}
                            <button type="button" class="remove-btn" on:click={() => removeFromGroup(p)} title="Remove from group">
                              <X size={12} />
                            </button>
                          {/if}
                        </div>
                      {/each}
                    </div>
                  </div>

                  <!-- Right Half: Group Metadata -->
                  <div class="group-metadata">
                    <!-- Machine -->
                    <div class="meta-field">
                      <!-- svelte-ignore a11y_label_has_associated_control -->
                      <label class="meta-label">Machine</label>
                      {#if editMode}
                        <select
                          class="form-select"
                          value={g.machine || ''}
                          on:change={(e) => updateGroupField(g.id, 'machine', e.target.value)}
                        >
                          <option value="">Select machine...</option>
                          {#each MACHINES as m}
                            <option value={m}>{m}</option>
                          {/each}
                        </select>
                      {:else}
                        {@const mc = getMachineColor(g.machine)}
                        {#if g.machine}
                          <span class="color-chip" style="background: {mc.bg}; color: {mc.text}; border-color: {mc.border};">
                            {g.machine}
                          </span>
                        {:else}
                          <span class="text-muted">—</span>
                        {/if}
                      {/if}
                    </div>

                    <!-- Stock -->
                    <div class="meta-field">
                      <!-- svelte-ignore a11y_label_has_associated_control -->
                      <label class="meta-label">Material / Stock</label>
                      {#if editMode}
                        <select
                          class="form-select"
                          value={g.stock || ''}
                          on:change={(e) => updateGroupField(g.id, 'stock', e.target.value)}
                        >
                          <option value="">Select stock...</option>
                          {#each routerStockOptions as opt}
                            <option value={opt.description}>{opt.description}</option>
                          {/each}
                        </select>
                      {:else}
                        {@const sc = getStockColor(g.stock)}
                        {#if g.stock}
                          <span class="color-chip" style="background: {sc.bg}; color: {sc.text}; border-color: {sc.border};">
                            {g.stock}
                          </span>
                        {:else}
                          <span class="text-muted">—</span>
                        {/if}
                      {/if}
                    </div>

                    <!-- Status -->
                    <div class="meta-field">
                      <!-- svelte-ignore a11y_label_has_associated_control -->
                      <label class="meta-label">Status</label>
                      {#each [g.status || getGroupDisplayStatus(g)] as currentStatus}
                        {@const statusColors = getStatusColors(currentStatus)}
                        <select
                          class="form-select group-status-select"
                          style="background: {statusColors.bg}; color: {statusColors.text}; border-color: {statusColors.border};"
                          value={currentStatus}
                          on:change={(e) => handleGroupStatusChange(g.id, e.target.value)}
                        >
                          <option value={BUTTONS.PENDING}>{BUTTONS.PENDING}</option>
                          <option value={BUTTONS.IN_PROGRESS}>{BUTTONS.IN_PROGRESS}</option>
                          <option value={BUTTONS.CAM_REVIEW_PENDING}>{BUTTONS.CAM_REVIEW_PENDING}</option>
                          <option value={BUTTONS.CAM_REVIEWED}>{BUTTONS.CAM_REVIEWED}</option>
                          <option value={BUTTONS.POSTPROCESSED}>{BUTTONS.POSTPROCESSED}</option>
                          <option value={BUTTONS.JPROGGED}>{BUTTONS.JPROGGED}</option>
                          <option value={BUTTONS.MACHINED}>{BUTTONS.MACHINED}</option>
                          <option value={BUTTONS.KITTED}>{BUTTONS.KITTED}</option>
                        </select>
                      {/each}
                    </div>

                    <!-- Target Date -->
                    <div class="meta-field">
                      <!-- svelte-ignore a11y_label_has_associated_control -->
                      <label class="meta-label">Target Date</label>
                      {#if editMode}
                        <input
                          type="date"
                          class="form-input"
                          value={g.target_date || ''}
                          on:change={(e) => updateGroupField(g.id, 'target_date', e.target.value)}
                        />
                      {:else}
                        {#if g.target_date}
                          <span class="meta-value">
                            <Calendar size={12} />
                            {formatPacificDate(g.target_date)}
                          </span>
                        {:else}
                          <span class="text-muted">—</span>
                        {/if}
                      {/if}
                    </div>

                    <!-- Queue Controls (Edit Mode only) -->
                    {#if editMode}
                      <div class="queue-controls">
                        <button
                          type="button"
                          class="queue-btn"
                          on:click={() => moveGroupInQueue(g.id, 'up')}
                          disabled={idx === 0}
                          title="Move up in queue"
                        >
                          <ChevronUp size={16} />
                        </button>
                        <span class="queue-position">#{idx + 1}</span>
                        <button
                          type="button"
                          class="queue-btn"
                          on:click={() => moveGroupInQueue(g.id, 'down')}
                          disabled={idx === routerGroups.length - 1}
                          title="Move down in queue"
                        >
                          <ChevronDown size={16} />
                        </button>
                      </div>
                    {/if}
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}

        {#if editMode}
          <div class="hint">
            <AlertCircle size={14} />
            Drag parts from the bank to create or add to groups. Drag parts within groups to reorganize.
          </div>
        {/if}
      </div>
    </div>

{/if}

<style>
  /* Same fix as /manufacture's ToDo/Completed pages: the sub-tabs used to
     sit right above whatever card follows, but with their own separate
     bottom margin stacked on top of that card's own top margin - a dead
     gap between two independently-margined blocks. */
  .subtabs-tight {
    margin: 0 0 var(--space-3);
    padding-bottom: var(--space-3);
    border-bottom: 1px solid var(--border);
  }

  /* ==================== Page Actions ==================== */
  .page-actions {
    display: flex;
    gap: var(--gap-2);
    align-items: center;
  }

  /* ==================== Machine Status Grid (View Mode) ==================== */
  .machine-status-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: var(--gap-4);
    margin-bottom: var(--space-4);
  }

  .machine-section {
    padding: 0;
    overflow: hidden;
  }

  .machine-header {
    padding: var(--space-3) var(--space-4);
    border-left: 3px solid var(--border);
  }

  .machine-name {
    font-weight: 600;
    font-size: var(--font-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text);
  }

  .machine-status-cards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    border-top: 1px solid var(--border);
  }

  .status-summary-card {
    padding: var(--space-3) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--gap-1);
  }

  .status-summary-card + .status-summary-card {
    border-left: 1px solid var(--border);
  }

  .status-label {
    font-size: var(--font-xs);
    font-weight: 600;
    text-transform: uppercase;
    color: var(--text-muted);
    letter-spacing: 0.04em;
  }

  .status-group-name {
    font-size: var(--font-xs);
    font-weight: 600;
    color: var(--text);
  }

  .status-group-meta {
    font-size: var(--font-xs);
    color: var(--text-muted);
  }

  .status-target-date {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--font-xs);
    color: var(--text-muted);
  }

  /* ==================== Color Chips ==================== */
  .color-chip {
    display: inline-flex;
    align-items: center;
    height: var(--control-height);
    padding: var(--control-padding-lg);
    border-radius: var(--radius-sm);
    font-size: var(--font-xs);
    font-weight: 600;
    border: 1px solid;
    line-height: 1;
    box-sizing: border-box;
  }

  /* ==================== Section Title ==================== */
  .section-title {
    font-size: var(--font-base);
    font-weight: 600;
    margin: 0 0 var(--space-3) 0;
    color: var(--text);
  }

  /* ==================== Router Layout ==================== */
  .router-layout {
    display: flex;
    gap: var(--gap-4);
  }

  .router-layout.edit-mode {
    display: grid;
    grid-template-columns: 260px 1fr;
  }

  /* ==================== Ungrouped Parts Bank ==================== */
  .ungrouped-bank {
    padding: var(--space-4);
    max-height: calc(100vh - 250px);
    overflow-y: auto;
    position: sticky;
    top: var(--space-4);
  }

  .ungrouped-list {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
    min-height: 80px;
  }

  .ungrouped-part {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    padding: var(--space-2) var(--space-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: grab;
    transition: border-color 0.15s ease, background 0.15s ease;
  }

  .ungrouped-part:hover {
    border-color: var(--accent);
    background: var(--accent-subtle);
  }

  .ungrouped-part.dragging {
    opacity: 0.4;
  }

  :global(.drag-handle) {
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .part-name {
    font-size: var(--font-xs);
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .part-content {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    flex: 1;
  }

  .part-progress {
    font-size: 0.72rem;
    color: var(--text-muted);
    white-space: normal;
  }

  .part-actions-inline {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-2);
  }

  /* ==================== Groups Panel ==================== */
  .groups-panel {
    flex: 1;
    min-width: 0;
    border-radius: var(--radius-sm, 4px);
    transition: background 0.12s ease, box-shadow 0.12s ease;
  }

  /* Highlight the whole queue area as a drop target for creating a new group */
  .groups-panel.panel-drag-over {
    background: var(--brand-gold-soft, #fff4cc);
    box-shadow: inset 0 0 0 2px var(--brand-gold-base, #f1c331);
  }

  .groups-list {
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
  }

  /* ==================== Group Card ==================== */
  .group-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }

  .group-card.drag-over {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-subtle);
  }

  .group-card-inner {
    display: grid;
    grid-template-columns: 1fr 240px;
    min-height: 120px;
  }

  /* Group Parts (Left Half) */
  .group-parts {
    padding: var(--space-4);
    border-right: 1px solid var(--border);
  }

  .group-header {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    margin-bottom: var(--space-3);
    flex-wrap: wrap;
  }

  .group-name-btn {
    background: none;
    border: none;
    font-size: var(--font-base);
    font-weight: 600;
    color: var(--text);
    cursor: pointer;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    transition: background 0.15s ease;
  }

  .group-name-btn:hover {
    background: var(--surface-2);
  }

  .group-name-input {
    border: 1px solid var(--border);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    font-size: var(--font-base);
    font-weight: 600;
    min-width: 180px;
    background: var(--primary);
  }

  .group-name-input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--btn-focus-ring);
  }

  .mismatch-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-1);
    font-size: var(--font-xs);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    font-weight: 600;
  }

  .mismatch-badge.status-mismatch {
    background: var(--brand-gold-soft);
    color: var(--brand-gold-strong);
  }

  .mismatch-badge.stock-mismatch {
    background: var(--blue-soft);
    color: var(--blue-strong);
  }

  .parts-list {
    display: flex;
    flex-direction: column;
    gap: var(--gap-1);
  }

  .part-row {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    transition: background 0.15s ease;
  }

  .part-row:hover {
    background: var(--surface-2);
  }

  .part-row.drag-over {
    background: var(--accent-subtle);
    outline: 1px dashed var(--accent);
  }

  .remove-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    margin-left: auto;
    transition: all 0.15s ease;
  }

  .remove-btn:hover {
    background: var(--red-soft);
    border-color: var(--red-base);
    color: var(--red-base);
  }

  /* ==================== Group Metadata (Right Half) ==================== */
  .group-metadata {
    padding: var(--space-4);
    background: var(--surface-2);
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
  }

  .meta-field {
    display: flex;
    flex-direction: column;
    gap: var(--gap-1);
  }

  .meta-label {
    font-size: var(--font-xs);
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .meta-value {
    font-size: var(--font-xs);
    color: var(--text);
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  /* Status select - color-coded like tags, matching control height */
  .group-status-select {
    font-weight: 600;
    font-size: var(--font-xs);
    line-height: 1;
  }

  /* Queue controls */
  .queue-controls {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    margin-top: auto;
  }

  .queue-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--primary);
    color: var(--text);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .queue-btn:hover:not(:disabled) {
    background: var(--accent-subtle);
    border-color: var(--accent);
  }

  .queue-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .queue-position {
    font-size: var(--font-xs);
    font-weight: 600;
    color: var(--text-muted);
    min-width: 30px;
    text-align: center;
  }

  /* ==================== Hints ==================== */
  .hint {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    font-size: var(--font-xs);
    color: var(--text-muted);
    margin-top: var(--space-4);
    padding: var(--space-3) var(--space-4);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  /* ==================== Responsive ==================== */
  @media (max-width: 900px) {
    .router-layout.edit-mode {
      grid-template-columns: 1fr;
    }

    .ungrouped-bank {
      max-height: 200px;
      position: static;
    }

    .group-card-inner {
      grid-template-columns: 1fr;
    }

    .group-parts {
      border-right: none;
      border-bottom: 1px solid var(--border);
    }

    .machine-status-grid {
      grid-template-columns: 1fr;
    }

    .machine-status-cards {
      grid-template-columns: 1fr;
    }

    .status-summary-card + .status-summary-card {
      border-left: none;
      border-top: 1px solid var(--border);
    }

  }
</style>

