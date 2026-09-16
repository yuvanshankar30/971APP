<script>
  import { onMount } from 'svelte';
  import { Activity, BarChart3, Coins, RefreshCw, Trophy, TrendingUp } from 'lucide-svelte';
  import { fetchActiveScoutingEventKey } from '$lib/scoutingEvent.js';
  import { getAuthHeader, supabase } from '$lib/supabase.js';
  import { availableBalance, marketSummary, summarizeStandings } from '$lib/predictionMarket.js';
  import { isMatchPlayed, matchLabel } from '$lib/matchProjection.js';

  let eventKey = ''; let loading = true; let warning = ''; let matches = []; let positions = []; let ticks = []; let userId = null; let names = new Map();
  let selectedKey = 'qualification-rank-1'; let outcome = ''; let stake = 25; let saving = false; let message = '';
  const teamNumber = (key) => String(key || '').replace(/^frc/, '');
  const points = (value) => `${Math.round(Number(value || 0)).toLocaleString()} pts`;
  const cents = (value) => `${Math.round(value * 100)}¢`;
  $: upcoming = matches.filter((match) => !isMatchPlayed(match));
  $: teamKeys = [...new Set(matches.flatMap((match) => [...(match.alliances?.red?.team_keys || []), ...(match.alliances?.blue?.team_keys || [])]))].sort((a, b) => Number(teamNumber(a)) - Number(teamNumber(b)));
  $: markets = [{ key: 'qualification-rank-1', type: 'qualification_rank', title: 'Who finishes #1 after quals?', subtitle: 'Settlement waits until every qualification match is posted.', outcomes: teamKeys }].concat(upcoming.map((match) => ({ key: `match:${match.key}`, type: 'match_winner', title: `${matchLabel(match)} — winner`, subtitle: `${match.alliances?.red?.team_keys?.map(teamNumber).join(' · ')} vs ${match.alliances?.blue?.team_keys?.map(teamNumber).join(' · ')}`, outcomes: ['red', 'blue'] })));
  $: market = markets.find((item) => item.key === selectedKey) || markets[0];
  $: summary = market ? marketSummary(positions.filter((position) => !position.resolved_at), market.key) : { total: 0, traders: 0, outcomes: [] };
  $: mine = market && positions.find((position) => position.market_key === market.key && position.created_by === userId && !position.resolved_at);
  $: balance = availableBalance(positions, userId);
  $: standings = summarizeStandings(positions).slice(0, 5);
  $: if (market && !market.outcomes.includes(outcome)) outcome = mine?.outcome_key || market.outcomes[0] || '';
  $: marketTicks = ticks.filter((tick) => tick.market_key === market?.key);
  function displayName(id) { return id === userId ? 'You' : names.get(id) || 'Scout'; }
  function label(key) { return key === 'red' ? 'Red alliance' : key === 'blue' ? 'Blue alliance' : `Team ${teamNumber(key)}`; }
  function selectMarket(key) { selectedKey = key; message = ''; }
  function pathFor(key) {
    const data = marketTicks.map((tick) => { const total = Object.values(tick.pools || {}).reduce((sum, value) => sum + Number(value), 0); return total ? Number(tick.pools?.[key] || 0) / total : 0; });
    return data.length ? data.map((value, index) => `${index ? 'L' : 'M'} ${8 + (index * 224 / Math.max(data.length - 1, 1))} ${82 - value * 68}`).join(' ') : '';
  }
  async function load() {
    loading = true; warning = ''; const headers = await getAuthHeader();
    const [marketResponse, matchesResponse] = await Promise.all([fetch(`/api/prediction-market?event_key=${encodeURIComponent(eventKey)}`, { headers }), fetch(`/api/tba/event-matches?event_key=${encodeURIComponent(eventKey)}&comp_level=all`)]);
    const data = await marketResponse.json().catch(() => null); const schedule = await matchesResponse.json().catch(() => null);
    if (data?.success) { positions = data.data?.positions || []; ticks = data.data?.ticks || []; if (data.unavailable) warning = 'The v2 market migration has not been applied yet.'; } else warning = data?.error || 'Could not load market data.';
    matches = schedule?.success ? schedule.data || [] : []; if (!schedule?.success) warning ||= schedule?.error || 'Could not load the match schedule.'; loading = false;
  }
  async function trade() {
    if (!market || !outcome) return; saving = true; message = ''; const headers = await getAuthHeader();
    const response = await fetch('/api/prediction-market', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ event_key: eventKey, market_key: market.key, market_type: market.type, outcome_key: outcome, stake }) });
    const data = await response.json().catch(() => null); saving = false; if (!response.ok || !data?.success) { message = data?.error || 'Trade could not be saved.'; return; } message = mine ? 'Position updated.' : 'Position opened.'; await load();
  }
  async function cancel() {
    if (!mine) return; saving = true; const headers = await getAuthHeader(); const response = await fetch('/api/prediction-market', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'cancel', id: mine.id }) });
    saving = false; message = response.ok ? 'Position closed.' : 'Could not close position.'; await load();
  }
  onMount(async () => { const { data } = await supabase.auth.getUser(); userId = data?.user?.id || null; const { data: people } = await supabase.from('user_profiles').select('id,full_name,email'); names = new Map((people || []).map((person) => [person.id, person.full_name || person.email])); eventKey = await fetchActiveScoutingEventKey(); if (eventKey) await load(); else loading = false; });
