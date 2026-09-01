<script>
  // Reusable AutoCAM parameter form - shared by the /autocam "New Job" modal
  // and the Machine Profile editor, so the two never drift out of sync.
  //
  // mode='job'     shows the per-part fields that can't be a machine default
  //                (stock diameter for turning, target depth for routing).
  // mode='profile' hides those two - a machine profile only stores settings
  //                that make sense as a reusable default for that machine.
  //
  // Everything except the couple of fields that genuinely need attention
  // every time is tucked behind "Advanced Settings" (closed by default) -
  // same pattern as the old /manufacture/autocam settings page - since a
  // selected Machine Profile already fills sensible values for all of it.
  import stockData from '$lib/stock.json';

  export let operation = 'routing'; // 'turning' | 'routing' | 'tubestock'
  export let params = {};
  export let mode = 'job';

  // Real tube/extrusion stock this team actually stocks (router.json entries
  // flagged isTube) - the STEP file's own measured geometry is still what
  // actually drives the G-code math (see extractTubeFeaturesFromMeshes), but
  // picking the real stock here lets generation catch a mismatch (wrong
  // tube loaded vs. what the CAD model assumes) before it ever reaches the
  // machine - see /api/cam-generate's own stock-cross-section check.
  const tubeStockOptions = (stockData.router || []).filter((s) => s.isTube);
</script>

