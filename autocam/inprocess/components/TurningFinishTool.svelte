<script>
  // Optional second insert for a turning job's finishing pass (multi-tool
  // turning - see autocam/turning.js's appendSetupBody `finishTool`
  // param). Denormalized off a cam_tools row into a plain {toolId,
  // toolNumber, label, noseRadius} object, same pattern as
  // RoutingToolSequence's entries, since that's the shape the generator
  // actually consumes (it doesn't look tools up itself). When unset, the
  // job cuts roughing and finishing with the single Tool selected below -
  // completely unchanged single-tool behavior.
  export let tools = []; // available cam_tools rows
  export let finishTool = null; // bound: {toolId, toolNumber, label, noseRadius} | null

  function onSelect(e) {
    const id = e.target.value;
    if (!id) { finishTool = null; return; }
    const t = tools.find((x) => x.id === id);
    finishTool = t ? { toolId: t.id, toolNumber: t.tool_number || null, label: t.name, noseRadius: t.nose_radius || null } : null;
  }
</script>

<div class="form-group">
  <label class="form-label" for="finish-tool-select">Finish Tool <span class="text-muted">(optional - separate insert for the finishing pass)</span></label>
  <select id="finish-tool-select" class="form-select" value={finishTool?.toolId || ''} on:change={onSelect}>
    <option value="">Single tool - same insert for roughing and finishing</option>
    {#each tools.filter((t) => t.enabled) as t}
      <option value={t.id}>{t.name}{t.tool_number ? ` - T${t.tool_number}` : ''}{t.nose_radius ? ` R${t.nose_radius}` : ''}</option>
    {/each}
  </select>
  {#if finishTool && !finishTool.toolNumber}
    <p class="cam-form-hint tool-warning">This tool has no Tool # set (Manage Tools) - the tool-change block won't have a T-word to switch to. Set one before running this on a machine.</p>
  {:else}
    <p class="cam-form-hint">When set, roughing cuts with the Tool selected below, then the program pauses for a real tool change (re-touch off Z0) before finishing with this insert - its nose radius gets compensated on the finishing pass.</p>
  {/if}
</div>

<style>
  .tool-warning {
    color: var(--warning, #b45309);
  }
</style>
