<script>
  import { TURNING_STOCK_FIELDS } from '$autocam/fusion/turningStock.js';

  // The stock and tailstock an operator can set for a lathe job. Every field
  // is optional and in inches; blank means the Runner derives it from the STEP
  // file. Which stock fields show depends on the CAM type (spacers are round
  // or tube stock, hex shafts are hex bar), so the fields differ, not just
  // their labels.
  export let camType = '';
  export let values = {};
  export let idPrefix = 'stock';

  $: fields = TURNING_STOCK_FIELDS[camType] || [];
</script>

{#if !camType}
  <p class="cam-form-hint">Choose a CAM type to set stock and tailstock. Anything left blank is chosen automatically from the STEP file.</p>
{:else}
  <div class="form-row">
    {#each fields as field (field.key)}
      <div class="form-group">
        <label class="form-label" for="{idPrefix}-{field.key}">{field.label}, inches (optional)</label>
        <input
          id="{idPrefix}-{field.key}"
          type="number"
          min="0"
          step="0.001"
          class="form-input"
          bind:value={values[field.key]}
          placeholder="Auto from the STEP file"
        />
        <p class="cam-form-hint">{field.hint}</p>
      </div>
    {/each}
    <div class="form-group">
      <label class="form-label" for="{idPrefix}-tailstockLengthIn">Tailstock length, inches (optional)</label>
      <input
        id="{idPrefix}-tailstockLengthIn"
        type="number"
        min="0"
        step="0.001"
        class="form-input"
        bind:value={values.tailstockLengthIn}
        placeholder="Auto"
      />
      <p class="cam-form-hint">Material left behind the part for the chuck and tailstock to hold. A stock length sets this too; if you set both they must agree.</p>
    </div>
  </div>
{/if}
