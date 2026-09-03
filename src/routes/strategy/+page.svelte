<script>
  import { onMount } from 'svelte';
  import { AlertTriangle, ClipboardList, MapPinned, RefreshCw, Route, Target, Users } from 'lucide-svelte';
  import { getAuthHeader } from '$lib/supabase.js';
  import { fetchActiveScoutingEventKey, fetchAvailableScoutingEvents } from '$lib/scoutingEvent.js';
  import { buildStrategyRows, strategyTotals } from '$lib/strategyScouting.js';
  import SeasonFilter from '$lib/components/SeasonFilter.svelte';

  let eventKey = '';
  let selectedEventKey = null;
  let availableEvents = [];
  let report = null;
  let loadedEventKey = '';
  let loading = true;
  let error = '';
  let teamSearch = '';
  let selectedTeamKey = '';

  $: resolvedEventKey = selectedEventKey || eventKey;
  $: rows = buildStrategyRows(report?.data || {});
  $: totals = strategyTotals(rows);
  $: filteredRows = rows.filter((row) => row.teamNumber.includes(teamSearch.trim()) || row.pitEntry?.robot_archetype?.toLowerCase().includes(teamSearch.trim().toLowerCase()));
  $: selectedTeam = rows.find((row) => row.teamKey === selectedTeamKey) || filteredRows[0] || null;

  const number = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '-';
  const percent = (value) => Number.isFinite(value) ? `${Math.round(value * 100)}%` : '-';
  const text = (value) => String(value || '').trim();

  async function loadStrategy() {
    if (!resolvedEventKey) {
      report = null;
      loading = false;
      return;
    }
    loading = true;
    error = '';
    try {
      const response = await fetch(`/api/scouting-report?event_key=${encodeURIComponent(resolvedEventKey)}`, {
        headers: await getAuthHeader()
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) throw new Error(payload?.error || 'Could not load scouting strategy data.');
      report = payload;
      loadedEventKey = resolvedEventKey;
      if (!selectedTeamKey && buildStrategyRows(payload.data)[0]) selectedTeamKey = buildStrategyRows(payload.data)[0].teamKey;
    } catch (cause) {
      report = null;
      error = cause?.message || 'Could not load scouting strategy data.';
    } finally {
      loadedEventKey = resolvedEventKey;
      loading = false;
    }
  }

  onMount(async () => {
    [eventKey, availableEvents] = await Promise.all([fetchActiveScoutingEventKey(), fetchAvailableScoutingEvents()]);
    await loadStrategy();
  });

  $: if (resolvedEventKey && resolvedEventKey !== loadedEventKey && !loading) void loadStrategy();
</script>

<svelte:head><title>Strategy</title></svelte:head>

<div class="page-header strategy-header">
  <div>
    <span class="eyebrow">Competition</span>
    <h1><Target size={24} /> Strategy</h1>
    <p>One board for the scouting evidence behind match decisions.</p>
  </div>
  <div class="header-actions">
    <SeasonFilter options={availableEvents} bind:value={selectedEventKey} allLabel={`Current Event (${eventKey || 'not set'})`} />
    <button class="btn btn-outline" on:click={loadStrategy} disabled={loading || !resolvedEventKey}><RefreshCw size={16} /> Refresh</button>
  </div>
</div>

{#if !resolvedEventKey}
  <div class="empty-state">Set an active scouting event in Scouting Admin to build the strategy board.</div>
{:else if loading}
  <div class="empty-state">Loading strategy evidence...</div>
{:else if error}
  <div class="notice notice-error">{error}</div>
{:else}
  <section class="summary-grid" aria-label="Scouting coverage">
    <div><Users size={18} /><strong>{totals.teams}</strong><span>Teams represented</span></div>
    <div><ClipboardList size={18} /><strong>{totals.matchReports}</strong><span>Match reports</span></div>
    <div><MapPinned size={18} /><strong>{totals.pitProfiles}</strong><span>Pit profiles</span></div>
    <div><Route size={18} /><strong>{totals.autoPaths}</strong><span>Saved autos</span></div>
    <div class:at-risk={totals.openProblems > 0}><AlertTriangle size={18} /><strong>{totals.openProblems}</strong><span>Open ACE issues</span></div>
  </section>

  <section class="strategy-layout">
    <div class="strategy-board">
      <div class="section-heading">
        <div><h2>Team board</h2><p>Comparable observations from every scouting surface.</p></div>
        <input class="form-input team-search" bind:value={teamSearch} placeholder="Filter team or archetype" aria-label="Filter strategy teams" />
      </div>
      {#if !filteredRows.length}
        <div class="empty-state">No scouting evidence matches this filter yet.</div>
      {:else}
        <div class="board-table-wrap">
          <table class="board-table">
            <thead><tr><th>Team</th><th>Matches</th><th>Fuel</th><th>Accuracy</th><th>Auto</th><th>Pit</th><th>Notes</th><th>Autos</th><th>Risk</th></tr></thead>
            <tbody>
              {#each filteredRows as row}
                <tr class:selected={selectedTeam?.teamKey === row.teamKey} on:click={() => selectedTeamKey = row.teamKey}>
                  <td><strong>{row.teamNumber}</strong>{#if row.pitEntry?.robot_archetype}<small>{row.pitEntry.robot_archetype}</small>{/if}</td>
                  <td>{row.performance.matchesScouted || row.matchEntries.length || '-'}</td>
                  <td>{number(row.performance.avgFuel, 0)}</td>
                  <td>{number(row.performance.avgAccuracy)}</td>
                  <td>{number(row.autoAverage, 0)}</td>
                  <td>{row.pitEntry ? 'Yes' : '-'}</td>
                  <td>{row.notes.length || '-'}</td>
                  <td>{row.autoPaths.length || '-'}</td>
                  <td>{row.openProblems.length ? `${row.openProblems.length} open` : 'Clear'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>

    <aside class="team-brief" aria-live="polite">
      {#if selectedTeam}
        <div class="brief-title"><div><span class="eyebrow">Team brief</span><h2>Team {selectedTeam.teamNumber}</h2></div><span class:status-risk={selectedTeam.openProblems.length} class="coverage">{selectedTeam.coverage} observations</span></div>
        <div class="metric-grid">
          <div><span>Fuel / match</span><strong>{number(selectedTeam.performance.avgFuel, 0)}</strong></div>
          <div><span>Auto average</span><strong>{number(selectedTeam.autoAverage, 0)}</strong></div>
          <div><span>Auto ran</span><strong>{percent(selectedTeam.autoMobilityRate)}</strong></div>
          <div><span>Climb success</span><strong>{percent(selectedTeam.performance.climbSuccessRate)}</strong></div>
        </div>
        <div class="brief-section">
          <h3>Pit capability</h3>
          {#if selectedTeam.pitEntry}
            <p>{selectedTeam.pitEntry.robot_archetype || 'Archetype not recorded'}{selectedTeam.pitEntry.estimated_bps ? ` | ${selectedTeam.pitEntry.estimated_bps} estimated BPS` : ''}</p>
            {#if text(selectedTeam.pitEntry.additional_notes)}<p class="detail-copy">{selectedTeam.pitEntry.additional_notes}</p>{/if}
          {:else}<p class="muted">No pit profile yet.</p>{/if}
        </div>
        <div class="brief-section">
          <h3>Saved autonomous paths</h3>
          {#if selectedTeam.autoPaths.length}<ul>{#each selectedTeam.autoPaths.slice(0, 4) as path}<li>{path.name} <span>{path.alliance}</span></li>{/each}</ul>{:else}<p class="muted">No named auto path saved.</p>{/if}
        </div>
        <div class="brief-section">
          <h3>Scout notes</h3>
          {#if selectedTeam.notes.length}<ul>{#each selectedTeam.notes.slice(0, 3) as note}<li>{note.notes || note.note || 'Untitled note'}</li>{/each}</ul>{:else}<p class="muted">No notes yet.</p>{/if}
        </div>
        <div class="brief-section">
          <h3>ACE issues</h3>
          {#if selectedTeam.openProblems.length}<ul class="risk-list">{#each selectedTeam.openProblems as issue}<li><strong>{issue.severity || 'watch'}</strong> {issue.summary}</li>{/each}</ul>{:else}<p class="muted">No open issues.</p>{/if}
        </div>
        <div class="brief-actions">
          <a class="btn btn-outline btn-sm" href={`/teamview?event_key=${encodeURIComponent(resolvedEventKey)}`}>Open team view</a>
          <a class="btn btn-outline btn-sm" href={`/powerrankings`}>Power rankings</a>
        </div>
      {:else}<div class="empty-state">Select a team to view its strategy brief.</div>{/if}
    </aside>
  </section>
{/if}

<style>
  .strategy-header { display:flex; justify-content:space-between; gap:var(--space-4); align-items:flex-end; }
  .strategy-header h1 { display:flex; align-items:center; gap:var(--space-2); margin:0; }
  .strategy-header p, .section-heading p { margin:var(--space-1) 0 0; color:var(--text-secondary); }
  .header-actions { display:flex; gap:var(--space-2); align-items:center; flex-wrap:wrap; }
  .summary-grid { display:grid; grid-template-columns:repeat(5, minmax(0, 1fr)); border:1px solid var(--border); margin-top:var(--space-4); }
  .summary-grid > div { min-height:92px; padding:var(--space-3); border-right:1px solid var(--border); display:grid; grid-template-columns:auto 1fr; gap:0 var(--space-2); align-content:center; }
  .summary-grid > div:last-child { border-right:0; }
  .summary-grid svg { color:var(--brand-gold); grid-row:span 2; align-self:center; }
  .summary-grid strong { font-size:1.35rem; line-height:1.1; }
  .summary-grid span { color:var(--text-secondary); font-size:.82rem; }
  .summary-grid .at-risk svg, .summary-grid .at-risk strong { color:var(--status-danger); }
  .strategy-layout { display:grid; grid-template-columns:minmax(0, 1.7fr) minmax(290px, .8fr); gap:var(--space-4); margin-top:var(--space-4); align-items:start; }
  .strategy-board, .team-brief { border:1px solid var(--border); background:var(--surface); }
  .section-heading, .brief-title { display:flex; justify-content:space-between; gap:var(--space-3); align-items:center; padding:var(--space-3); border-bottom:1px solid var(--border); }
  h2, h3 { margin:0; }
  .team-search { width:min(260px, 100%); }
  .board-table-wrap { overflow:auto; }
  .board-table { width:100%; border-collapse:collapse; font-size:.9rem; }
  th { background:var(--surface-muted); color:var(--text-secondary); font-size:.72rem; letter-spacing:.04em; text-align:left; text-transform:uppercase; white-space:nowrap; }
  th, td { padding:.7rem var(--space-2); border-bottom:1px solid var(--border); }
  tbody tr { cursor:pointer; }
  tbody tr:hover, tbody tr.selected { background:var(--brand-gold-soft); }
  td small { display:block; color:var(--text-secondary); margin-top:2px; }
  .coverage { white-space:nowrap; color:var(--text-secondary); font-size:.8rem; }
  .coverage.status-risk { color:var(--status-danger); font-weight:700; }
  .metric-grid { display:grid; grid-template-columns:repeat(2, 1fr); border-bottom:1px solid var(--border); }
  .metric-grid div { padding:var(--space-3); border-right:1px solid var(--border); border-bottom:1px solid var(--border); display:grid; gap:var(--space-1); }
  .metric-grid div:nth-child(2n) { border-right:0; }
  .metric-grid span, .muted { color:var(--text-secondary); font-size:.82rem; }
  .metric-grid strong { font-size:1.2rem; }
  .brief-section { padding:var(--space-3); border-bottom:1px solid var(--border); }
  .brief-section h3 { font-size:.9rem; margin-bottom:var(--space-1); }
  .brief-section p { margin:0; line-height:1.45; }
  .detail-copy { margin-top:var(--space-2) !important; color:var(--text-secondary); }
  ul { margin:0; padding-left:1.1rem; display:grid; gap:.35rem; }
  li span { color:var(--text-secondary); font-size:.8rem; text-transform:capitalize; }
  .risk-list strong { color:var(--status-danger); text-transform:capitalize; }
  .brief-actions { display:flex; gap:var(--space-2); padding:var(--space-3); flex-wrap:wrap; }
  .empty-state, .notice { border:1px solid var(--border); padding:var(--space-4); margin-top:var(--space-4); color:var(--text-secondary); }
  .notice-error { border-color:var(--status-danger); color:var(--status-danger); }
  @media (max-width:900px) { .summary-grid { grid-template-columns:repeat(3, 1fr); } .summary-grid > div:nth-child(3) { border-right:0; } .strategy-layout { grid-template-columns:1fr; } }
  @media (max-width:620px) { .strategy-header, .section-heading { align-items:stretch; flex-direction:column; } .header-actions > * { flex:1; } .summary-grid { grid-template-columns:repeat(2, 1fr); } .summary-grid > div { border-bottom:1px solid var(--border); } .summary-grid > div:nth-child(2n) { border-right:0; } .team-search { width:100%; } }
</style>
