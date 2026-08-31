<script>
  import { requestConfirmation } from '$lib/confirmation.js';
  import { onMount } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { page } from '$app/stores';
  import { Package, Check } from 'lucide-svelte';
  import { getRouterStageCounts, buildRouterProgressUpdate, advanceRouterStageCounts, isFullyCut, isFullyKitted, ROUTER_STAGE_LABELS } from '$lib/router_progress.js';

  let loading = true;
  let useDedicatedTables = true;
  let groupMap = {};
  let savingPartIds = new Set();

  const POST_PROCESSING_STAGES = ['Jigsawed', 'Countersinking', 'Deburring', 'Inspecting', 'Kitted'];

  function parseMeta(part) {
    try { return JSON.parse(part.file_url || '{}') || {}; } catch { return {}; }
  }

  function getPartStageCount(part, stage) {
    return getRouterStageCounts(part)[stage] || 0;
  }

  function getGroupCompletionSummary(group) {
    if (!group?.parts?.length) return '';
    const kitted = group.parts.reduce((sum, part) => sum + getPartStageCount(part, 'kitted'), 0);
    const total = group.parts.reduce((sum, part) => sum + (part.quantity || 1), 0);
    return `${kitted}/${total} kitted`;
  }

  function getGroupPostProcessingIndex(group) {
    if (!group?.parts?.length) return -1;
    const stageOrder = ['cut', 'jigsawed', 'countersinking', 'deburred', 'inspecting', 'kitted'];
    for (let i = 0; i < stageOrder.length; i += 1) {
      if (group.parts.some((part) => getPartStageCount(part, stageOrder[i]) > 0)) return i;
    }
    return -1;
  }

  function groupIsCut(g) {
    if (!g || !g.parts || g.parts.length === 0) return false;
    return g.parts.every((p) => isFullyCut(p));
  }

  function groupIsKitted(g) {
    if (!g || !g.parts || g.parts.length === 0) return false;
    return g.parts.every((p) => isFullyKitted(p));
  }

  function getStockColor(stock) {
    if (!stock) return { bg: 'var(--surface-2)', text: 'var(--text-muted)', border: 'var(--border)' };
    const s = stock.toLowerCase();
    if (s.includes('polycarbonate')) return { bg: 'var(--blue-soft)', text: 'var(--blue-strong)', border: 'var(--blue-base)' };
    if (s.includes('tube')) return { bg: 'var(--green-soft)', text: 'var(--green-strong)', border: 'var(--green-base)' };
    return { bg: 'var(--brand-gold-soft)', text: 'var(--brand-gold-strong)', border: 'var(--brand-gold-base)' };
  }

  async function loadGroups() {
    loading = true;
    if (useDedicatedTables) {
      const { data: groups, error: gErr } = await supabase
        .from('router_groups')
        .select('id, name, stock, queue_position, post_processing_stage')
        .order('queue_position', { ascending: true, nullsFirst: false });

      const { data: links, error: lErr } = await supabase
        .from('router_group_parts')
        .select('group_id, part_id');

      if (gErr || lErr) {
        useDedicatedTables = false;
        await buildGroupsFromJSON();
      } else {
        const gmap = {};
        (groups || []).forEach(g => {
          gmap[g.id] = {
            id: g.id,
            name: g.name || g.id,
            parts: [],
            stock: g.stock || '',
            queue_position: g.queue_position ?? 999,
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

        groupMap = gmap;
      }
    } else {
      await buildGroupsFromJSON();
    }
    loading = false;
  }

  async function buildGroupsFromJSON() {
    const { data, error } = await supabase
      .from('parts')
      .select('*')
      .eq('workflow', 'router');
    if (error) {
      groupMap = {};
      return;
    }

    const gmap = {};
    for (const p of data || []) {
      const meta = parseMeta(p);
      if (!meta.router_group_id) continue;
      if (!gmap[meta.router_group_id]) {
        gmap[meta.router_group_id] = {
          id: meta.router_group_id,
          name: meta.router_group_name || meta.router_group_id,
          parts: [],
          stock: '',
          queue_position: 999,
          post_processing_stage: null
        };
      }
      gmap[meta.router_group_id].parts.push(p);
    }
    groupMap = gmap;
  }

  $: postProcessingGroups = Object.values(groupMap)
    .filter(g => g.parts.length > 0 && groupIsCut(g) && !groupIsKitted(g))
    .sort((a, b) => (a.queue_position ?? 999) - (b.queue_position ?? 999));

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

  function setPartSaving(partId, saving) {
    const next = new Set(savingPartIds);
    if (saving) next.add(partId);
    else next.delete(partId);
    savingPartIds = next;
  }

  async function movePartStage(part, fromStage, toStage) {
    if (savingPartIds.has(part.id)) return;

    const nextCounts = advanceRouterStageCounts(part, fromStage, toStage, 1);
    if (!nextCounts) return;
    const update = buildRouterProgressUpdate(part, nextCounts);

    setPartSaving(part.id, true);

    const { error } = await supabase
      .from('parts')
      .update(update)
      .eq('id', part.id);

    setPartSaving(part.id, false);

    if (error) {
      console.error('Failed to update router progress', error);
      alert('Failed to update router progress.');
      return;
    }

    updatePartInGroups(part.id, update);
  }

  // Send a part back to be re-cut: reset to Pending (clears router stage
  // progress) so it leaves Post Processing and returns to the Router / ToDo tabs.
  async function recutPart(part) {
    if (savingPartIds.has(part.id)) return;
    if (!await requestConfirmation({ title: 'Send part for re-cut', message: `Send "${part.name}" back to be re-cut? It will return to Pending and leave Post Processing.`, confirmLabel: 'Send for re-cut', danger: true })) return;

    const root = parseMeta(part);
    const routerMeta = { ...(root.router_meta || {}) };
    delete routerMeta.stage_counts;
    delete routerMeta.step;
    delete routerMeta.travis_progged;
    const update = {
      status: 'pending',
      file_url: JSON.stringify({ ...root, router_meta: routerMeta }),
      updated_at: new Date().toISOString()
    };

    setPartSaving(part.id, true);
    const { error } = await supabase.from('parts').update(update).eq('id', part.id);
    setPartSaving(part.id, false);

    if (error) {
      console.error('Failed to recut part', error);
      alert('Failed to recut part.');
      return;
    }
    updatePartInGroups(part.id, update);
    await loadGroups();
  }

  onMount(loadGroups);
</script>

<svelte:head><title>Post Processing</title></svelte:head>

<div class="page-header">
  <h1>Post Processing</h1>
</div>

<div class="subtabs">
  <a href="/manufacture" class:active={$page.url.pathname === '/manufacture'}>ToDo</a>
  <a href="/manufacture/completed" class:active={$page.url.pathname === '/manufacture/completed'}>Completed</a>
  <a href="/manufacture/router" class:active={$page.url.pathname === '/manufacture/router'}>Router</a>
  <a href="/manufacture/post-processing" class:active={$page.url.pathname === '/manufacture/post-processing'}>Post Processing</a>
  <a href="/manufacture/bins" class:active={$page.url.pathname === '/manufacture/bins'}>Bins</a>
</div>

{#if loading}
  <div class="card"><p>Loading...</p></div>
{:else if postProcessingGroups.length === 0}
  <div class="empty-state">
    <Package size={32} />
    <h3>No Groups Ready</h3>
    <p>Groups appear here after all parts have been cut.</p>
  </div>
{:else}
  <div class="post-processing-list">
    {#each postProcessingGroups as g (g.id)}
      <div class="card pp-card">
        <div class="pp-card-header">
          <div class="pp-header-left">
            <h2 class="pp-group-name">{g.name}</h2>
            <span class="text-muted">{g.parts.length} part{g.parts.length !== 1 ? 's' : ''}</span>
            <span class="text-muted">Qty {getGroupCompletionSummary(g)}</span>
          </div>
          {#if g.stock}
            {@const sc = getStockColor(g.stock)}
            <span class="color-chip" style="background: {sc.bg}; color: {sc.text}; border-color: {sc.border};">
              {g.stock}
            </span>
          {/if}
        </div>

        <div class="pp-stages">
          {#each POST_PROCESSING_STAGES as stage, stageIdx}
            {@const currentIdx = getGroupPostProcessingIndex(g)}
            {@const isComplete = stageIdx < currentIdx}
            {@const isCurrent = stageIdx === currentIdx}
            {@const isNext = stageIdx === currentIdx + 1 || (currentIdx === -1 && stageIdx === 0)}

            <div class="pp-stage" class:complete={isComplete} class:current={isCurrent} class:next={isNext}>
              <div class="pp-stage-dot">
                {#if isComplete}
                  <Check size={12} />
                {:else}
                  <span>{stageIdx + 1}</span>
                {/if}
              </div>
              <span class="pp-stage-label">{stage}</span>
            </div>
            {#if stageIdx < POST_PROCESSING_STAGES.length - 1}
              <div class="pp-connector" class:complete={isComplete}></div>
            {/if}
          {/each}
        </div>

        <div class="pp-parts-preview">
          {#each g.parts as p}
            <div class="pp-part-chip">
              <span class="pp-part-name">{p.name}</span>
              <span class="pp-part-counts">
                {#if getPartStageCount(p, 'cut') > 0}<span>{getPartStageCount(p, 'cut')} {ROUTER_STAGE_LABELS.cut}</span>{/if}
                {#if getPartStageCount(p, 'jigsawed') > 0}<span>{getPartStageCount(p, 'jigsawed')} {ROUTER_STAGE_LABELS.jigsawed}</span>{/if}
                {#if getPartStageCount(p, 'countersinking') > 0}<span>{getPartStageCount(p, 'countersinking')} {ROUTER_STAGE_LABELS.countersinking}</span>{/if}
                {#if getPartStageCount(p, 'deburred') > 0}<span>{getPartStageCount(p, 'deburred')} {ROUTER_STAGE_LABELS.deburred}</span>{/if}
                {#if getPartStageCount(p, 'inspecting') > 0}<span>{getPartStageCount(p, 'inspecting')} {ROUTER_STAGE_LABELS.inspecting}</span>{/if}
                {#if getPartStageCount(p, 'kitted') > 0}<span>{getPartStageCount(p, 'kitted')} {ROUTER_STAGE_LABELS.kitted}</span>{/if}
              </span>
              <div class="pp-part-actions">
                {#if getPartStageCount(p, 'cut') > 0}
                  <button type="button" class="btn btn-primary btn-sm pp-advance-btn" on:click={() => movePartStage(p, 'cut', 'jigsawed')} disabled={savingPartIds.has(p.id)}>Jigsaw 1</button>
                {/if}
                {#if getPartStageCount(p, 'jigsawed') > 0}
                  <button type="button" class="btn btn-primary btn-sm pp-advance-btn" on:click={() => movePartStage(p, 'jigsawed', 'countersinking')} disabled={savingPartIds.has(p.id)}>Countersink 1</button>
                {/if}
                {#if getPartStageCount(p, 'countersinking') > 0}
                  <button type="button" class="btn btn-primary btn-sm pp-advance-btn" on:click={() => movePartStage(p, 'countersinking', 'deburred')} disabled={savingPartIds.has(p.id)}>Deburr 1</button>
                {/if}
                {#if getPartStageCount(p, 'deburred') > 0}
                  <button type="button" class="btn btn-primary btn-sm pp-advance-btn" on:click={() => movePartStage(p, 'deburred', 'inspecting')} disabled={savingPartIds.has(p.id)}>Inspect 1</button>
                {/if}
                {#if getPartStageCount(p, 'inspecting') > 0}
                  <button type="button" class="btn btn-primary btn-sm pp-advance-btn" on:click={() => movePartStage(p, 'inspecting', 'kitted')} disabled={savingPartIds.has(p.id)}>Kit 1</button>
                {/if}
                <button type="button" class="btn btn-secondary btn-sm pp-recut-btn" on:click={() => recutPart(p)} disabled={savingPartIds.has(p.id)} title="Send back to be re-cut">Recut</button>
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .post-processing-list {
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
  }

  .pp-card {
    padding: var(--space-4);
  }

  .pp-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-4);
    gap: var(--gap-3);
  }

  .pp-header-left {
    display: flex;
    align-items: baseline;
    gap: var(--gap-3);
  }

  .pp-group-name {
    font-size: var(--font-md);
    font-weight: 600;
    margin: 0;
    color: var(--text);
  }

  .color-chip {
    display: inline-flex;
    align-items: center;
    height: 26px;
    padding: 0 var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: var(--font-xs);
    font-weight: 600;
    white-space: nowrap;
  }

  .pp-stages {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    margin-bottom: var(--space-4);
    flex-wrap: wrap;
  }

  .pp-stage {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    padding: var(--space-2) var(--space-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    transition: all 0.15s ease;
  }

  .pp-stage.complete {
    background: var(--green-soft);
    border-color: var(--green-base);
  }

  .pp-stage.current {
    background: var(--blue-soft);
    border-color: var(--blue-base);
  }

  .pp-stage.next {
    border-style: dashed;
  }

  .pp-stage-dot {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: var(--radius-sm);
    background: var(--border);
    color: var(--text);
    font-size: var(--font-xs);
    font-weight: 600;
  }

  .pp-stage.complete .pp-stage-dot {
    background: var(--green-base);
    color: var(--primary);
  }

  .pp-stage.current .pp-stage-dot {
    background: var(--blue-base);
    color: var(--primary);
  }

  .pp-stage-label {
    font-size: var(--font-xs);
    font-weight: 500;
    color: var(--text);
  }

  .pp-connector {
    width: 16px;
    height: 2px;
    background: var(--border);
    flex-shrink: 0;
  }

  .pp-connector.complete {
    background: var(--green-base);
  }

  .pp-advance-btn {
    --btn-height: 24px;
    --btn-padding: 0 var(--space-2);
    --btn-font-size: var(--font-xs);
  }

  .pp-parts-preview {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
  }

  .pp-part-chip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--gap-2);
    padding: var(--space-2) var(--space-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    flex-wrap: wrap;
  }

  .pp-part-name {
    font-size: var(--font-xs);
    font-weight: 600;
  }

  .pp-part-counts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-2);
    font-size: var(--font-xs);
    color: var(--text-muted);
  }

  .pp-part-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-2);
  }

  @media (max-width: 900px) {
    .pp-stages {
      flex-direction: column;
      align-items: flex-start;
    }

    .pp-connector {
      width: 2px;
      height: 16px;
      margin-left: 9px;
    }
  }
</style>
