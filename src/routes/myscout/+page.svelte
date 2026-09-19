<script>
  import { onMount } from 'svelte';
  import { ClipboardCheck, RefreshCw, Wrench } from 'lucide-svelte';
  import { getAuthHeader } from '$lib/supabase.js';

  let matchReports = [];
  let pitReports = [];
  let loading = true;
  let error = '';

  async function load() {
    loading = true;
    error = '';
    try {
      const headers = await getAuthHeader();
      const [matchRes, pitRes] = await Promise.all([
        fetch('/api/matchscout?mine=1', { headers }).then((r) => r.json()).catch(() => null),
        fetch('/pitscout?mine=1', { headers }).then((r) => r.json()).catch(() => null)
      ]);
      matchReports = matchRes?.success ? matchRes.data || [] : [];
      pitReports = pitRes?.success ? pitRes.data || [] : [];
      if (!matchRes?.success && !pitRes?.success) {
        error = matchRes?.error || pitRes?.error || 'Could not load your scouting history.';
      }
    } catch (exception) {
      error = exception?.message || 'Could not load your scouting history.';
    } finally {
      loading = false;
    }
  }

  onMount(load);

  const teamNumber = (key) => String(key || '').replace(/^frc/i, '');

  function fmtDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  }

  $: teamsCovered = new Set([...matchReports, ...pitReports].map((r) => r.team_key).filter(Boolean)).size;
  $: eventsCovered = new Set([...matchReports, ...pitReports].map((r) => r.event_key).filter(Boolean)).size;
  $: sortedMatchReports = [...matchReports].sort((a, b) =>
    String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
  $: sortedPitReports = [...pitReports].sort((a, b) =>
    String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
</script>

<svelte:head><title>My Scout</title></svelte:head>

<div class="myscout-page">
  <header class="myscout-header">
    <div>
      <h1><ClipboardCheck size={22} /> My Scout</h1>
      <p>Every match and pit report you've personally submitted, across every event.</p>
    </div>
    <button class="btn btn-outline" on:click={load} disabled={loading}><RefreshCw size={16} /> Refresh</button>
  </header>

  {#if loading}
    <div class="empty-state">Loading your scouting history...</div>
  {:else if error}
    <div class="notice notice-error">{error}</div>
  {:else}
    <div class="stat-strip">
      <div class="stat-tile">
        <span class="stat-label">Match Reports</span>
        <strong class="stat-value">{matchReports.length}</strong>
      </div>
      <div class="stat-tile">
        <span class="stat-label">Pit Reports</span>
        <strong class="stat-value">{pitReports.length}</strong>
      </div>
      <div class="stat-tile">
        <span class="stat-label">Teams Covered</span>
        <strong class="stat-value">{teamsCovered}</strong>
      </div>
      <div class="stat-tile">
        <span class="stat-label">Events</span>
        <strong class="stat-value">{eventsCovered}</strong>
      </div>
    </div>

    <section class="report-section">
      <h2><ClipboardCheck size={18} /> Match Reports</h2>
      {#if sortedMatchReports.length === 0}
        <p class="muted">No match reports submitted yet. Head to <a href="/matchscout">Match Scouting</a> to start one.</p>
      {:else}
        <div class="report-grid">
          {#each sortedMatchReports as r (r.id)}
            <a class="report-card" href={`/matchscout?match=${encodeURIComponent(r.match_key)}&team=${encodeURIComponent(r.team_key)}`}>
              <span class="report-event">{r.event_key}</span>
              <h4>Match {r.match_key} &middot; Team {teamNumber(r.team_key)}</h4>
              <p class="muted">
                {#if r.alliance}<span class="alliance-chip" class:red={r.alliance === 'red'} class:blue={r.alliance === 'blue'}>{r.alliance}</span>{/if}
                {fmtDate(r.updated_at || r.created_at)}
              </p>
            </a>
          {/each}
        </div>
      {/if}
    </section>

    <section class="report-section">
      <h2><Wrench size={18} /> Pit Scouting Reports</h2>
      {#if sortedPitReports.length === 0}
        <p class="muted">No pit scouting reports submitted yet. Head to <a href="/pitscout">Pit Scouting</a> to start one.</p>
      {:else}
        <div class="report-grid">
          {#each sortedPitReports as r (r.event_key + '::' + r.team_key)}
            <a class="report-card pit" href={`/pitscout?event_key=${encodeURIComponent(r.event_key)}&team_key=${encodeURIComponent(r.team_key)}`}>
              <span class="report-event">{r.event_key}</span>
              <h4>Team {teamNumber(r.team_key)}</h4>
              <p class="muted">{r.robot_archetype || r.drivebase_type || 'Pit report'} &middot; {fmtDate(r.updated_at || r.created_at)}</p>
            </a>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  .myscout-page {
    --home-radius: 0;
    max-width: 1200px;
    margin: var(--space-7) auto;
    padding: 0 var(--space-4);
  }

  .myscout-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-4);
    flex-wrap: wrap;
    margin-bottom: var(--space-5);
  }

  .myscout-header h1 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
  }

  .myscout-header p {
    margin: var(--space-1) 0 0;
    color: var(--text-secondary);
  }

  .stat-strip {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 1px;
    background: var(--border);
    border: 1px solid var(--border);
    margin-bottom: var(--space-6);
  }

  .stat-tile {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    background: var(--surface-1);
    padding: var(--space-4) var(--space-5);
  }

  .stat-label {
    font-family: var(--font-mono-stack);
    font-size: var(--font-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  .stat-value {
    font-size: var(--font-xxl, 1.75rem);
    font-weight: 700;
    color: var(--secondary);
    line-height: 1.1;
  }

  .report-section {
    margin-bottom: var(--space-7);
  }

  .report-section h2 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0 0 var(--space-3);
    color: var(--secondary);
    font-size: var(--font-lg);
  }

  .report-section .muted {
    color: var(--text-secondary);
  }

  .report-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--gap-3);
  }

  .report-card {
    display: block;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-left: 3px solid var(--brand-gold-strong);
    padding: var(--space-4) var(--space-5);
    text-decoration: none;
    color: inherit;
    transition: border-color 0.1s ease, background-color 0.1s ease;
  }

  .report-card.pit {
    border-left-color: var(--accent-strong, #4a6fa5);
  }

  .report-card:hover {
    background: var(--surface-2);
    border-color: var(--accent-strong);
  }

  .report-event {
    display: block;
    font-family: var(--font-mono-stack);
    font-size: var(--font-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: var(--space-1);
  }

  .report-card h4 {
    margin: 0 0 var(--space-1) 0;
    color: var(--secondary);
    font-size: var(--font-md);
  }

  .report-card p {
    margin: 0;
    font-size: var(--font-xs);
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .alliance-chip {
    text-transform: uppercase;
    font-size: var(--font-xs);
    font-weight: 700;
    padding: 1px 6px;
  }

  .alliance-chip.red { color: var(--red-strong); background: var(--red-soft); }
  .alliance-chip.blue { color: var(--blue-strong, #174ea6); background: var(--blue-soft, #e8f1ff); }

  .empty-state, .notice {
    border: 1px solid var(--border);
    padding: var(--space-4);
    color: var(--text-secondary);
  }

  .notice-error { border-color: var(--danger, #dc3545); color: var(--danger, #dc3545); }

  @media (max-width: 600px) {
    .myscout-header { flex-direction: column; align-items: stretch; }
  }
</style>
