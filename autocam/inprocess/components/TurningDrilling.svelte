<script>
  // Optional centerline peck-drilling operation, appended after OD turning
  // is done - see autocam/turning.js's appendDrillingOperation. Denormalized
  // off a cam_tools row into a plain object, same pattern as
  // TurningFinishTool, since that's the shape the generator actually
  // consumes (it doesn't look tools up itself).
  export let tools = []; // available cam_tools rows
  export let drilling = null; // bound: {toolId, toolNumber, label, diameter, depth, peckDepth, feedRate, rpm} | null
  export let disabled = false; // true when setupMode is 'flip' - drilling isn't supported there

  const DEFAULT_FEED_RATE = 0.003; // in/rev
  const DEFAULT_RPM = 800;

  function onSelect(e) {
    const id = e.target.value;
    if (!id) { drilling = null; return; }
    const t = tools.find((x) => x.id === id);
    if (!t) { drilling = null; return; }
    drilling = {
      toolId: t.id,
      toolNumber: t.tool_number || null,
      label: t.name,
      diameter: t.diameter || null,
      depth: drilling?.depth ?? '',
      peckDepth: drilling?.peckDepth ?? '',
      feedRate: drilling?.feedRate ?? DEFAULT_FEED_RATE,
      rpm: drilling?.rpm ?? DEFAULT_RPM
    };
  }
</script>

<div class="form-group">
  <label class="form-label" for="drill-tool-select">Drill <span class="text-muted">(optional - centerline hole, cut after the OD is turned)</span></label>
  <select id="drill-tool-select" class="form-select" value={drilling?.toolId || ''} on:change={onSelect} {disabled}>
    <option value="">No drilling</option>
    {#each tools.filter((t) => t.enabled) as t}
      <option value={t.id}>{t.name}{t.tool_number ? ` - T${t.tool_number}` : ''}{t.diameter ? ` (${t.diameter}" dia)` : ''}</option>
    {/each}
  </select>
  {#if disabled}
    <p class="cam-form-hint tool-warning">Not supported with flip-turning - which end the drill enters from is ambiguous across a re-chuck. Drill in a separate single-setup job instead.</p>
  {:else if drilling}
    {#if !drilling.toolNumber}
      <p class="cam-form-hint tool-warning">This tool has no Tool # set (Manage Tools) - the tool-change block won't have a T-word to switch to. Set one before running this on a machine.</p>
    {/if}
    {#if !drilling.diameter}
      <p class="cam-form-hint tool-warning">This tool has no diameter set (Manage Tools) - used here only to default the peck depth (3x diameter); set one or fill in peck depth manually below.</p>
    {/if}
    <div class="form-row">
      <div class="form-group">
        <label class="form-label" for="drill-depth">Depth (in)</label>
        <input id="drill-depth" class="form-input" type="number" step="0.01" bind:value={drilling.depth} placeholder="Required" />
      </div>
      <div class="form-group">
        <label class="form-label" for="drill-peck">Peck depth (in)</label>
        <input id="drill-peck" class="form-input" type="number" step="0.01" bind:value={drilling.peckDepth} placeholder="3x diameter" />
      </div>
      <div class="form-group">
        <label class="form-label" for="drill-feed">Feed (in/rev)</label>
        <input id="drill-feed" class="form-input" type="number" step="0.0005" bind:value={drilling.feedRate} />
      </div>
      <div class="form-group">
        <label class="form-label" for="drill-rpm">Spindle RPM</label>
        <input id="drill-rpm" class="form-input" type="number" step="10" bind:value={drilling.rpm} title="Direct RPM (G97) - constant surface speed isn't meaningful at a small drill diameter" />
      </div>
    </div>
    <p class="cam-form-hint">Full retract after every peck to clear chips - the chip mover carries swarf away after that, it doesn't reach into the bore. Not supported with flip-turning.</p>
  {/if}
</div>

<style>
  .tool-warning {
    color: var(--warning, #b45309);
  }
</style>
