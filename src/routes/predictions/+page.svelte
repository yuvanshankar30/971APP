<script>
  import { onMount } from 'svelte';
  import { Flame, Trophy, Clock, Target, CheckCircle2, Radio, Pencil, X } from 'lucide-svelte';
  import { MOCK_ELO, MOCK_MATCHES, MOCK_MY_PICKS, MOCK_LIVE_FEED } from '$lib/predictionMarketV2Mock.js';

  // TODO(backend): GET /api/prediction-market-v2/dashboard?event_key=...
  const elo = MOCK_ELO;
  const upcoming = MOCK_MATCHES.filter((m) => m.status === 'upcoming');
  const myPicks = MOCK_MY_PICKS.filter((p) => !p.locked);

  function deltaFor(match) {
    // Placeholder "model movement" number until the backend tracks a real
    // probability-over-time series per match - see elo_history_series in
    // the plan doc's contract for the real shape this becomes.
    return Math.round((match.model_probability_red - 0.5) * 100 - (match.match_key.charCodeAt(2) % 15));
  }

  function reveal(node, { delay = 0 }) {
    return { delay, duration: 260, css: (t) => `opacity: ${t}; transform: translateY(${(1 - t) * 6}px)` };
  }

  // Livestream embed - no backend field for this yet (the dashboard
  // contract doesn't carry a stream URL per event), so this is stored
  // per-browser like recentTabs.js does elsewhere in the app. Whoever is
  // watching pastes the event's real YouTube link once and it embeds here
  // for the rest of the session.
  const STREAM_STORAGE_KEY = 'spartanshub_pm_stream_url';
  let streamInput = '';
  let streamEmbedId = null;
  let editingStream = false;

  function extractYouTubeId(raw) {
    const trimmed = (raw || '').trim();
    if (!trimmed) return null;
    if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
    try {
      const url = new URL(trimmed);
      if (url.hostname.includes('youtu.be')) return url.pathname.slice(1) || null;
      if (url.hostname.includes('youtube.com')) {
        if (url.searchParams.get('v')) return url.searchParams.get('v');
        const match = url.pathname.match(/\/(?:live|embed|shorts)\/([\w-]{11})/);
        if (match) return match[1];
      }
    } catch {
      return null;
    }
    return null;
  }

  onMount(() => {
    try {
      const saved = localStorage.getItem(STREAM_STORAGE_KEY);
      if (saved) {
        streamInput = saved;
        streamEmbedId = extractYouTubeId(saved);
      }
    } catch {
      // localStorage can throw in a private window - the panel just falls
      // back to "no stream set" for that viewer.
    }
  });

  let streamError = '';
  function saveStream() {
    const id = extractYouTubeId(streamInput);
    if (!id) {
      streamError = "That doesn't look like a YouTube video/live link.";
      return;
    }
    streamError = '';
    streamEmbedId = id;
    editingStream = false;
    try { localStorage.setItem(STREAM_STORAGE_KEY, streamInput.trim()); } catch {}
  }

  function clearStream() {
    streamEmbedId = null;
    streamInput = '';
    streamError = '';
    try { localStorage.removeItem(STREAM_STORAGE_KEY); } catch {}
  }
</script>

<svelte:head><title>Prediction Market</title></svelte:head>

