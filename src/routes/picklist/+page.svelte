<script>
  import { onMount } from 'svelte';
  import { dragHandleZone, dragHandle } from 'svelte-dnd-action';
  import { AlertTriangle, ClipboardList, GripVertical, RefreshCw } from 'lucide-svelte';
  import { getAuthHeader } from '$lib/supabase.js';
  import { submitOrQueue } from '$lib/offlineQueue.js';
  import { fetchWithCache } from '$lib/offlineCache.js';
  import { fetchActiveScoutingEventKey, fetchAvailableScoutingEvents } from '$lib/scoutingEvent.js';
  import { buildStrategyRows } from '$lib/strategyScouting.js';
  import { buildPowerRankings, DEFAULT_SCOUT_POWER_WEIGHTS } from '$lib/scoutingStats.js';
  import SeasonFilter from '$lib/components/SeasonFilter.svelte';

  // Split out of Strategy into its own top-level Competition tab per direct
  // instruction - alliance selection is its own workflow the whole scouting
  // group opens repeatedly during a competition, not a sub-view of the
  // Teams/Matches board. Still reuses everything Strategy's Picklist tab
  // already built: the scouting_picklist table/API, buildPowerRankings, and
  // the AI move-flagging endpoint - nothing about the underlying data model
  // changed, just where the UI for it lives.
  let eventKey = '';
  let selectedEventKey = null;
  let availableEvents = [];
  let report = null;
  let eventTeams = [];
  let fallbackNames = {};
  let teamsWarning = '';
  let loadedEventKey = '';
  let loading = true;
  let error = '';

  let picklistEntries = [];
  let picklistLoading = false;
  let picklistError = '';
  let loadedPicklistEventKey = '';
  let dragOrderSnapshot = null;
  let flagsByEntryId = new Map();
  let sliderWeights = {
    performance: DEFAULT_SCOUT_POWER_WEIGHTS.performance * 100,
    notes: DEFAULT_SCOUT_POWER_WEIGHTS.notes * 100,
    reliability: DEFAULT_SCOUT_POWER_WEIGHTS.reliability * 100,
    opr: DEFAULT_SCOUT_POWER_WEIGHTS.opr * 100
  };

  $: resolvedEventKey = selectedEventKey || eventKey;
  $: rows = buildStrategyRows(report?.data || {}, eventTeams);
  $: activeEventLabel = availableEvents.find((option) => option.value === eventKey)?.label || eventKey || 'not set';
  $: browseEventOptions = availableEvents.filter((option) => option.value !== eventKey);
  $: powerRankings = buildPowerRankings(
    rows.map((row) => ({ key: row.teamKey, team_number: Number(row.teamNumber) || 0, nickname: '' })),
    report?.data?.data_events || [],
    report?.data?.notes || [],
    { pitEntries: report?.data?.pit_entries || [], problemReports: report?.data?.pit_problems || [], matchEntries: report?.data?.match_entries || [] }
  );
  $: scoutPowerByTeam = new Map(powerRankings.map((team) => [team.key, team.scoutPower]));
  $: normalizedSliderWeights = (() => {
    const total = sliderWeights.performance + sliderWeights.notes + sliderWeights.reliability + sliderWeights.opr;
    if (!total) return DEFAULT_SCOUT_POWER_WEIGHTS;
    return {
      performance: sliderWeights.performance / total,
      notes: sliderWeights.notes / total,
      reliability: sliderWeights.reliability / total,
      opr: sliderWeights.opr / total
    };
  })();
  $: autoRankedRows = buildPowerRankings(
    rows.map((row) => ({ key: row.teamKey, team_number: Number(row.teamNumber) || 0, nickname: '' })),
    report?.data?.data_events || [],
    report?.data?.notes || [],
    { pitEntries: report?.data?.pit_entries || [], problemReports: report?.data?.pit_problems || [], matchEntries: report?.data?.match_entries || [] },
    normalizedSliderWeights
  ).slice().sort((a, b) => (b.scoutPower ?? -1) - (a.scoutPower ?? -1));
  $: if (resolvedEventKey && resolvedEventKey !== loadedPicklistEventKey && !picklistLoading) void loadPicklist();

  // Real team names: the event roster first, then a per-team TBA lookup for
  // anyone missing from it (a roster can lag behind scouting data), then
  // whatever nickname the pick list row itself stored.
  $: nameByTeam = (() => {
    const names = new Map();
    for (const team of eventTeams) {
      const name = String(team?.nickname || team?.name || '').trim();
      if (team?.key && name) names.set(team.key, name);
    }
    for (const [key, name] of Object.entries(fallbackNames)) if (!names.has(key)) names.set(key, name);
    for (const entry of picklistEntries) {
      const name = String(entry?.nickname || '').trim();
      if (name && !names.has(entry.team_key)) names.set(entry.team_key, name);
    }
    return names;
  })();
  $: missingNameKeys = [...new Set([...picklistEntries.map((e) => e.team_key), ...autoRankedRows.map((t) => t.key)])]
    .filter((key) => key && !nameByTeam.has(key) && !(key in requestedNameKeys));
  let requestedNameKeys = {};
  $: if (missingNameKeys.length) void loadMissingNames(missingNameKeys);
  async function loadMissingNames(keys) {
    requestedNameKeys = { ...requestedNameKeys, ...Object.fromEntries(keys.map((key) => [key, true])) };
    try {
      const response = await fetch(`/api/tba/teams-simple?team_keys=${encodeURIComponent(keys.join(','))}`);
      const payload = await response.json().catch(() => null);
      const found = {};
      for (const row of payload?.data || []) {
        const name = String(row?.nickname || row?.name || '').trim();
        if (row?.key && name) found[row.key] = name;
      }
      fallbackNames = { ...fallbackNames, ...found };
    } catch {
      // Names are decoration - a failed lookup just leaves the number.
    }
  }

  const teamNumber = (teamKey) => String(teamKey || '').replace(/^frc/i, '');
  const number = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '-';
  const teamHref = (teamKey) =>
    `/teamview?event_key=${encodeURIComponent(resolvedEventKey)}&team=${encodeURIComponent(teamKey)}&from=${encodeURIComponent('/picklist')}&fromLabel=${encodeURIComponent('Picklist')}`;

  function teamSummaryPayload(teamKey) {
    const row = rows.find((item) => item.teamKey === teamKey);
    if (!row) return { teamNumber: teamNumber(teamKey) };
    return {
      teamNumber: row.teamNumber,
      scoutPower: scoutPowerByTeam.get(teamKey) ?? null,
      avgFuel: row.performance.avgFuel,
      avgBallsScored: row.matchScoutSummary.avgBallsScored,
      openProblems: row.openProblems.length
    };
  }

  async function loadPicklist() {
    if (!resolvedEventKey) { picklistEntries = []; return; }
    picklistLoading = true;
    picklistError = '';
    try {
      const response = await fetch(`/api/scouting-picklist?event_key=${encodeURIComponent(resolvedEventKey)}`);
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) throw new Error(payload?.error || 'Could not load the pick list.');
      picklistEntries = payload.data || [];
      loadedPicklistEventKey = resolvedEventKey;
      if (!picklistEntries.length && autoRankedRows.length) await seedPicklistFromAutoRank();
    } catch (cause) {
      picklistError = cause?.message || 'Could not load the pick list.';
    } finally {
      picklistLoading = false;
    }
  }

  async function seedPicklistFromAutoRank() {
    if (!resolvedEventKey || !autoRankedRows.length) return;
    picklistLoading = true;
    picklistError = '';
    try {
      const headers = { 'Content-Type': 'application/json', ...(await getAuthHeader()) };
      await Promise.all(autoRankedRows.map(async (team) => {
        const addResponse = await fetch('/api/scouting-picklist', {
          method: 'POST',
          headers,
          body: JSON.stringify({ action: 'add', event_key: resolvedEventKey, team_key: team.key, team_number: team.team_number })
        });
        if (!addResponse.ok && addResponse.status !== 409) {
          const addPayload = await addResponse.json().catch(() => null);
          throw new Error(addPayload?.error || `Could not add team ${team.team_number} to the pick list.`);
        }
      }));
      const listResponse = await fetch(`/api/scouting-picklist?event_key=${encodeURIComponent(resolvedEventKey)}`);
      const listPayload = await listResponse.json().catch(() => null);
      if (!listResponse.ok || !listPayload?.success) throw new Error(listPayload?.error || 'Could not reload the pick list.');
      const idByTeamKey = new Map((listPayload.data || []).map((entry) => [entry.team_key, entry.id]));
      const orderedIds = autoRankedRows.map((team) => idByTeamKey.get(team.key)).filter(Boolean);
      const reorderResponse = await fetch('/api/scouting-picklist', {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'reorder', event_key: resolvedEventKey, ordered_ids: orderedIds })
      });
      const reorderPayload = await reorderResponse.json().catch(() => null);
      if (!reorderResponse.ok || !reorderPayload?.success) throw new Error(reorderPayload?.error || 'Could not order the pick list.');
      const entryById = new Map((listPayload.data || []).map((entry) => [entry.id, entry]));
      picklistEntries = orderedIds.map((id) => entryById.get(id)).filter(Boolean);
      loadedPicklistEventKey = resolvedEventKey;
    } catch (cause) {
      picklistError = cause?.message || 'Could not seed the pick list from the auto rank.';
    } finally {
      picklistLoading = false;
    }
  }

  async function removeFromPicklist(id) {
    picklistEntries = picklistEntries.filter((entry) => entry.id !== id);
    try {
      const headers = { 'Content-Type': 'application/json', ...(await getAuthHeader()) };
      await fetch('/api/scouting-picklist', { method: 'POST', headers, body: JSON.stringify({ action: 'remove', id }) });
    } catch (cause) {
      picklistError = cause?.message || 'Could not remove that team from the pick list.';
    }
  }

  function handlePicklistConsider(e) {
    if (dragOrderSnapshot === null) dragOrderSnapshot = picklistEntries.map((entry) => entry.id);
    picklistEntries = e.detail.items;
  }

  async function handlePicklistFinalize(e) {
    const finalItems = e.detail.items;
    const movedId = e.detail.info?.id;
    const previousOrder = dragOrderSnapshot;
    dragOrderSnapshot = null;
    picklistEntries = finalItems;

    try {
      // Reordering the same target positions is idempotent - a queued
      // retry landing after an earlier attempt actually succeeded (the
      // drag already shows the new order locally either way) just
      // reapplies the same positions, not a duplicate or conflicting one.
      const result = await submitOrQueue({
        url: '/api/scouting-picklist',
        headers: await getAuthHeader(),
        label: 'Picklist reorder',
        body: { action: 'reorder', event_key: resolvedEventKey, ordered_ids: finalItems.map((entry) => entry.id) }
      });
      if (result.queued) picklistError = "Reordered on this phone - no connection right now, so it'll sync once you're back online.";
    } catch (cause) {
      picklistError = cause?.message || 'Could not save the new order.';
    }

    if (movedId && previousOrder) {
      const fromIndex = previousOrder.indexOf(movedId);
      const toIndex = finalItems.findIndex((entry) => entry.id === movedId);
      if (fromIndex !== toIndex) void flagPicklistMove(movedId, fromIndex, toIndex, finalItems);
    }
  }

  async function flagPicklistMove(movedId, fromIndex, toIndex, items) {
    const movedEntry = items.find((entry) => entry.id === movedId);
    if (!movedEntry) return;
    const neighborEntries = items.filter((entry, index) => entry.id !== movedId && Math.abs(index - toIndex) <= 2);
    try {
      const headers = { 'Content-Type': 'application/json', ...(await getAuthHeader()) };
      const response = await fetch('/api/scouting-picklist/flag-move', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          movedTeam: teamSummaryPayload(movedEntry.team_key),
          fromIndex: fromIndex + 1,
          toIndex: toIndex + 1,
          neighbors: neighborEntries.map((entry) => teamSummaryPayload(entry.team_key))
        })
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.success && payload.flagged) {
        flagsByEntryId = new Map(flagsByEntryId).set(movedId, payload.reason || 'Flagged - review this move.');
      } else {
        const next = new Map(flagsByEntryId);
        next.delete(movedId);
        flagsByEntryId = next;
      }
    } catch {
      // Advisory only - flagging unavailable this time is not an error.
    }
  }

  async function loadPicklistPage() {
    if (!resolvedEventKey) {
      report = null;
      loading = false;
      return;
    }
    loading = true;
    error = '';
    teamsWarning = '';
    try {
      const authHeaders = await getAuthHeader();
      const [response] = await Promise.all([
        fetch(`/api/scouting-report?event_key=${encodeURIComponent(resolvedEventKey)}`, { headers: authHeaders }),
        // Roster barely changes mid-event - cached, so a slow link doesn't
        // delay showing the pick list itself.
        fetchWithCache(`/api/tba/event-teams?event_key=${encodeURIComponent(resolvedEventKey)}`, {
          cacheKey: `event-teams:${resolvedEventKey}`,
          onUpdate: (teamsPayload) => {
            if (teamsPayload?.success) { eventTeams = teamsPayload.data || []; teamsWarning = ''; }
            else teamsWarning = teamsPayload?.error || 'Could not load the event roster from The Blue Alliance.';
          }
        }).catch(() => { teamsWarning = 'Could not load the event roster from The Blue Alliance.'; })
      ]);
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) throw new Error(payload?.error || 'Could not load scouting data.');
      report = payload;
      loadedEventKey = resolvedEventKey;
    } catch (cause) {
      report = null;
      eventTeams = [];
      error = cause?.message || 'Could not load scouting data.';
    } finally {
      loadedEventKey = resolvedEventKey;
      loading = false;
    }
  }

  onMount(async () => {
    [eventKey, availableEvents] = await Promise.all([fetchActiveScoutingEventKey(), fetchAvailableScoutingEvents()]);
    await loadPicklistPage();
  });

  $: if (resolvedEventKey && resolvedEventKey !== loadedEventKey && !loading) void loadPicklistPage();