{#if operation === 'tubestock'}
  <div class="form-row">
    {#if mode === 'job'}
      <div class="form-group">
        <label class="form-label" for="cf-stock-catalog">Stock (extrusion)</label>
        <select id="cf-stock-catalog" class="form-select" bind:value={params.stockCatalogId}>
          <option value="">Not specified (skip stock-size check)</option>
          {#each tubeStockOptions as stock}
            <option value={stock.id}>{stock.description}</option>
          {/each}
        </select>
        <p class="text-muted">The real tube that will be loaded on the machine - generation checks it against the STEP file's own measured cross-section and refuses to run if they don't match.</p>
      </div>
      <div class="form-group">
        <label class="form-label" for="cf-hole-depth">Hole depth (in)</label>
        <input id="cf-hole-depth" class="form-input" type="number" step="0.01" bind:value={params.holeDepth} placeholder="Required" />
        <p class="text-muted">How deep to plunge past the wall's outer surface - verify against the real tube gauge before running. Too shallow won't clear the wall.</p>
      </div>
    {/if}
    <div class="form-group">
      <label class="form-label" for="cf-safe-z">Safe height (in)</label>
      <input id="cf-safe-z" class="form-input" type="number" step="0.05" bind:value={params.safeZ} title="Retract clearance above the wall's outer surface" />
    </div>
  </div>

  <details class="advanced-settings">
    <summary>Advanced settings</summary>
    <div class="cam-param-section">
      <h4>Feeds &amp; Speed</h4>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="cf-tube-feed">Feed rate (in/min)</label>
          <input id="cf-tube-feed" class="form-input" type="number" bind:value={params.feedRate} title="A straight drilling plunge - much slower than a routering contour pass" />
        </div>
        <div class="form-group">
          <label class="form-label" for="cf-tube-spindle">Spindle speed (RPM)</label>
          <input id="cf-tube-spindle" class="form-input" type="number" bind:value={params.spindleSpeed} />
        </div>
      </div>
    </div>
  </details>
  <p class="text-muted">Rotary 4th-axis indexed drilling - no specific real machine has been confirmed against this yet. Verify the A-axis direction, rotary-center offset, and Z=0 reference before running on material.</p>
{:else if operation === 'turning'}
  <div class="form-group">
    <label class="form-label" for="cf-setup-mode">Setup</label>
    <select id="cf-setup-mode" class="form-select" bind:value={params.setupMode}>
      <option value="single">Single setup - cantilevered from the chuck</option>
      <option value="tailstock">Tailstock-supported - single setup, far end braced by a live center</option>
      <option value="flip">Flip-turning - two setups, manual re-chuck partway through</option>
    </select>
    <p class="text-muted">Long/thin parts can't just cantilever safely out of the chuck - pick tailstock support if the machine has one, or flip-turning if it needs a real re-chuck.</p>
  </div>
  <div class="form-group">
    <label class="form-label" for="cf-atc">
      <input id="cf-atc" type="checkbox" bind:checked={params.automaticToolChanger} />
      Automatic tool changer (Haas TL-1 turret)
    </label>
    <p class="text-muted">On a multi-tool job (finish tool set below), skip the manual M00 pause + re-touch-off prompt - the turret indexes tool and offset together unattended. Leave off for a manually-tooled lathe.</p>
  </div>
  {#if mode === 'job' && params.setupMode === 'flip'}
    <div class="form-group">
      <label class="form-label" for="cf-flip-at">Flip point (in from the face)</label>
      <input id="cf-flip-at" class="form-input" type="number" step="0.1" bind:value={params.flipAt} placeholder="Required for flip-turning" />
      <p class="text-muted">Setup 1 cuts this much from the face; setup 2 (after a manual re-chuck) cuts the rest.</p>
    </div>
  {/if}

  <div class="form-row">
    {#if mode === 'job'}
      <div class="form-group">
        <label class="form-label" for="cf-stock-shape">Stock shape</label>
        <select id="cf-stock-shape" class="form-select" bind:value={params.stockShape}>
          <option value="round">Round bar</option>
          <option value="hex">Hex bar</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="cf-stock-dia">Stock {params.stockShape === 'hex' ? 'across flats' : 'diameter'} (in)</label>
        <input id="cf-stock-dia" class="form-input" type="number" step="0.01" bind:value={params.stockDiameter} placeholder="Required" />
        {#if params.stockShape === 'hex'}
          <p class="text-muted">Across-flats size, same as how hex bar is ordered - the rapid/first roughing pass(es) clear the larger across-corners dimension automatically.</p>
        {/if}
      </div>
    {/if}
    <div class="form-group">
      <label class="form-label" for="cf-finish-allow">Finish allowance (in)</label>
      <input id="cf-finish-allow" class="form-input" type="number" step="0.005" bind:value={params.finishAllowance} title="Material left for the finishing pass" />
    </div>
  </div>

  <details class="advanced-settings">
    <summary>Advanced settings</summary>
    <div class="cam-param-section">
      <h4>Roughing</h4>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="cf-step-down">Step-down (in)</label>
          <input id="cf-step-down" class="form-input" type="number" step="0.005" bind:value={params.stepDown} title="Radial depth of cut per roughing pass" />
        </div>
      </div>
    </div>
    <div class="cam-param-section">
      <h4>Feeds &amp; Speed</h4>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="cf-feed-rough">Rough feed (in/rev)</label>
          <input id="cf-feed-rough" class="form-input" type="number" step="0.001" bind:value={params.feedRough} />
        </div>
        <div class="form-group">
          <label class="form-label" for="cf-feed-finish">Finish feed (in/rev)</label>
          <input id="cf-feed-finish" class="form-input" type="number" step="0.001" bind:value={params.feedFinish} />
        </div>
        <div class="form-group">
          <label class="form-label" for="cf-surface-speed">Surface speed (SFM)</label>
          <input id="cf-surface-speed" class="form-input" type="number" bind:value={params.surfaceSpeed} title="Constant surface speed (G96) - surface feet per minute, Haas TL-1 convention in G20/inch mode" />
        </div>
        <div class="form-group">
          <label class="form-label" for="cf-max-rpm">Max RPM</label>
          <input id="cf-max-rpm" class="form-input" type="number" bind:value={params.maxRpm} title="Spindle RPM clamp (G50) - required for constant surface speed" />
        </div>
      </div>
    </div>
  </details>
{:else}
  <div class="form-row">
    <div class="form-group">
      <label class="form-label" for="cf-tool-dia">Tool diameter (in)</label>
      <input id="cf-tool-dia" class="form-input" type="number" step="0.0625" bind:value={params.toolDiameter} />
    </div>
    {#if mode === 'job'}
      <div class="form-group">
        <label class="form-label" for="cf-target-depth">Target depth (in) <span class="text-muted">(auto if blank)</span></label>
        <input id="cf-target-depth" class="form-input" type="number" step="0.01" bind:value={params.targetDepth} placeholder="From STEP thickness" />
      </div>
    {/if}
  </div>

  <details class="advanced-settings">
    <summary>Advanced settings</summary>
    <div class="cam-param-section">
      <h4>Cutting</h4>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="cf-r-step-down">Step-down (in)</label>
          <input id="cf-r-step-down" class="form-input" type="number" step="0.01" bind:value={params.stepDown} title="Z depth per pass" />
        </div>
        <div class="form-group">
          <label class="form-label" for="cf-edge-margin">Edge margin (in)</label>
          <input id="cf-edge-margin" class="form-input" type="number" step="0.05" bind:value={params.edgeMargin} title="Keeps the whole toolpath this far clear of X0/Y0 - where work zero is set and stock is usually clamped/nailed down. 0 = cut the part exactly where it was modeled, no shift." />
        </div>
      </div>
    </div>
    <div class="cam-param-section">
      <h4>Tabs</h4>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="cf-tab-width">Tab width (in)</label>
          <input id="cf-tab-width" class="form-input" type="number" step="0.05" bind:value={params.tabWidth} />
        </div>
        <div class="form-group">
          <label class="form-label" for="cf-tab-height">Tab height (in)</label>
          <input id="cf-tab-height" class="form-input" type="number" step="0.01" bind:value={params.tabHeight} title="Material left uncut at each tab" />
        </div>
        <div class="form-group">
          <label class="form-label" for="cf-tab-spacing">Tab spacing (in)</label>
          <input id="cf-tab-spacing" class="form-input" type="number" step="0.5" bind:value={params.tabSpacing} title="0 = no tabs" />
        </div>
      </div>
    </div>
    <div class="cam-param-section">
      <h4>Feeds &amp; Speed</h4>
      <p class="cam-form-hint">Dry router workflow: no coolant commands are emitted. Selecting a stock material applies its feed, plunge, and spindle starting values. Verify the cutter manufacturer's chart and machine setup before running a part.</p>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="cf-feed-rate">Feed rate (in/min)</label>
          <input id="cf-feed-rate" class="form-input" type="number" bind:value={params.feedRate} />
        </div>
        <div class="form-group">
          <label class="form-label" for="cf-plunge-rate">Plunge rate (in/min)</label>
          <input id="cf-plunge-rate" class="form-input" type="number" bind:value={params.plungeRate} />
        </div>
        <div class="form-group">
          <label class="form-label" for="cf-spindle-speed">Spindle speed (RPM)</label>
          <input id="cf-spindle-speed" class="form-input" type="number" bind:value={params.spindleSpeed} />
        </div>
      </div>
    </div>
  </details>
{/if}

<style>
  .cam-param-section {
    margin-bottom: 0.75rem;
  }
  .cam-param-section:last-child {
    margin-bottom: 0;
  }
  .cam-param-section h4 {
    margin: 0 0 0.5rem;
    font-size: var(--font-xs, 0.75rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .form-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 1rem;
    margin-bottom: 0.5rem;
  }
  .advanced-settings {
    margin: 0.75rem 0 1rem;
    padding: 0.6rem 0.75rem;
    background: var(--surface-2, var(--background));
    border-radius: var(--radius-sm, 4px);
  }
  .advanced-settings summary {
    cursor: pointer;
    font-weight: 500;
    font-size: var(--font-sm, 0.9rem);
  }
  .advanced-settings[open] summary {
    margin-bottom: 0.75rem;
  }
</style>
