<script>
  import { createEventDispatcher } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { getDisplayStatus, getBadgeClass, DISPLAY_ORDER, BUTTONS } from '$lib/statuses.js';
  import { Package, Zap } from 'lucide-svelte';

  export let part;
  export let bins = []; // pass bins for kitting if needed
  export let onReviewAutocam = null; // callback to open autocam review modal

  const dispatch = createEventDispatcher();

  // Parse meta helper
  function parseMeta(p) {
    try { return JSON.parse(p.file_url || '{}') || {}; } catch { return {}; }
  }

  // Reactive state
  $: meta = parseMeta(part);
  $: currentDisplay = getDisplayStatus(part.status, meta);
  $: badgeClass = getBadgeClass(part.status, meta);
  $: isAutocammed = part.status === 'autocammed';

  // Handle change
  async function handleChange(event) {
    const newStatusLabel = event.target.value;
    if (newStatusLabel === currentDisplay) return;

    // Map display label to DB updates
    try {
      if (newStatusLabel === BUTTONS.PENDING) {
        // Pending
        await supabase.from('parts').update({ status: 'pending', kitting_bin: null, updated_at: new Date().toISOString() }).eq('id', part.id);
        const m = parseMeta(part);
        if (m.travis_progged) delete m.travis_progged;
        if (m.router_meta) {
           delete m.router_meta.step;
           delete m.router_meta.travis_progged;
        }
        await supabase.from('parts').update({ file_url: JSON.stringify(m), updated_at: new Date().toISOString() }).eq('id', part.id);

      } else if (newStatusLabel === BUTTONS.IN_PROGRESS) {
        // In Progress -> Status: in-progress, Step: cam_ing
        await supabase.from('parts').update({ status: 'in-progress', updated_at: new Date().toISOString() }).eq('id', part.id);
        await updateRouterStep(part, 'cam_ing');

      } else if (newStatusLabel === BUTTONS.CAM_REVIEW_PENDING) {
        // CAM Review Pending -> Status: in-progress, Step: cam_review (CAM work done, awaiting review)
        await supabase.from('parts').update({ status: 'in-progress', updated_at: new Date().toISOString() }).eq('id', part.id);
        await updateRouterStep(part, 'cam_review');

      } else if (newStatusLabel === BUTTONS.CAM_REVIEWED) {
         // CAM Reviewed -> Status: cammed, Step: cammed (review complete)
         await supabase.from('parts').update({ status: 'cammed', updated_at: new Date().toISOString() }).eq('id', part.id);
         const m = parseMeta(part);
         // Ensure we remove travis flag if strictly setting to Reviewed
         if (m.travis_progged) delete m.travis_progged;
         if (!m.router_meta) m.router_meta = {};
         m.router_meta.step = 'cammed'; // Explicit step to avoid falling back to other states
         await supabase.from('parts').update({ file_url: JSON.stringify(m), updated_at: new Date().toISOString() }).eq('id', part.id);

      } else if (newStatusLabel === BUTTONS.POSTPROCESSED) {
        // Postprocessed -> CAM output has been post-processed into machine G-code
        await supabase.from('parts').update({ status: 'postprocessed', updated_at: new Date().toISOString() }).eq('id', part.id);
        await updateRouterStep(part, 'cammed');

      } else if (newStatusLabel === BUTTONS.JPROGGED) {
        // Jprogged -> program loaded/queued on the machine (replaces legacy TravisProgged)
        await supabase.from('parts').update({ status: 'jprogged', updated_at: new Date().toISOString() }).eq('id', part.id);
        await updateRouterStep(part, 'queued', { jprogged: true, travis_progged: true });

      } else if (newStatusLabel === BUTTONS.MACHINED) {
        // Machined -> Step: cut
        // We can also set status='machined' for clarity
        await supabase.from('parts').update({ status: 'machined', updated_at: new Date().toISOString() }).eq('id', part.id);
        await updateRouterStep(part, 'cut');

      } else if (newStatusLabel === BUTTONS.KITTED) {
        // Kitted -> Status: complete
        // Prompt for bin? For now, just set complete.
        // User said "NEVER just show a button", but didn't forbid a prompt or asking.
        // But to keep it simple and usable as a dropdown:
        await supabase.from('parts').update({ status: 'complete', updated_at: new Date().toISOString() }).eq('id', part.id);
        // Note: we don't clear bin, but we might want to set it if we had a UI for it.
      }

      dispatch('update');
    } catch (e) {
      console.error('Error updating status:', e);
      alert('Failed to update status');
    }
  }

  // CAM quick actions for convenience
  async function handleCamDone() {
    try {
      // Mark CAM work done -> set step to cam_review while keeping status in-progress
      await supabase.from('parts').update({ status: 'in-progress', updated_at: new Date().toISOString() }).eq('id', part.id);
      await updateRouterStep(part, 'cam_review');
      dispatch('update');
    } catch (e) {
      console.error('Failed to set CAM Review Pending', e);
      alert('Failed to set CAM Review Pending');
    }
  }

  async function handleCamReviewed() {
    try {
      // Mark reviewed -> status cammed and explicit step cammed, remove travis flag
      await supabase.from('parts').update({ status: 'cammed', updated_at: new Date().toISOString() }).eq('id', part.id);
      const m = parseMeta(part);
      if (m.travis_progged) delete m.travis_progged;
      if (!m.router_meta) m.router_meta = {};
      m.router_meta.step = 'cammed';
      await supabase.from('parts').update({ file_url: JSON.stringify(m), updated_at: new Date().toISOString() }).eq('id', part.id);
      dispatch('update');
    } catch (e) {
      console.error('Failed to set CAM Reviewed', e);
      alert('Failed to set CAM Reviewed');
    }
  }

  async function updateRouterStep(p, step, extraMeta = {}) {
    let root = {};
    try { root = JSON.parse(p.file_url || '{}') || {}; } catch { root = {}; }
    root.router_meta = { ...(root.router_meta || {}), step, ...extraMeta };
    if (extraMeta.travis_progged) root.travis_progged = true; // also set root flag for safety
    await supabase.from('parts').update({ file_url: JSON.stringify(root), updated_at: new Date().toISOString() }).eq('id', p.id);
  }

  function handleReviewAutocam() {
    if (onReviewAutocam) {
      onReviewAutocam(part);
    } else {
      dispatch('reviewAutocam', { part });
    }
  }

