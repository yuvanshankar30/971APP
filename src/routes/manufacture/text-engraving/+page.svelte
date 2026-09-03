<script>
  import { Download, Type } from 'lucide-svelte';
  import { buildTextEngraving, sanitizeTextGcodeFileName } from '$autocam/textEngraving.js';

  let text = 'SPARTANS HUB';
  let fileName = 'text-engraving';
  let height = .5;
  let depth = .02;
  let safeZ = .2;
  let feedRate = 35;
  let plungeRate = 12;

  $: result = buildTextEngraving({ text, height, depth, safeZ, feedRate, plungeRate });
  $: exportName = sanitizeTextGcodeFileName(fileName);
  $: previewWidth = Math.max(result.width, 1);
  $: previewHeight = Math.max(result.height, .5);

  function exportNgc() {
    if (!result.strokes.length) return;
    const blob = new Blob([result.gcode], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = exportName;
    anchor.click();
    URL.revokeObjectURL(url);
  }
</script>

<svelte:head><title>Text Engraving</title></svelte:head>

<div class="page-header">
  <div><h1><Type size={24} /> Text Engraving</h1><p>Generate a single-line engraving program and export a named `.ngc` file.</p></div>
  <a class="btn btn-outline" href="/manufacture">Parts list</a>
</div>

<div class="engraving-layout">
  <section class="settings-panel">
    <label class="form-label" for="engraving-text">Text</label>
    <textarea id="engraving-text" class="form-input text-input" bind:value={text} maxlength="876" placeholder="Type an engraving label"></textarea>
    <small>Uppercase A-Z, 0-9, spaces, `-`, `_`, `.`, `/`, and `:` are supported. Each line becomes a separate engraving row.</small>

    <div class="settings-grid">
      <label>Letter height <span>in</span><input class="form-input" type="number" min="0.05" max="4" step="0.05" bind:value={height} /></label>
      <label>Cut depth <span>in</span><input class="form-input" type="number" min="0.001" max="0.25" step="0.001" bind:value={depth} /></label>
      <label>Safe Z <span>in</span><input class="form-input" type="number" min="0.05" max="2" step="0.05" bind:value={safeZ} /></label>
      <label>Cut feed <span>in/min</span><input class="form-input" type="number" min="1" max="250" step="1" bind:value={feedRate} /></label>
      <label>Plunge feed <span>in/min</span><input class="form-input" type="number" min="1" max="100" step="1" bind:value={plungeRate} /></label>
    </div>

    <div class="export-row">
      <label class="file-field" for="engraving-name">File name<input id="engraving-name" class="form-input" bind:value={fileName} /><span>.ngc</span></label>
      <button class="btn btn-primary" disabled={!result.strokes.length} on:click={exportNgc}><Download size={16} /> Export file</button>
    </div>
    {#if result.unsupported.length}<p class="warning">Skipped unsupported characters: {result.unsupported.join(' ')}</p>{/if}
  </section>

  <section class="preview-panel">
    <div class="preview-heading"><div><h2>Toolpath preview</h2><p>{result.strokes.length} strokes | {result.width.toFixed(2)} x {result.height.toFixed(2)} in</p></div><span>Inches</span></div>
    <div class="preview-canvas">
      {#if result.strokes.length}
        <svg viewBox={`-.15 -.15 ${previewWidth + .3} ${previewHeight + .3}`} preserveAspectRatio="xMidYMid meet" aria-label="Text engraving toolpath preview">
          <g transform={`translate(0 ${previewHeight}) scale(1 -1)`}>
            {#each result.strokes as stroke}<polyline points={stroke.map(([x, y]) => `${x},${y}`).join(' ')} />{/each}
          </g>
        </svg>
      {:else}<p>Type supported text to preview a toolpath.</p>{/if}
    </div>
    <details><summary>Generated G-code preview</summary><pre>{result.gcode}</pre></details>
  </section>
</div>

<style>
  .page-header { display:flex; align-items:flex-end; justify-content:space-between; gap:var(--space-3); }
  h1 { display:flex; align-items:center; gap:var(--space-2); margin:0; }
  .page-header p, .preview-heading p, small { color:var(--text-secondary); margin:var(--space-1) 0 0; }
  .engraving-layout { display:grid; grid-template-columns:minmax(340px, .9fr) minmax(0, 1.3fr); gap:var(--space-4); margin-top:var(--space-4); }
  .settings-panel, .preview-panel { border:1px solid var(--border); background:var(--surface); padding:var(--space-3); }
  .text-input { min-height:9rem; resize:vertical; margin-top:var(--space-1); font-family:var(--font-mono, ui-monospace, monospace); }
  .settings-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:var(--space-3); margin-top:var(--space-4); }
  .settings-grid label, .file-field { display:grid; gap:var(--space-1); font-size:.88rem; font-weight:600; }
  label span { color:var(--text-secondary); font-size:.75rem; font-weight:400; }
  .export-row { display:flex; gap:var(--space-2); align-items:end; margin-top:var(--space-4); }
  .file-field { flex:1; position:relative; }
  .file-field span { position:absolute; right:var(--space-2); bottom:.7rem; color:var(--text-secondary); }
  .file-field input { padding-right:3.25rem; }
  .warning { color:var(--status-warning); margin:var(--space-3) 0 0; font-size:.9rem; }
  .preview-heading { display:flex; justify-content:space-between; gap:var(--space-2); align-items:flex-start; }
  .preview-heading h2 { margin:0; font-size:1rem; }
  .preview-heading > span { color:var(--text-secondary); font-size:.8rem; }
  .preview-canvas { min-height:300px; display:grid; place-items:center; margin-top:var(--space-3); background:#f2f3f4; border:1px solid var(--border); padding:var(--space-3); }
  svg { width:100%; height:100%; min-height:260px; max-height:480px; }
  polyline { fill:none; stroke:#186ccf; stroke-width:.025; vector-effect:non-scaling-stroke; stroke-linejoin:round; stroke-linecap:round; }
  .preview-canvas p { color:var(--text-secondary); }
  details { margin-top:var(--space-3); border-top:1px solid var(--border); padding-top:var(--space-2); }
  summary { cursor:pointer; font-weight:600; }
  pre { max-height:18rem; overflow:auto; padding:var(--space-2); background:var(--surface-muted); font-size:.76rem; }
  @media (max-width:760px) { .page-header, .export-row { align-items:stretch; flex-direction:column; } .engraving-layout { grid-template-columns:1fr; } .settings-grid { grid-template-columns:1fr; } .export-row .btn { width:100%; justify-content:center; } }
</style>
