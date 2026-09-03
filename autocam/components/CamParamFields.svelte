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
  import { holeDepthForWall, WALL_BREAKTHROUGH_ALLOWANCE } from '$autocam/tubestock.js';

  export let operation = 'routing'; // 'turning' | 'routing' | 'tubestock'
  export let params = {};
  export let mode = 'job';

  $: selectedSheet = routerSheetOptions.find((s) => s.id === params.stockCatalogId) || null;

  // Real tube/extrusion stock this team actually stocks (router.json entries
  // flagged isTube) - the STEP file's own measured geometry is still what
  // actually drives the G-code math (see extractTubeFeaturesFromMeshes), but
  // picking the real stock here lets generation catch a mismatch (wrong
  // tube loaded vs. what the CAD model assumes) before it ever reaches the
  // machine - see /api/cam-generate's own stock-cross-section check.
  const tubeStockOptions = (stockData.router || []).filter((s) => s.isTube);
  // Real sheet stock for routing, thinnest first - each entry carries its own
  // thickness, which is what drives cut depth (and the too-deep refusal in
  // generateRoutingGcode) rather than trusting the CAD model alone.
  const routerSheetOptions = (stockData.router || [])
    .filter((s) => !s.isTube && s.thickness > 0)
    .sort((a, b) => a.thickness - b.thickness || a.description.localeCompare(b.description));

  // Hole depth is a property of the tube, not of the job - every hole in a
  // given tube passes through the same wall - so it is derived from the
  // selected stock instead of typed. Keeping params.holeDepth in sync here
  // means the rest of the pipeline (and the generator's own required-value
  // check) is unchanged.
  $: selectedTube = tubeStockOptions.find((s) => s.id === params.stockCatalogId) || null;
  $: if (operation === 'tubestock') {
    const derived = selectedTube ? holeDepthForWall(selectedTube.wall_thickness) : null;
    if ((params.holeDepth ?? '') !== (derived ?? '')) params.holeDepth = derived ?? '';
  }
</script>