</script>

<svelte:head><title>Prediction Market</title></svelte:head>
<div class="page-header"><div><span class="eyebrow">Competition intelligence</span><h1><TrendingUp size={24} /> Prediction market</h1><p>Put points behind your read of the field. Prices move only when scouts commit.</p></div>{#if eventKey}<button class="btn btn-outline" on:click={load} disabled={loading}><RefreshCw size={15} /> Refresh</button>{/if}</div>
{#if loading}<div class="empty-state">Loading live market data…</div>
{:else if !eventKey}<div class="empty-state"><Coins size={36} /><h3>No active scouting event</h3><p>Set one in Scouting Admin before opening a market.</p></div>
{:else}
  {#if warning}<div class="notice notice-warning">{warning}</div>{/if}
  <section class="account-strip"><div><span>Available to deploy</span><strong>{points(balance)}</strong></div><div><span>Market liquidity</span><strong>{points(positions.filter((position) => !position.resolved_at).reduce((sum, position) => sum + Number(position.stake), 0))}</strong></div><div><span>Open positions</span><strong>{positions.filter((position) => position.created_by === userId && !position.resolved_at).length}</strong></div><div><span>Markets live</span><strong>{markets.length}</strong></div></section>
  <div class="market-layout">
    <aside class="market-rail"><div class="rail-title"><Activity size={16} /> Live markets</div>{#each markets as item (item.key)}{@const info = marketSummary(positions.filter((position) => !position.resolved_at), item.key)}<button class:active={item.key === market?.key} on:click={() => selectMarket(item.key)}><strong>{item.title}</strong><small>{item.type === 'qualification_rank' ? 'Season future' : item.subtitle}</small><span>{info.total ? `${points(info.total)} traded` : 'New market'}</span></button>{/each}</aside>
    {#if market}<main class="market-card"><div class="market-head"><div><span class="eyebrow">{market.type === 'qualification_rank' ? 'Qualification future' : 'Match market'}</span><h2>{market.title}</h2><p>{market.subtitle}</p></div><div class="liquidity"><span>Liquidity</span><strong>{points(summary.total)}</strong><small>{summary.traders} trader{summary.traders === 1 ? '' : 's'}</small></div></div>
      <div class="price-grid">{#each market.outcomes as option}{@const data = summary.outcomes.find((item) => item.key === option)}<button class:selected={outcome === option} on:click={() => outcome = option}><span>{label(option)}</span><strong>{data ? cents(data.probability) : '—'}</strong><small>{data ? `${points(data.stake)} backing it` : 'No position yet'}</small></button>{/each}</div>
      <section class="chart-card"><div><span class="eyebrow">Market history</span><h3><BarChart3 size={17} /> Implied price movement</h3><p>{marketTicks.length ? 'Each point reflects actual placed or updated positions.' : 'The first position will establish the opening price.'}</p></div><svg viewBox="0 0 240 90" role="img" aria-label="Market price history"><line x1="8" x2="232" y1="14" y2="14"/><line x1="8" x2="232" y1="48" y2="48"/><line x1="8" x2="232" y1="82" y2="82"/>{#each market.outcomes.slice(0, 3) as option, index}<path d={pathFor(option)} class:blue={index === 1} class:gold={index === 2}/>{/each}<text x="234" y="17">100¢</text><text x="234" y="51">50¢</text><text x="234" y="85">0¢</text></svg></section>
      <section class="trade-panel"><div><span class="eyebrow">Your position</span><h3>{mine ? `${points(mine.stake)} on ${label(mine.outcome_key)}` : 'Make your read'}</h3><p>{mine ? 'Edit before this market locks. One position per market keeps the ledger intelligible.' : 'Your stake becomes part of the market price.'}</p></div><div class="trade-controls"><select class="form-input" bind:value={outcome}>{#each market.outcomes as option}<option value={option}>{label(option)}</option>{/each}</select><input class="form-input" type="number" min="1" max="1000" bind:value={stake} aria-label="Points to stake"/><button class="btn btn-primary" disabled={saving || !outcome} on:click={trade}>{mine ? 'Update position' : 'Open position'}</button>{#if mine}<button class="btn btn-outline" disabled={saving} on:click={cancel}>Close</button>{/if}</div>{#if message}<small class="trade-message">{message}</small>{/if}</section>
    </main>{/if}
  </div>
  <section class="leaderboard"><div><span class="eyebrow">Performance</span><h2><Trophy size={18} /> Scout leaderboard</h2></div>{#if standings.length}<table class="bom-table"><thead><tr><th>#</th><th>Scout</th><th>Balance</th><th>Record</th></tr></thead><tbody>{#each standings as row, index}<tr><td>{index + 1}</td><td>{displayName(row.userId)}</td><td class="strong">{points(row.balance)}</td><td>{row.wins}–{row.losses}</td></tr>{/each}</tbody></table>{:else}<p class="text-muted">Settle a market to start the leaderboard.</p>{/if}</section>
{/if}

<style>
  h1,h2,h3{margin:0;display:flex;align-items:center;gap:var(--gap-2)}.notice-warning{margin-bottom:var(--space-3)}.account-strip{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--border);border:1px solid var(--border);border-radius:var(--radius-md);overflow:hidden;margin:var(--space-4) 0}.account-strip div{background:var(--surface);padding:var(--space-3);display:flex;flex-direction:column;gap:3px}.account-strip span,.liquidity span{font-size:.72rem;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted)}.account-strip strong{font-size:1.15rem}.market-layout{display:grid;grid-template-columns:minmax(210px,.42fr) minmax(0,1fr);gap:var(--space-3)}.market-rail,.market-card,.leaderboard{border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface)}.market-rail{padding:var(--space-2);height:max-content}.rail-title{font-size:.8rem;font-weight:700;display:flex;gap:6px;align-items:center;padding:var(--space-2)}.market-rail button{display:flex;width:100%;border:0;border-radius:var(--radius-sm);background:transparent;padding:var(--space-2);text-align:left;flex-direction:column;gap:3px;color:inherit;cursor:pointer}.market-rail button:hover,.market-rail button.active{background:var(--surface-2)}.market-rail small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-muted)}.market-rail span{font-size:.72rem;color:var(--status-success)}.market-card{padding:var(--space-4)}.market-head{display:flex;justify-content:space-between;gap:var(--space-4)}.market-head p,.chart-card p,.trade-panel p{margin:5px 0 0;color:var(--text-muted);font-size:.9rem}.liquidity{text-align:right;display:flex;flex-direction:column;gap:2px}.liquidity strong{font-size:1.15rem}.liquidity small{color:var(--text-muted)}.price-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--space-2);margin:var(--space-4) 0}.price-grid button{border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface);padding:var(--space-3);color:inherit;text-align:left;display:grid;gap:4px;cursor:pointer}.price-grid button.selected{outline:2px solid var(--brand-blue,#2563eb);border-color:transparent}.price-grid strong{font-size:1.35rem}.price-grid small{color:var(--text-muted)}.chart-card{border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:var(--space-3) 0;display:grid;grid-template-columns:1fr minmax(220px,.8fr);align-items:center;gap:var(--space-3)}.chart-card h3{font-size:1rem}.chart-card svg{width:100%;overflow:visible}.chart-card line{stroke:var(--border);stroke-dasharray:2 3}.chart-card path{fill:none;stroke:#ef4444;stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round}.chart-card path.blue{stroke:#3b82f6}.chart-card path.gold{stroke:#d99b22}.chart-card text{font-size:7px;fill:var(--text-muted)}.trade-panel{margin-top:var(--space-4);display:grid;grid-template-columns:1fr auto;gap:var(--space-4);align-items:center}.trade-controls{display:flex;gap:var(--space-2);flex-wrap:wrap;justify-content:flex-end}.trade-controls select{min-width:150px}.trade-controls input{width:90px}.trade-message{grid-column:1/-1;color:var(--text-muted)}.leaderboard{margin-top:var(--space-4);padding:var(--space-4)}.leaderboard>div{margin-bottom:var(--space-2)}@media(max-width:760px){.account-strip{grid-template-columns:repeat(2,1fr)}.market-layout{grid-template-columns:1fr}.market-rail{display:flex;overflow:auto;gap:var(--space-1)}.market-rail .rail-title{display:none}.market-rail button{min-width:185px}.chart-card,.trade-panel{grid-template-columns:1fr}.trade-controls{justify-content:flex-start}.liquidity{text-align:left}.market-head{flex-direction:column}}
</style>
