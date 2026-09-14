<script>
  import { buildScoutingComparison } from '$lib/scoutingComparison.js';
  export let data;
  export let loading = false;
  export let error = '';
  export let onClose = () => {};
  export let onRunChange = () => {};
  export let onRefresh = () => {};
  let reviewedOnly = true;
  $: comparison = buildScoutingComparison(data, { reviewedOnly });
  const maxFor = chart => chart.scale || Math.max(1, chart.manual.value || 0, chart.vision.value || 0, chart.manual.max || 0);
  const display = value => value == null ? 'Not measured' : Number(value.toFixed(2)).toLocaleString();
  const timestamp = value => value ? new Date(value).toLocaleString() : 'Not completed';
  const eventLabel = value => String(value || '').replaceAll('_', ' ');
</script>

<section class="comparison-panel" aria-label="Manual and vision scouting comparison" aria-busy={loading}>
  <header>
    <div><h2>Manual vs vision scouting</h2><p>Team {data?.manual?.team_key?.replace(/^frc/, '')} · Match {data?.manual?.match_key} · {data?.manual?.event_key}</p></div>
    <button class="btn btn-secondary" on:click={onClose}>Back to my reports</button>
  </header>
  <div class="comparison-controls">
    <label>Vision run
      <select class="form-input" value={data?.run?.id || ''} disabled={loading || !data?.runs?.length} on:change={event => onRunChange(event.currentTarget.value)}>
        {#if !data?.runs?.length}<option value="">No vision runs yet</option>{/if}
        {#each data?.runs || [] as run}<option value={run.id}>{run.model_name} · {run.status} · {timestamp(run.created_at)}</option>{/each}
      </select>
    </label>
    <label>Vision observations
      <select class="form-input" bind:value={reviewedOnly}>
        <option value={true}>Reviewed: accepted and corrected</option>
        <option value={false}>All candidates: includes unreviewed</option>
      </select>
    </label>
    <button class="btn btn-secondary" disabled={loading} on:click={onRefresh}>{loading ? 'Refreshing…' : 'Refresh vision data'}</button>
  </div>
  {#if error}<p class="comparison-error" role="alert">{error}</p>{/if}
  {#if data?.run}
    <p class="run-details">{data.run.model_name} {data.run.model_version} · {data.run.status} · {data.run.released_at ? 'Released' : 'Not released'} · Completed {timestamp(data.run.completed_at)}</p>
    <p class="evidence-note">{comparison.counts.included} of {comparison.counts.total} team observations included; {comparison.counts.unreviewed} unreviewed. {reviewedOnly ? 'Charts include accepted/corrected observations.' : 'Charts include provisional candidates.'} Repeated camera observations are reconciled using the vision pipeline. Robot-track metrics may still need identity and calibration review.</p>
  {/if}
  {#if loading}
    <p role="status">Loading the matching vision results…</p>
  {:else if !data?.matches?.length}
    <p class="empty-state">No vision recording has been registered for this match yet. Your manual data is shown below; refresh after vision processing completes.</p>
  {:else if !data?.run}
    <p class="empty-state">This match has a vision recording but no processing runs yet.</p>
  {:else if data.run.status !== 'complete'}
    <p class="empty-state">This vision run is {data.run.status}. Results may be incomplete; refresh when processing finishes.</p>
  {:else if !comparison.hasVision}
    <p class="empty-state">No vision observations or tracks are attributed to this team in the selected run. Team identity must be resolved before comparing; alliance totals are not used as this team’s score.</p>
  {:else if !comparison.observations.length}
    <p class="empty-state">No observations match the selected review filter. Choose “All candidates” to inspect provisional results.</p>
  {/if}

  <div class="legend" aria-label="Chart legend"><span><i class="manual-swatch"></i>Manual scout</span><span><i class="vision-swatch"></i>Vision scouting</span></div>
  <p class="chart-guide">Each chart has its own labeled scale. Blank bars mean missing data, not zero. Vision does not assign subjective scouting ratings.</p>
  <div class="chart-grid">
    {#each comparison.charts as chart (chart.key)}
      <figure class="metric-chart" aria-label={`${chart.title}: manual ${chart.manual.label}; vision ${chart.vision.label}; unit ${chart.unit}`}>
        <figcaption><strong>{chart.title}</strong><span>{chart.unit}</span></figcaption>
        <div class="axis"><span>0</span><span>{display(maxFor(chart) / 2)}</span><span>{display(maxFor(chart))} {chart.unit}</span></div>
        {#each [['Manual', chart.manual, 'manual'], ['Vision', chart.vision, 'vision']] as [label, value, source]}
          <div class="bar-row"><span class="source-label">{label}</span><div class="bar-track" aria-hidden="true"><div class={`bar ${source}`} style:width={`${value.value == null ? 0 : Math.min(100, value.value / maxFor(chart) * 100)}%`}></div></div><strong class="bar-value">{value.value == null ? value.label : value.label === String(value.value) ? display(value.value) : value.label}</strong></div>
        {/each}
        {#if chart.difference != null}<p class="difference">Vision − manual estimate: {chart.difference > 0 ? '+' : ''}{display(chart.difference)} {chart.unit}</p>{/if}
        {#if chart.manual.min != null && chart.manual.min !== chart.manual.max}<p class="chart-note">Manual estimate: {display(chart.manual.min)}{chart.manual.max == null ? '+' : `–${display(chart.manual.max)}`} {chart.unit}; bar uses {display(chart.manual.value)}.</p>{/if}
        {#if chart.note}<p class="chart-note">{chart.note}</p>{/if}
      </figure>
    {/each}
  </div>

  <details class="data-details" open>
    <summary>All manual answers and vision counterparts</summary>
    <div class="table-scroll"><table><thead><tr><th>Field</th><th class="manual-heading">Manual scout</th><th class="vision-heading">Vision scouting</th></tr></thead><tbody>
      {#each comparison.answers as answer}<tr><th scope="row">{answer.label}</th><td>{answer.manual}</td><td>{answer.vision}</td></tr>{/each}
    </tbody></table></div>
  </details>
  <details class="data-details">
    <summary>Vision evidence ({comparison.observations.length} reconciled observations)</summary>
    <div class="table-scroll"><table><thead><tr><th>Event</th><th>Phase</th><th>Time (seconds)</th><th>Value</th><th>Confidence</th><th>Source</th><th>Review</th><th>Evidence</th></tr></thead><tbody>
      {#each comparison.observations as observation}<tr><td>{eventLabel(observation.observation_type)}</td><td>{observation.phase || 'Derived from timing'}</td><td>{display(observation.started_ms / 1000)}–{display(observation.ended_ms / 1000)}</td><td>{JSON.stringify(observation.value)}</td><td>{display(observation.confidence * 100)}%</td><td>{eventLabel(observation.source || 'vision')}</td><td>{observation.review_status || 'unreviewed'}</td><td>{JSON.stringify(observation.evidence || {})}</td></tr>
      {:else}<tr><td colspan="8">No matching vision observations.</td></tr>{/each}
    </tbody></table></div>
  </details>
  <details class="data-details">
    <summary>Robot tracks ({comparison.tracks.length})</summary>
    <p class="evidence-note track-note">Motion charts use the calibrated track with the most coverage. Other tracks and their recorded data are available below.</p>
    {#each comparison.tracks as track}
      <details class="track-details"><summary>Camera {track.view_id || 'unknown'} · {track.needs_review ? 'Needs review' : 'No review flag'} · Identity confidence {display(track.identity_confidence * 100)}%</summary>
        <dl><dt>Tracking confidence</dt><dd>{display(track.tracking_confidence * 100)}%</dd><dt>Recorded metrics</dt><dd>{JSON.stringify(track.metrics || {})}</dd><dt>Trajectory (time, position, calibration)</dt><dd>{JSON.stringify(track.trajectory || [])}</dd></dl>
      </details>
    {:else}<p class="track-note">No team-attributed robot tracks.</p>{/each}
  </details>
</section>

<style>
  .comparison-panel { background:var(--surface-1, var(--surface)); border:1px solid var(--border); padding:var(--space-4); margin-bottom:var(--space-4); min-width:0; }
  header { display:flex; flex-wrap:wrap; align-items:start; justify-content:space-between; gap:1rem; }
  h2 { margin:0; font-size:1.3rem; } p { overflow-wrap:anywhere; }
  .comparison-controls { display:flex; flex-wrap:wrap; align-items:end; gap:1rem; margin:1rem 0; }
  .comparison-controls label { display:grid; gap:.4rem; flex:1 1 15rem; min-width:0; }
  .run-details,.evidence-note,.chart-guide { font-size:.85rem; color:var(--text-muted); }
  .empty-state { padding:1rem; background:var(--surface-2); border:1px solid var(--border); }
  .comparison-error { color:var(--danger); }
  .legend { display:flex; flex-wrap:wrap; gap:1.5rem; margin-top:1.25rem; font-weight:600; }
  .legend span { display:flex; align-items:center; gap:.5rem; } .legend i { width:1rem; height:1rem; border-radius:3px; }
  .manual-swatch,.bar.manual { background:#2563eb; } .vision-swatch,.bar.vision { background:#d97706; }
  .chart-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem; margin:1rem 0; }
  .metric-chart { margin:0; padding:1rem; border:1px solid var(--border); background:var(--surface-2); min-width:0; }
  figcaption { display:flex; flex-wrap:wrap; gap:.5rem; justify-content:space-between; margin-bottom:.9rem; } figcaption span { color:var(--text-muted); font-size:.8rem; }
  .axis { display:flex; justify-content:space-between; gap:.4rem; margin:0 0 .5rem 4.5rem; color:var(--text-muted); font-size:.7rem; }
  .bar-row { display:grid; grid-template-columns:4rem minmax(3rem,1fr); gap:.5rem; align-items:center; margin:.6rem 0; }
  .source-label { font-size:.8rem; } .bar-track { height:1rem; background:var(--surface-3,var(--border)); border-left:1px solid var(--text-muted); }
  .bar { height:100%; min-width:0; } .bar-value { grid-column:2; font-size:.8rem; font-weight:500; overflow-wrap:anywhere; }
  .difference { font-size:.8rem; font-weight:600; }
  .track-note { padding:0 1rem; } .track-details { border-top:1px solid var(--border); } dl { padding:0 1rem 1rem; font-size:.8rem; } dd { margin:0 0 .75rem; overflow-wrap:anywhere; }
  .chart-note { font-size:.75rem; color:var(--text-muted); margin:.6rem 0 0; }
  .data-details { border:1px solid var(--border); margin-top:1rem; } summary { padding:1rem; font-weight:600; cursor:pointer; }
  .table-scroll { overflow-x:auto; } table { width:100%; border-collapse:collapse; font-size:.8rem; } th,td { text-align:left; padding:.75rem; border-top:1px solid var(--border); vertical-align:top; white-space:pre-wrap; overflow-wrap:anywhere; min-width:7rem; max-width:35rem; } .manual-heading { color:#2563eb; } .vision-heading { color:#b45309; }
  @media(max-width:800px) { .chart-grid { grid-template-columns:1fr; } .comparison-panel { padding:1rem; } }
</style>