</script>

<svelte:head><title>Picklist</title></svelte:head>

<div class="page-header strategy-header">
  <div>
    <span class="eyebrow">Competition</span>
    <h1><ClipboardList size={24} /> Picklist</h1>
    <p>Human drag-reorder with AI move-flagging, alongside a slider-weighted auto rank.</p>
  </div>
  <div class="header-actions">
    <SeasonFilter options={browseEventOptions} bind:value={selectedEventKey} allLabel={`Current Event (${activeEventLabel})`} />
    <button class="btn btn-outline" on:click={loadPicklistPage} disabled={loading || !resolvedEventKey}><RefreshCw size={16} /> Refresh</button>
  </div>
</div>

{#if !resolvedEventKey}
  <div class="empty-state">Set an active scouting event in Scouting Admin to build the pick list.</div>
{:else if loading}
  <div class="empty-state">Loading scouting evidence...</div>
{:else if error}
  <div class="notice notice-error">{error}</div>
{:else}
  {#if teamsWarning}<p class="muted matches-warning">{teamsWarning}</p>{/if}
  <section class="strategy-layout picklist-layout">
    <div class="strategy-board">
      <div class="section-heading">
        <div><h2>Human picklist</h2><p>Drag to reorder. Moves get reviewed against scouting data - flags are advisory, never blocking.</p></div>
        <button class="btn btn-outline btn-sm" on:click={seedPicklistFromAutoRank} disabled={picklistLoading || !autoRankedRows.length}>Reseed from auto rank</button>
      </div>
      {#if picklistError}<p class="notice notice-error">{picklistError}</p>{/if}
      {#if picklistLoading && !picklistEntries.length}
        <div class="empty-state">Loading pick list...</div>
      {:else if !picklistEntries.length}
        <div class="empty-state">No teams on the pick list yet for this event. Sort the <a href="/strategy">Strategy Teams board</a> and use "Send to Picklist" to start one, or reseed from the auto rank.</div>
      {:else}
        <ul class="picklist-list" use:dragHandleZone={{ items: picklistEntries, flipDurationMs: 150 }} on:consider={handlePicklistConsider} on:finalize={handlePicklistFinalize}>
          {#each picklistEntries as entry, index (entry.id)}
            <li class="picklist-row">
              <span class="drag-handle" use:dragHandle aria-label={`Drag to reorder team ${entry.team_number}`}><GripVertical size={18} /></span>
              <span class="picklist-rank">{index + 1}</span>
              <a class="team-number-link" href={teamHref(entry.team_key)}>{entry.team_number}</a>
              {#if nameByTeam.get(entry.team_key)}<span class="team-name">{nameByTeam.get(entry.team_key)}</span>{/if}
              {#if flagsByEntryId.get(entry.id)}
                <span class="flag-chip" title={flagsByEntryId.get(entry.id)}><AlertTriangle size={14} /> {flagsByEntryId.get(entry.id)}</span>
              {/if}
              <button class="btn btn-outline btn-sm" on:click={() => removeFromPicklist(entry.id)}>Remove</button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <aside class="team-brief picklist-auto">
      <div class="brief-title"><div><span class="eyebrow">Auto rank</span><h2>Slider-weighted</h2></div></div>
      <div class="slider-group">
        <label>Performance <span>{Math.round(normalizedSliderWeights.performance * 100)}%</span><input type="range" min="0" max="100" step="1" bind:value={sliderWeights.performance} /></label>
        <label>Notes impact <span>{Math.round(normalizedSliderWeights.notes * 100)}%</span><input type="range" min="0" max="100" step="1" bind:value={sliderWeights.notes} /></label>
        <label>Reliability <span>{Math.round(normalizedSliderWeights.reliability * 100)}%</span><input type="range" min="0" max="100" step="1" bind:value={sliderWeights.reliability} /></label>
        <label>OPR <span>{Math.round(normalizedSliderWeights.opr * 100)}%</span><input type="range" min="0" max="100" step="1" bind:value={sliderWeights.opr} /></label>
      </div>
      <ol class="auto-rank-list">
        {#each autoRankedRows as team (team.key)}
          <li><a class="team-number-link" href={teamHref(team.key)}>{team.team_number}</a>{#if nameByTeam.get(team.key)}<span class="team-name">{nameByTeam.get(team.key)}</span>{/if}<span class="muted score">{number(team.scoutPower)}</span></li>
        {/each}
      </ol>
    </aside>
  </section>
{/if}

<style>
  .strategy-header { display:flex; justify-content:space-between; gap:var(--space-4); align-items:flex-end; }
  .strategy-header h1 { display:flex; align-items:center; gap:var(--space-2); margin:0; }
  .strategy-header p { margin:var(--space-1) 0 0; color:var(--text-secondary); }
  .header-actions { display:flex; gap:var(--space-2); align-items:center; flex-wrap:wrap; }
  .strategy-layout { display:grid; grid-template-columns:minmax(0, 1.7fr) minmax(290px, .8fr); gap:var(--space-4); margin-top:var(--space-4); align-items:start; }
  .strategy-board, .team-brief { border:1px solid var(--border); background:var(--surface-1); }
  .section-heading, .brief-title { display:flex; justify-content:space-between; gap:var(--space-3); align-items:center; padding:var(--space-3); border-bottom:1px solid var(--border); }
  .section-heading p { margin:var(--space-1) 0 0; color:var(--text-secondary); }
  h2 { margin:0; }
  .team-number-link { display:inline-block; margin:0 var(--space-1) 0 0; padding:2px 6px; border-radius:var(--radius-xs); color:var(--text); text-decoration:none; font-weight:600; }
  .team-number-link:hover { text-decoration:underline; }
  .picklist-list { list-style:none; margin:0; padding:var(--space-2); display:grid; gap:var(--space-2); }
  .picklist-row { display:flex; align-items:center; gap:var(--space-2); padding:var(--space-2) var(--space-3); border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--surface-1); }
  .drag-handle { display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; padding:var(--space-1); margin:calc(var(--space-1) * -1) 0; color:var(--text-secondary); cursor:grab; touch-action:none; }
  .drag-handle:active { cursor:grabbing; }
  .picklist-rank { font-weight:700; color:var(--text-secondary); min-width:1.5em; }
  .flag-chip { display:inline-flex; align-items:center; gap:4px; margin-left:auto; padding:2px 8px; border-radius:999px; background:color-mix(in srgb, var(--danger, #dc3545) 15%, transparent); color:var(--danger, #dc3545); font-size:.78rem; max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .picklist-auto .slider-group { padding:var(--space-3); border-bottom:1px solid var(--border); display:grid; gap:var(--space-3); }
  .slider-group label { display:grid; grid-template-columns:1fr auto; gap:0 var(--space-2); font-size:.82rem; color:var(--text-secondary); }
  .slider-group input[type="range"] { grid-column:1 / -1; width:100%; }
  .auto-rank-list { list-style:decimal inside; margin:0; padding:var(--space-3); display:grid; gap:var(--space-2); }
  .auto-rank-list li { display:flex; align-items:center; justify-content:space-between; gap:var(--space-2); }
  .team-name { font-weight:600; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .auto-rank-list .score { margin-left:auto; }
  .muted { color:var(--text-secondary); font-size:.82rem; }
  .matches-warning { padding:0 var(--space-3); }
  .empty-state, .notice { border:1px solid var(--border); padding:var(--space-4); margin-top:var(--space-4); color:var(--text-secondary); }
  .notice-error { border-color:var(--danger, #dc3545); color:var(--danger, #dc3545); }
  @media (max-width:900px) { .strategy-layout { grid-template-columns:1fr; } }
  @media (max-width:620px) {
    .strategy-header { align-items:stretch; flex-direction:column; }
    .header-actions > * { flex:1; }
  }
</style>
