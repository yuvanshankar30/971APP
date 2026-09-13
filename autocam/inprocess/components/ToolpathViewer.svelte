<script>
  import { parseGcodeToolpath, toolpathBounds } from '../toolpathPreview.js';

  export let gcode = '';
  export let operationType = 'routing';

  const WIDTH = 640;
  const HEIGHT = 420;
  const PAD = 30;

  $: segments = parseGcodeToolpath(gcode, operationType);
  $: bounds = toolpathBounds(segments);
  $: spanA = Math.max(bounds.maxA - bounds.minA, 0.001);
  $: spanB = Math.max(bounds.maxB - bounds.minB, 0.001);
  $: scale = Math.min((WIDTH - PAD * 2) / spanA, (HEIGHT - PAD * 2) / spanB);
  $: offsetX = PAD + ((WIDTH - PAD * 2) - spanA * scale) / 2;
  $: offsetY = PAD + ((HEIGHT - PAD * 2) - spanB * scale) / 2;

  // SVG Y grows downward - flip B so "up" on screen matches larger values.
  function sx(a) { return offsetX + (a - bounds.minA) * scale; }
  function sy(b) { return HEIGHT - (offsetY + (b - bounds.minB) * scale); }

  $: axisLabels = operationType === 'turning' ? { a: 'Z (length)', b: 'X (radius)' } : { a: 'X', b: 'Y' };
  $: rapidCount = segments.filter((s) => s.rapid).length;
  $: feedCount = segments.length - rapidCount;

  // Multi-tool routing jobs (see implementations/toolchange-gcode-plan.md) tag each segment
  // with which tool cut it - color by tool when more than one is actually
  // present, otherwise fall back to the plain single-color rendering below
  // (unchanged for every turning job and every single-tool routing job).
  const TOOL_COLORS = ['#1d4ed8', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2'];
  $: toolIndices = [...new Set(segments.map((s) => s.toolIndex ?? 0))].sort((a, b) => a - b);
  $: isMultiTool = toolIndices.length > 1;
  function toolColor(i) { return TOOL_COLORS[i % TOOL_COLORS.length]; }
</script>

{#if segments.length === 0}
  <p class="text-muted">No toolpath to preview yet.</p>
{:else}
  <div class="toolpath-legend">
    {#if isMultiTool}
      {#each toolIndices as i (i)}
        <span class="legend-item"><span class="legend-swatch feed" style="background: {toolColor(i)}"></span> Tool {i + 1}</span>
      {/each}
    {:else}
      <span class="legend-item"><span class="legend-swatch feed"></span> Cutting move ({feedCount})</span>
    {/if}
    <span class="legend-item"><span class="legend-swatch rapid"></span> Rapid move ({rapidCount})</span>
  </div>
  <svg viewBox="0 0 {WIDTH} {HEIGHT}" class="toolpath-svg" role="img" aria-label="Toolpath preview">
    <rect x="0" y="0" width={WIDTH} height={HEIGHT} class="toolpath-bg" />
    {#each segments as seg, i (i)}
      <line
        x1={sx(seg.from.a)} y1={sy(seg.from.b)}
        x2={sx(seg.to.a)} y2={sy(seg.to.b)}
        class="toolpath-line"
        class:rapid={seg.rapid}
        style={isMultiTool && !seg.rapid ? `stroke: ${toolColor(seg.toolIndex ?? 0)}` : ''}
      />
    {/each}
  </svg>
  <div class="toolpath-axis-labels">
    <span>{axisLabels.a} →</span>
    <span>↑ {axisLabels.b}</span>
  </div>
  <p class="toolpath-disclaimer">
    Preview only - reconstructed from the generated G-code, not a substitute for a real simulator (ncviewer.com, CAMotics) before cutting.
  </p>
{/if}

<style>
  .toolpath-legend {
    display: flex;
    gap: 1rem;
    margin-bottom: 0.5rem;
    font-size: var(--font-xs, 0.75rem);
    color: var(--text-muted);
  }
  .legend-item { display: inline-flex; align-items: center; gap: 0.35rem; }
  .legend-swatch { width: 16px; height: 2px; display: inline-block; }
  .legend-swatch.feed { background: var(--accent-strong, #1d4ed8); }
  .legend-swatch.rapid { background: var(--text-muted); border-top: 1px dashed var(--text-muted); height: 0; }

  .toolpath-svg {
    width: 100%;
    height: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 4px);
  }
  .toolpath-bg { fill: var(--surface-2, #f3f4f6); }
  .toolpath-line {
    stroke: var(--accent-strong, #1d4ed8);
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
  }
  .toolpath-line.rapid {
    stroke: var(--text-muted);
    stroke-dasharray: 4 3;
    stroke-width: 1;
  }

  .toolpath-axis-labels {
    display: flex;
    justify-content: space-between;
    font-size: var(--font-xs, 0.75rem);
    color: var(--text-muted);
    margin-top: 0.25rem;
  }

  .toolpath-disclaimer {
    margin: 0.5rem 0 0;
    font-size: var(--font-xs, 0.75rem);
    color: var(--text-muted);
  }
</style>