<div class="pm-dashboard">
  <div class="pm-main-col">
    <div class="pm-stat-row">
      <div class="pm-stat">
        <span class="pm-stat-label"><Trophy size={13} /> Event Elo Δ</span>
        <strong class="pm-stat-value" class:pm-positive={elo.elo_delta_event >= 0}>{elo.elo_delta_event >= 0 ? '+' : ''}{elo.elo_delta_event}</strong>
      </div>
      <div class="pm-stat">
        <span class="pm-stat-label"><Clock size={13} /> Active Predictions</span>
        <strong class="pm-stat-value">{elo.active_predictions}</strong>
      </div>
      <div class="pm-stat">
        <span class="pm-stat-label"><Target size={13} /> Accuracy</span>
        <strong class="pm-stat-value">{elo.accuracy != null ? `${Math.round(elo.accuracy * 100)}%` : '—'}</strong>
      </div>
      <div class="pm-stat">
        <span class="pm-stat-label"><CheckCircle2 size={13} /> Scored Predictions</span>
        <strong class="pm-stat-value">{elo.scored_predictions}</strong>
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
              {#each myPicks as p}
                <tr>
                  <td class="pm-match-key">{p.match_key.toUpperCase()}</td>
                  <td><span class="pm-side-chip pm-side-{p.side}">{p.side}</span></td>
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
        <h2><Radio size={14} class="pm-pulse" /> Event Stream</h2>
        <button type="button" class="pm-link pm-stream-toggle" on:click={() => (editingStream = !editingStream)}>
          {#if editingStream}<X size={12} /> Cancel{:else}<Pencil size={12} /> {streamEmbedId ? 'Edit' : 'Set link'}{/if}
        </button>
      </div>
      {#if editingStream}
        <form class="pm-stream-form" on:submit|preventDefault={saveStream}>
          <input type="text" placeholder="Paste the event's YouTube link" bind:value={streamInput} />
          <button type="submit" class="pm-btn-accent">Save</button>
          {#if streamEmbedId}
            <button type="button" class="pm-stream-remove" on:click={clearStream}>Remove</button>
          {/if}
        </form>
        {#if streamError}<p class="pm-stream-error">{streamError}</p>{/if}
      {/if}
      <div class="pm-stream-placeholder" class:pm-stream-live={streamEmbedId}>
        {#if streamEmbedId}
          <iframe
            class="pm-stream-iframe"
            src="https://www.youtube.com/embed/{streamEmbedId}?autoplay=0&rel=0"
            title="Event livestream"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowfullscreen
          ></iframe>
        {:else}
          <span class="pm-live-dot"></span>
          <p>No stream set for this event yet - paste a YouTube link above to watch here.</p>
        {/if}
      </div>
      <div class="pm-reactions">
        {#each ['🔥', '👏', '🤖', '❤️', '😮', '🎉'] as emoji}
          <button type="button" class="pm-reaction-btn">{emoji}</button>
        {/each}
      </div>
      <div class="pm-live-feed">
        <h3>Live Predictions</h3>
        <ul>
          {#each MOCK_LIVE_FEED as entry, i}
            <li in:reveal={{ delay: i * 40 }}>
              <span class="pm-feed-user">{entry.user}</span> picked
              <span class="pm-side-chip pm-side-{entry.side}">{entry.side}</span>
              · <span class="pm-feed-match">{entry.match_key}</span>
            </li>
          {/each}
        </ul>
      </div>
    </section>
  </aside>
</div>

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
  .pm-stream-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    background: none;
    border: none;
    cursor: pointer;
    font: inherit;
  }
  .pm-stream-form {
    display: flex;
    gap: 0.5rem;
    padding: 0.75rem 1.1rem;
    border-bottom: 1px solid var(--pm-border);
    flex-wrap: wrap;
  }
  .pm-stream-form input {
    flex: 1;
    min-width: 160px;
    padding: 0.45rem 0.6rem;
    background: var(--pm-surface-raised);
    border: 1px solid var(--pm-border);
    color: var(--pm-text);
    font: inherit;
    font-family: var(--pm-font-mono);
    font-size: 0.8rem;
  }
  .pm-stream-form input:focus { outline: none; border-color: var(--pm-accent); }
  .pm-stream-remove {
    padding: 0.45rem 0.75rem;
    background: none;
    border: 1px solid var(--pm-border);
    color: var(--pm-muted);
    font-size: 0.78rem;
    cursor: pointer;
  }
  .pm-stream-remove:hover { border-color: var(--pm-red); color: var(--pm-red); }
  .pm-stream-error { margin: 0; padding: 0 1.1rem 0.75rem; color: var(--pm-red); font-size: 0.78rem; }
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

  .pm-live-feed { padding: 0.9rem 1.1rem 1.1rem; }
  .pm-live-feed h3 {
    margin: 0 0 0.6rem;
    font-family: var(--pm-font-mono);
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--pm-muted);
  }
  .pm-live-feed ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.55rem; }
  .pm-live-feed li { font-size: 0.8rem; color: var(--pm-muted); line-height: 1.4; }
  .pm-feed-user { color: var(--pm-text); font-weight: 600; }
  .pm-feed-match { font-family: var(--pm-font-mono); color: var(--pm-text); }

  @media (max-width: 1050px) {
    .pm-dashboard { grid-template-columns: 1fr; }
    .pm-rail { position: static; }
    .pm-stat-row { grid-template-columns: repeat(2, 1fr); }
  }
</style>
