<script>
  // Multi-tool builder for routing jobs (router only - see
  // autocam/docs/toolchange-gcode-plan.md). Each entry is denormalized off a cam_tools
  // row into a plain {toolId, toolDiameter, toolNumber, label} object, since
  // that's the shape autocam/routing.js's generator actually consumes
  // (it doesn't look tools up itself). Order matters: primary/largest tool
  // first - later tools are only used for contours (usually small holes)
  // the earlier ones physically can't fit.
  export let tools = []; // available cam_tools rows
  export let sequence = []; // bound array of {toolId, toolDiameter, toolNumber, label}

  let addToolId = '';

  $: availableTools = tools.filter((t) => t.enabled && !sequence.some((s) => s.toolId === t.id));

  function addStep() {
    const t = tools.find((x) => x.id === addToolId);
    if (!t) return;
    sequence = [...sequence, { toolId: t.id, toolDiameter: t.diameter || null, toolNumber: t.tool_number || null, label: t.name }];
    addToolId = '';
  }
  function removeStep(i) {
    sequence = sequence.filter((_, idx) => idx !== i);
  }
  function moveStep(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= sequence.length) return;
    const copy = [...sequence];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    sequence = copy;
  }
</script>

<div class="tool-sequence">
  <label class="form-label" for="tool-seq-add">
    Multi-Tool Sequence <span class="text-muted">(optional - primary/largest tool first)</span>
  </label>
  {#if sequence.length === 0}
    <p class="cam-form-hint">No tools added - this job uses the single Tool diameter above. Add tools here for a job that needs more than one bit (e.g. a big bit for the outer profile, a small bit for tight holes it can't reach).</p>
  {:else}
    <p class="cam-form-hint">Contours are auto-assigned to the first tool in this order that geometrically fits - later tools only get used where an earlier one physically can't (e.g. a small hole). Overrides the single Tool diameter field above.</p>
    <div class="tool-sequence-list">
      {#each sequence as step, i (step.toolId)}
        <div class="tool-sequence-row">
          <span class="tool-sequence-index">{i + 1}.</span>
          <span class="tool-sequence-name">
            {step.label}{step.toolDiameter ? ` (${step.toolDiameter}" dia)` : ''}{step.toolNumber ? ` - T${step.toolNumber}` : ''}
          </span>
          <button type="button" class="btn btn-ghost btn-sm" on:click={() => moveStep(i, -1)} disabled={i === 0} title="Move earlier">↑</button>
          <button type="button" class="btn btn-ghost btn-sm" on:click={() => moveStep(i, 1)} disabled={i === sequence.length - 1} title="Move later">↓</button>
          <button type="button" class="btn btn-ghost btn-sm" on:click={() => removeStep(i)} title="Remove">✕</button>
        </div>
      {/each}
    </div>
  {/if}
  <div class="input-group">
    <select id="tool-seq-add" class="form-select" bind:value={addToolId}>
      <option value="">Add a tool…</option>
      {#each availableTools as t}
        <option value={t.id}>{t.name}{t.diameter ? ` (${t.diameter}" dia)` : ''}{t.tool_number ? ` - T${t.tool_number}` : ''}</option>
      {/each}
    </select>
    <button type="button" class="btn btn-secondary btn-sm btn-nowrap" on:click={addStep} disabled={!addToolId}>Add Tool</button>
  </div>
</div>

<style>
  .tool-sequence {
    margin-bottom: 1rem;
  }
  .tool-sequence-list {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin: 0.5rem 0;
  }
  .tool-sequence-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
    background: var(--surface-2, var(--background));
    border-radius: var(--radius-sm, 4px);
  }
  .tool-sequence-index {
    color: var(--text-muted);
    font-size: var(--font-xs, 0.75rem);
  }
  .tool-sequence-name {
    flex: 1;
    font-size: var(--font-sm, 0.9rem);
  }
</style>
