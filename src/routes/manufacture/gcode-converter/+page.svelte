<script>
  import { page } from '$app/stores';
  import { Download } from 'lucide-svelte';
  import { lintGcode, repairGcodeComments } from '$autocam/gcodeLint.js';

  let source = '';
  let fileName = 'untitled';

  $: check = lintGcode(source);
  $: hasContent = source.trim().length > 0;
  $: exportName = `${(fileName.trim() || 'untitled').replace(/\.ngc$/i, '')}.ngc`;

  function exportNgc() {
    if (!hasContent) return;
    // Comments are repaired on the way out for the same reason job downloads
    // are: a comment that closes early leaves the rest of its line running as
    // code on the machine.
    const text = repairGcodeComments(source);
    const blob = new Blob([text.endsWith('\n') ? text : `${text}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportName;
    a.click();
    URL.revokeObjectURL(url);
  }
</script>

<svelte:head><title>G-code Converter</title></svelte:head>

<div class="page-header">
  <h1>G-code Converter</h1>
  <div class="page-actions">
    <a href="/manufacture" class="btn btn-secondary">Back</a>
  </div>
</div>

<div class="subtabs">
  <a href="/manufacture" class:active={$page.url.pathname === '/manufacture'}>ToDo</a>
  <a href="/manufacture/completed" class:active={$page.url.pathname === '/manufacture/completed'}>Completed</a>
  <a href="/manufacture/router" class:active={$page.url.pathname === '/manufacture/router'}>Router</a>
  <a href="/manufacture/post-processing" class:active={$page.url.pathname === '/manufacture/post-processing'}>Post Processing</a>
  <a href="/manufacture/bins" class:active={$page.url.pathname === '/manufacture/bins'}>Bins</a>
  <a href="/manufacture/gcode-converter" class:active={$page.url.pathname === '/manufacture/gcode-converter'}>G-code Converter</a>
  <a href="/manufacture/text-engraving" class:active={$page.url.pathname === '/manufacture/text-engraving'}>Text Engraving</a>
</div>

<div class="converter">
  <div class="card editor-card">
    <label class="form-label" for="gcode-source">G-code</label>
    <textarea
      id="gcode-source"
      class="form-input gcode-input"
      spellcheck="false"
      autocomplete="off"
      placeholder={'G21\nG90\nG0 X0 Y0 Z0.25\nG1 Z-0.1 F10\nM2'}
      bind:value={source}
    ></textarea>
  </div>

  <div class="side">
    <div class="card">
      <label class="form-label" for="gcode-name">File name</label>
      <div class="name-row">
        <input id="gcode-name" class="form-input" bind:value={fileName} placeholder="untitled" />
        <span class="ext">.ngc</span>
      </div>
      <button class="btn btn-primary export" on:click={exportNgc} disabled={!hasContent}>
        <Download size={16} />
        Export {exportName}
      </button>
    </div>

    <div class="card">
      <h2 class="section-title">LinuxCNC check</h2>

      {#if !hasContent}
        <p class="muted">Nothing to check yet.</p>
      {:else}
        <dl class="counts">
          <div><dt>Lines</dt><dd>{check.lines}</dd></div>
          <div><dt>Command lines</dt><dd>{check.commandLines}</dd></div>
        </dl>

        {#if check.errors.length > 0}
          <p class="verdict bad">{check.errors.length} {check.errors.length === 1 ? 'error' : 'errors'} — LinuxCNC will refuse to load this.</p>
          <ul class="findings">
            {#each check.errors.slice(0, 40) as issue}
              <li><span class="line-no">line {issue.line}</span>{issue.message}</li>
            {/each}
          </ul>
          {#if check.errors.length > 40}
            <p class="muted">and {check.errors.length - 40} more.</p>
          {/if}
        {:else}
          <p class="verdict good">No load-time errors.</p>
        {/if}

        {#if check.warnings.length > 0}
          <ul class="findings warn">
            {#each check.warnings as issue}
              <li>{issue.message}</li>
            {/each}
          </ul>
        {/if}

        {#if check.repairedLines > 0}
          <p class="repair">
            {check.repairedLines} {check.repairedLines === 1 ? 'comment' : 'comments'} will be repaired on export, so the exported file differs from the text above.
          </p>
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  .converter {
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(280px, 1fr);
    gap: var(--space-4);
    align-items: start;
  }

  .editor-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .gcode-input {
    min-height: 30rem;
    resize: vertical;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.85rem;
    line-height: 1.5;
    tab-size: 2;
    white-space: pre;
    overflow-wrap: normal;
    overflow-x: auto;
  }

  .side {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .name-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .name-row .form-input { min-width: 0; }

  .ext {
    color: var(--text-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.85rem;
  }

  .export { width: 100%; justify-content: center; }

  .section-title {
    margin: 0 0 var(--space-3) 0;
    font-size: 1rem;
  }

  .counts {
    display: flex;
    gap: var(--space-6);
    margin: 0 0 var(--space-3) 0;
  }

  .counts div { display: flex; flex-direction: column; gap: 2px; }
  .counts dt { color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .counts dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: 600; }

  .verdict { margin: 0 0 var(--space-2) 0; font-weight: 600; font-size: 0.9rem; }
  .verdict.good { color: var(--success); }
  .verdict.bad { color: var(--danger); }

  .findings {
    margin: 0 0 var(--space-2) 0;
    padding-left: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    font-size: 0.85rem;
    line-height: 1.45;
  }

  .findings.warn { color: var(--warning); }

  .line-no {
    display: inline-block;
    margin-right: var(--space-2);
    color: var(--text-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.78rem;
  }

  .repair {
    margin: 0;
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 0.85rem;
    line-height: 1.45;
  }

  .muted { margin: 0; color: var(--text-muted); font-size: 0.9rem; }

  @media (max-width: 900px) {
    .converter { grid-template-columns: minmax(0, 1fr); }
    .gcode-input { min-height: 20rem; }
  }
</style>
