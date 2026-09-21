<script>
  import { Flame, Trophy, Clock, Target, CheckCircle2, Radio, Video } from 'lucide-svelte';
  import { getAuthHeader } from '$lib/supabase.js';
  import { eventWebcastEmbed } from '$lib/tbaMedia.js';
  import { pmEvents, pmEventKey, pmMyElo } from '$lib/stores/predictionMarketEvent.js';

  let loading = true;
  let error = '';
  let matches = [];

  $: selectedEvent = $pmEvents.find((event) => event.key === $pmEventKey) || null;
  $: webcast = selectedEvent ? eventWebcastEmbed(selectedEvent.webcasts) : null;
  $: upcoming = matches.filter((m) => m.status !== 'completed');
  $: myPicks = matches.filter((m) => m.my_pick && m.status !== 'completed');

  async function loadDashboard(eventKey) {
    if (!eventKey) { loading = false; return; }
    loading = true;
    error = '';
    try {
      const authHeaders = await getAuthHeader();
      const response = await fetch(`/api/prediction-market-v2/dashboard?event_key=${encodeURIComponent(eventKey)}`, { headers: authHeaders });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error || 'Could not load the dashboard.');
      matches = result.matches || [];
      pmMyElo.set({ elo: result.elo, elo_delta_event: result.elo_delta_event, accuracy: result.accuracy, scored_predictions: result.scored_predictions });
    } catch (cause) {
      error = cause?.message || 'Could not load the dashboard.';
    } finally {
      loading = false;
    }
  }

  $: loadDashboard($pmEventKey);

  function deltaFor(match) {
    // Placeholder "model movement" number until the backend tracks a real
    // probability-over-time series per match - see elo_history_series in
    // the plan doc's contract for the real shape this becomes.
    return Math.round((match.model_probability_red - 0.5) * 100 - (match.match_key.charCodeAt(2) % 15));
  }

  function reveal(node, { delay = 0 }) {
    return { delay, duration: 260, css: (t) => `opacity: ${t}; transform: translateY(${(1 - t) * 6}px)` };
  }
</script>

<svelte:head><title>Prediction Market</title></svelte:head>