</script>

<div class="status-selector">
  <!-- The shortcut for the obvious next step, where there is one. This used
       to REPLACE the dropdown rather than sit beside it, which made
       Autocammed, CAM-ing and CAM Review one-way doors: the only control on
       screen moved the part forward, so a status set by mistake could not be
       undone from here at all. -->
  {#if isAutocammed}
    <button class="btn btn-autocam cam-btn" on:click={handleReviewAutocam}>
      <Zap size={14} /> Review Autocam
    </button>
  {:else if (part.status === 'in-progress' || (meta?.router_meta && (meta.router_meta.step === 'cam_ing' || meta.router_meta.step === 'cam_review')))}
    {#if meta?.router_meta && meta.router_meta.step === 'cam_review'}
      <button class="btn btn-primary cam-btn" on:click={handleCamReviewed}>CAM Reviewed</button>
    {:else}
      <button class="btn btn-primary cam-btn" on:click={handleCamDone}>CAM Done</button>
    {/if}
  {/if}

  <!-- Always present, so any status stays reachable in either direction. -->
  <select class="status-select {badgeClass}" value={currentDisplay} on:change={handleChange}>
    {#each DISPLAY_ORDER as statusLabel}
      <option value={statusLabel}>{statusLabel}</option>
    {/each}
  </select>
</div>

<style>
  .status-selector {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  select.status-select {
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    padding: 0 2rem 0 0.75rem;
    height: var(--control-height, 32px);
    min-width: 120px;
    border-radius: var(--radius-sm, 4px);
    border: 1px solid transparent;
    background-image: url("data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%23333%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.5-3.5%205.4-7.8%205.4-12.8%200-5-1.9-9.2-5.5-12.8z%22%2F%3E%3C%2Fsvg%3E");
    background-repeat: no-repeat;
    background-position: right 0.5rem center;
    background-size: 0.5em auto;
    box-sizing: border-box;
  }

  /* Status Colors - use actual design system tokens */
  select.status-select.status-pending {
    background-color: var(--brand-gold-soft, #fff4cc);
    color: var(--brand-gold-strong, #8f5f00);
    border-color: var(--brand-gold-base, #f1c331);
  }

  select.status-select.status-progress {
    background-color: var(--blue-soft);
    color: var(--blue-base, #1d4ed8);
    border-color: var(--blue-base, #1d4ed8);
  }

  select.status-select.status-cammed {
    background-color: var(--purple-soft, #ede7f6);
    color: var(--purple-strong, #7b1fa2);
    border-color: var(--purple-base, #9c27b0);
  }

  select.status-select.status-travis {
    background-color: var(--green-soft, #d1fae5);
    color: var(--green-strong);
    border-color: var(--green-base, #4ea953);
  }

  select.status-select.status-postprocessed {
    background-color: #e0f2fe;
    color: #075985;
    border-color: #38bdf8;
  }

  select.status-select.status-jprogged {
    background-color: #fae8ff;
    color: #86198f;
    border-color: #d946ef;
  }

  select.status-select.status-complete {
    background-color: var(--green-soft, #d1fae5);
    color: var(--green-strong);
    border-color: var(--green-base, #4ea953);
  }

  /* Ensure options are readable */
  option {
    background-color: var(--color-white);
    color: var(--neutral-800);
    font-weight: 500;
  }

  /* Dark mode: legible select text + dark dropdown options */
  [data-theme="modern-dark"] select.status-select { color: var(--text); }
  [data-theme="modern-dark"] option {
    background-color: var(--surface-2);
    color: var(--text);
  }

  /* CAM action button styling */
  .cam-btn {
    height: var(--control-height, 32px);
    min-width: 120px;
    padding: 0 0.75rem;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    border-radius: var(--radius-sm, 4px);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
  }

  /* Autocam review button - orange/amber to stand out */
  .btn-autocam {
    background-color: var(--brand-gold-base, #f1c331);
    color: var(--brand-gold-strong, #8f5f00);
    border: 1px solid var(--brand-gold-base, #f1c331);
  }

  .btn-autocam:hover {
    background-color: var(--brand-gold-strong, #d4a817);
    color: var(--color-white);
  }
</style>
