<script>
  import { buildVisionHeatmap } from '$lib/visionHeatmap.js';
  export let tracks = [];
  $: heatmap = buildVisionHeatmap(tracks);
  const cellWidth = 100 / 36;
  const cellHeight = 50 / 18;
  function fill(cell) {
    if (cell.red > cell.blue) return '#ef4444';
    if (cell.blue > cell.red) return '#3b82f6';
    if (cell.red && cell.blue) return '#a855f7';
    return '#d9a413';
  }
</script>

<div class="heatmap-shell">
  <div class="heatmap-heading">
    <div><h3>Field occupancy heatmap</h3><p>Calibrated robot positions accumulate as Vision results arrive.</p></div>
    <span>{heatmap.points.toLocaleString()} calibrated points</span>
  </div>
  {#if heatmap.points}
    <svg class="heatmap" viewBox="0 0 100 50" role="img" aria-label="Robot field occupancy heatmap">
      <rect x="0" y="0" width="100" height="50" class="field" />
      <line x1="50" y1="0" x2="50" y2="50" class="centerline" />
      {#each heatmap.cells as cell (`${cell.column}:${cell.row}`)}
        <rect
          x={cell.column * cellWidth}
          y={(17 - cell.row) * cellHeight}
          width={cellWidth + 0.15}
          height={cellHeight + 0.15}
          fill={fill(cell)}
          fill-opacity={0.12 + 0.78 * (cell.count / heatmap.maxCount)}
        />
      {/each}
    </svg>
    <div class="legend"><span class="red">Red</span><span class="both">Both</span><span class="blue">Blue</span></div>
  {:else}
    <div class="empty-heatmap">No calibrated trajectory data yet. Complete a Vision run with a valid homography to fill this map.</div>
  {/if}
</div>

<style>
  .heatmap-shell { display:grid; gap:var(--space-3); }
  .heatmap-heading { display:flex; align-items:start; justify-content:space-between; gap:var(--gap-3); }
  h3,p { margin:0; } h3 { font-size:.95rem; } p,.heatmap-heading span { color:var(--text-muted); font-size:.78rem; }
  .heatmap { width:100%; min-height:15rem; border:1px solid var(--border); background:#111827; }
  .field { fill:#1f2937; } .centerline { stroke:#f8fafc; stroke-width:.25; stroke-dasharray:1 1; opacity:.45; }
  .legend { display:flex; justify-content:center; gap:var(--gap-4); font-size:.75rem; color:var(--text-muted); }
  .legend span::before { content:''; display:inline-block; width:.7rem; height:.7rem; margin-right:.3rem; vertical-align:-.08rem; background:currentColor; }
  .red { color:#ef4444; } .blue { color:#3b82f6; } .both { color:#a855f7; }
  .empty-heatmap { min-height:12rem; display:grid; place-items:center; padding:var(--space-5); border:1px dashed var(--border); color:var(--text-muted); text-align:center; }
</style>