{#if !selectedEvent}
  <p class="pm-empty">{loading ? 'Loading…' : 'Pick a current event above to get started.'}</p>
{:else if error}
  <p class="pm-empty">{error}</p>
{:else}
<div class="pm-dashboard">
  <div class="pm-main-col">
    <div class="pm-stat-row">
      <div class="pm-stat">
        <span class="pm-stat-label"><Trophy size={13} /> Event Elo Δ</span>
        <strong class="pm-stat-value" class:pm-positive={($pmMyElo?.elo_delta_event ?? 0) >= 0}>{($pmMyElo?.elo_delta_event ?? 0) >= 0 ? '+' : ''}{Math.round($pmMyElo?.elo_delta_event ?? 0)}</strong>
      </div>
      <div class="pm-stat">
        <span class="pm-stat-label"><Clock size={13} /> Active Predictions</span>
        <strong class="pm-stat-value">{myPicks.length}</strong>
      </div>
      <div class="pm-stat">
        <span class="pm-stat-label"><Target size={13} /> Accuracy</span>
        <strong class="pm-stat-value">{$pmMyElo?.accuracy != null ? `${Math.round($pmMyElo.accuracy * 100)}%` : '—'}</strong>
      </div>
      <div class="pm-stat">
        <span class="pm-stat-label"><CheckCircle2 size={13} /> Scored Predictions</span>
        <strong class="pm-stat-value">{$pmMyElo?.scored_predictions ?? 0}</strong>
      </div>
    </div>

    <section class="pm-panel">
      <div class="pm-panel-header">
        <h2><Flame size={15} /> Match Watch</h2>
        <a href="/predictions/matches" class="pm-link">View All</a>
      </div>
      <div class="pm-table-scroll">
        <table class="pm-table">
          <thead>
            <tr>
              <th>Match</th>
              <th>Teams</th>
              <th class="pm-num">Model</th>
              <th class="pm-num">Delta</th>
              <th class="pm-action-col"></th>
            </tr>
          </thead>
          <tbody>
            {#each upcoming as m, i}
              {@const d = deltaFor(m)}
              <tr in:reveal={{ delay: i * 35 }}>
                <td class="pm-match-key"><a href="/predictions/matches/{m.match_key}">{m.match_key.toUpperCase()}</a></td>
                <td class="pm-teams">
                  <span class="pm-alliance pm-alliance-red">{m.red_teams.join(' · ')}</span>
                  <span class="pm-alliance pm-alliance-blue">{m.blue_teams.join(' · ')}</span>
                </td>
                <td class="pm-num pm-model">{Math.round(m.model_probability_red * 100)}%</td>
                <td class="pm-num" class:pm-positive={d >= 0} class:pm-negative={d < 0}>{d >= 0 ? '+' : ''}{d}</td>
                <td class="pm-action-col"><a href="/predictions/matches/{m.match_key}" class="pm-btn pm-btn-accent">Predict</a></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section class="pm-panel">
      <div class="pm-panel-header">
        <h2>My Predictions</h2>
        <a href="/predictions/mine" class="pm-link">View All</a>
      </div>
      {#if myPicks.length}
        <div class="pm-table-scroll">
          <table class="pm-table">
            <thead><tr><th>Match</th><th>Alliance</th><th class="pm-num">Elo Δ</th></tr></thead>
            <tbody>
              {#each myPicks as m}
                <tr>
                  <td class="pm-match-key">{m.match_key.toUpperCase()}</td>
                  <td><span class="pm-side-chip pm-side-{m.my_pick}">{m.my_pick}</span></td>
                  <td class="pm-num pm-active-tag">active</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <p class="pm-empty">No open predictions - pick a match above.</p>
      {/if}
    </section>
  </div>

  <aside class="pm-rail">
    <section class="pm-panel pm-stream-panel">
      <div class="pm-panel-header">
        <h2><Radio size={14} class="pm-pulse" /> {selectedEvent.live ? 'Live now' : 'Event Stream'}</h2>
      </div>
      <div class="pm-stream-placeholder" class:pm-stream-live={webcast?.embedUrl}>
        {#if webcast?.embedUrl}
          <iframe
            class="pm-stream-iframe"
            src={webcast.embedUrl}
            title="Event livestream"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowfullscreen
          ></iframe>
        {:else if webcast?.linkUrl}
          <span class="pm-live-dot"></span>
          <p><Video size={14} /> <a class="pm-link" href={webcast.linkUrl} target="_blank" rel="noreferrer">Watch on {selectedEvent.webcasts?.[0]?.type}</a></p>
        {:else}
          <span class="pm-live-dot"></span>
          <p>No stream published for this event yet.</p>
        {/if}
      </div>
      <div class="pm-reactions">
        {#each ['🔥', '👏', '🤖', '❤️', '😮', '🎉'] as emoji}
          <button type="button" class="pm-reaction-btn">{emoji}</button>
        {/each}
      </div>
    </section>
  </aside>
</div>
{/if}

<style>
  .pm-dashboard {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(680px, 900px);
    gap: 1.25rem;
    align-items: start;
  }

  .pm-main-col { display: flex; flex-direction: column; gap: 1.25rem; min-width: 0; }
  .pm-rail { position: sticky; top: 4.5rem; }

  .pm-stat-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1px;
    background: var(--pm-border);
    border: 1px solid var(--pm-border);
  }
  .pm-stat {
    background: var(--pm-surface);
    padding: 0.9rem 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .pm-stat-label {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    color: var(--pm-muted);
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .pm-stat-value {
    font-family: var(--pm-font-mono);
    font-size: 1.5rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .pm-stat-value.pm-positive { color: var(--pm-green); }

  .pm-panel { background: var(--pm-surface); border: 1px solid var(--pm-border); }
  .pm-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1.1rem;
    border-bottom: 1px solid var(--pm-border);
    background: var(--pm-surface-raised);
  }
  .pm-panel-header h2 {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin: 0;
    font-family: var(--pm-font-mono);
    font-size: 0.85rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .pm-link { color: var(--pm-accent); text-decoration: none; font-size: 0.78rem; }
  .pm-link:hover { text-decoration: underline; }

  .pm-table-scroll { overflow-x: auto; }
  .pm-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  .pm-table th {
    text-align: left;
    padding: 0.6rem 1.1rem;
    color: var(--pm-muted);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
    border-bottom: 1px solid var(--pm-border);
  }
  .pm-table th.pm-num { text-align: right; }
  .pm-table td { padding: 0.65rem 1.1rem; border-bottom: 1px solid var(--pm-border-soft); }
  .pm-table tbody tr:last-child td { border-bottom: none; }
  .pm-table tbody tr:hover { background: var(--pm-surface-raised); }
  .pm-num { text-align: right; font-family: var(--pm-font-mono); font-variant-numeric: tabular-nums; }
  .pm-match-key a { color: var(--pm-text); text-decoration: none; font-family: var(--pm-font-mono); font-weight: 600; }
  .pm-match-key a:hover { color: var(--pm-accent); }
  .pm-teams { display: flex; flex-direction: column; gap: 0.15rem; font-family: var(--pm-font-mono); font-size: 0.76rem; }
  .pm-alliance-red { color: var(--pm-red); }
  .pm-alliance-blue { color: var(--pm-blue); }
  .pm-model { color: var(--pm-accent); font-weight: 600; }
  .pm-positive { color: var(--pm-green); }
  .pm-negative { color: var(--pm-red); }
  .pm-action-col { text-align: right; }
  .pm-active-tag { color: var(--pm-accent); font-family: var(--pm-font-sans); text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.04em; }

  .pm-btn-accent {
    display: inline-block;
    padding: 0.4rem 0.85rem;
    background: var(--pm-accent);
    color: #16130a;
    text-decoration: none;
    font-size: 0.78rem;
    font-weight: 600;
    transition: filter 0.12s ease, transform 0.12s ease;
  }
  .pm-btn-accent:hover { filter: brightness(1.1); transform: translateY(-1px); }

  .pm-side-chip {
    display: inline-block;
    padding: 0.15rem 0.55rem;
    font-family: var(--pm-font-mono);
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
  }
  .pm-side-red { background: var(--pm-red-soft); color: var(--pm-red); }
  .pm-side-blue { background: var(--pm-blue-soft); color: var(--pm-blue); }

  .pm-empty { padding: 1.5rem 1.1rem; color: var(--pm-muted); font-size: 0.85rem; margin: 0; }

  /* Live/streaming rail */
  .pm-stream-panel { display: flex; flex-direction: column; }
  .pm-stream-placeholder {
    aspect-ratio: 16 / 9;
    min-height: 720px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    background: #05070c;
    border-bottom: 1px solid var(--pm-border);
    color: var(--pm-muted);
    text-align: center;
    padding: 1.5rem;
  }
  .pm-stream-placeholder.pm-stream-live { padding: 0; }
  .pm-stream-iframe { width: 100%; height: 100%; border: 0; display: block; }
  .pm-stream-placeholder p { margin: 0; font-size: 0.9rem; max-width: 320px; }
  .pm-live-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--pm-red);
    animation: pm-blink 1.6s ease-in-out infinite;
  }
  @keyframes pm-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
  :global(.pm-pulse) { animation: pm-blink 1.8s ease-in-out infinite; }

  .pm-reactions {
    display: flex;
    gap: 0.4rem;
    padding: 0.75rem 1.1rem;
    border-bottom: 1px solid var(--pm-border);
  }
  .pm-reaction-btn {
    flex: 1;
    padding: 0.4rem 0;
    background: var(--pm-surface-raised);
    border: 1px solid var(--pm-border);
    font-size: 1rem;
    cursor: pointer;
    transition: transform 0.12s ease, border-color 0.12s ease;
  }
  .pm-reaction-btn:hover { transform: translateY(-2px) scale(1.08); border-color: var(--pm-accent); }

  @media (max-width: 1050px) {
    .pm-dashboard { grid-template-columns: 1fr; }
    .pm-rail { position: static; }
    .pm-stat-row { grid-template-columns: repeat(2, 1fr); }
  }
</style>