{#if operation === 'tubestock'}
  <div class="form-row">
    {#if mode === 'job'}
      <div class="form-group">
        <label class="form-label" for="cf-stock-catalog">Stock (extrusion)</label>
        <select id="cf-stock-catalog" class="form-select" bind:value={params.stockCatalogId}>
          <option value="">Select the tube being loaded</option>
          {#each tubeStockOptions as stock}
            <option value={stock.id}>{stock.description}</option>
          {/each}
        </select>
        <p class="text-muted">The real tube that will be loaded on the machine - generation checks it against the STEP file's own measured cross-section and refuses to run if they don't match. It also sets the hole depth.</p>
      </div>
      <div class="form-group">
        <span class="form-label">Hole depth</span>
        {#if selectedTube}
          <p class="derived-value">{params.holeDepth}&quot;</p>
          <p class="text-muted">
            {selectedTube.wall_thickness}&quot; wall plus {WALL_BREAKTHROUGH_ALLOWANCE}&quot; to break through it.
            Every hole in this tube goes through the same wall, so there is one depth per stock and nothing to enter.
          </p>
        {:else}
          <p class="derived-value derived-value-empty">&mdash;</p>
          <p class="text-muted">Set by the tube stock above.</p>
        {/if}
      </div>
    {/if}
    <div class="form-group">
      <label class="form-label" for="cf-safe-z">Safe height (in)</label>
      <input id="cf-safe-z" class="form-input" type="number" step="0.05" bind:value={params.safeZ} title="Retract clearance above the wall's outer surface" />
    </div>
  </div>

  {#if mode === 'job'}
    <div class="form-row">
      <div class="form-group">
        <label class="form-label" for="cf-finished-length">Finished length (in) - optional</label>
        <input id="cf-finished-length" class="form-input" type="number" step="0.1" bind:value={params.finishedLength} placeholder="Leave blank if this stock needs no cutoff" />
        <p class="text-muted">
          The stock loaded is whatever length that piece of extrusion happens to be, which is rarely the length
          the part needs and isn't something the CAD model can tell you - so this is entered here, not derived.
          Set it and the program cuts a bandsaw reference line once drilling is done: one pass through one wall
          only, not a full separation - band-saw the tube to length along the line's straight edges afterward.
        </p>
      </div>
      {#if params.finishedLength}
        <div class="form-group">
          <label class="form-label" for="cf-fixture-pin-face">Fixture pin face</label>
          <select id="cf-fixture-pin-face" class="form-select" bind:value={params.fixturePinFace}>
            <option value="">Select the face against the pin</option>
            <option value={12}>Side 12</option>
            <option value={3}>Side 3</option>
            <option value={6}>Side 6</option>
            <option value={9}>Side 9</option>
          </select>
          <p class="text-muted">
            Which physical face is against the fixture's registration pin for this tube - the STEP model has no
            way to know how it gets loaded, so this is entered too. The cutoff line goes on the wall directly
            opposite it.
          </p>
        </div>
      {/if}
    </div>
  {/if}

  <details class="advanced-settings">
    <summary>Advanced settings</summary>
    <div class="cam-param-section">
      <h4>Feeds &amp; Speed</h4>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="cf-tube-feed">Feed rate (in/min)</label>
          <input id="cf-tube-feed" class="form-input" type="number" min="0.1" step="0.1" bind:value={params.feedRate} title="A straight drilling plunge - much slower than a routering contour pass" />
        </div>
        <div class="form-group">
          <label class="form-label" for="cf-tube-spindle">Spindle speed (RPM)</label>
          <input id="cf-tube-spindle" class="form-input" type="number" bind:value={params.spindleSpeed} />
        </div>
      </div>
    </div>
  </details>
  <p class="text-muted">Runs on a standard 3-axis router, not a rotary/4th-axis machine - each face is a separately-runnable program and the operator manually flips the tube stock and re-zeros between faces. No specific real machine has been confirmed against this yet - verify the flip/re-zero procedure and Z=0 reference before running on material.</p>
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
        <input id="cf-target-depth" class="form-input" type="number" step="0.01" bind:value={params.targetDepth} placeholder={selectedSheet ? `Through ${selectedSheet.thickness}" stock` : 'From STEP thickness'} />
      </div>
    {/if}
  </div>

  {#if mode === 'job'}
    <div class="form-group">
      <label class="form-label" for="cf-router-stock">Stock (sheet)</label>
      <select id="cf-router-stock" class="form-select" bind:value={params.stockCatalogId}>
        <option value="">Not specified (use the STEP file's own thickness)</option>
        {#each routerSheetOptions as stock}
          <option value={stock.id}>{stock.description}</option>
        {/each}
      </select>
      <p class="text-muted">
        {#if selectedSheet}
          Cuts through {selectedSheet.thickness}" {selectedSheet.material} - depth, and the number of passes, come from this. Generation refuses a depth that would reach past the stock into the spoilboard.
        {:else}
          The sheet that will actually be on the table. Its thickness sets the cut depth and pass count, and blocks a program that would cut into the spoilboard.
        {/if}
      </p>
    </div>
  {/if}

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
          <label class="form-label" for="cf-tab-count">Number of tabs <span class="text-muted">(auto if blank)</span></label>
          <input id="cf-tab-count" class="form-input" type="number" min="0" step="1" bind:value={params.tabCount} placeholder="From spacing" />
          <p class="text-muted">Set this to hold the part with a specific number of tabs instead of deriving the count from spacing. Tabs are placed on the profile's flat edges - never on an arc or fillet, where the web holds unevenly and tears a finished edge on break-out. A profile with no long enough flat falls back to even spacing and says so in the program, since no tabs at all would let the part come loose.</p>
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
          <input id="cf-feed-rate" class="form-input" type="number" min="0.1" step="0.1" bind:value={params.feedRate} />
        </div>
        <div class="form-group">
          <label class="form-label" for="cf-plunge-rate">Plunge rate (in/min)</label>
          <input id="cf-plunge-rate" class="form-input" type="number" min="0.1" max={params.feedRate || undefined} step="0.1" bind:value={params.plungeRate} title="Should never exceed feed rate - a plunge has full axial engagement" />
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
  /* Reads as a stated value rather than a disabled input, because there is
     nothing here to enable - the tube decides it. */
  .derived-value {
    margin: 0 0 0.25rem;
    padding: 0.4rem 0;
    font-size: 1rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .derived-value-empty {
    color: var(--text-muted);
    font-weight: 400;
  }
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
