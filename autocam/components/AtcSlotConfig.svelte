<script>
  // Dedicated ATC slot configurator - separate from the general Machine
  // Profile editor on purpose. A physical ATC slot (cam_tools.tool_number)
  // can hold exactly one tool at a time (see the ShopSabre library's real
  // #5 and #6 collisions - two candidate tools sharing a slot number - in
  // autocam/docs/shopsabre-tool-swap-countersink-plan.md), so this modal is
  // strictly one single-select per detected slot number, applied straight
  // to cam_machine_tools - it never touches unnumbered/general tools,
  // which stay owned by the Machine Profile modal's plain checklist.
  import { createEventDispatcher } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { toastActions } from '$lib/toast.js';
  import { X } from 'lucide-svelte';

  const dispatch = createEventDispatcher();

  export let open = false;
  export let machineId = null;
  export let machineName = '';
  export let tools = []; // full cam_tools rows (enabled or not - filtered below)
  export let userId = null;

  let assignments = {}; // { [tool_number]: toolId | '' }
  let presets = [];
  let hubDefault = null;
  let loading = false;
  let saving = false;
  let newPresetName = '';
  let selectedPresetId = '';

  $: numberedTools = tools.filter((t) => t.enabled && t.tool_number != null);
  $: slotNumbers = [...new Set(numberedTools.map((t) => t.tool_number))].sort((a, b) => a - b);
  $: toolsForSlot = (slotNumber) => numberedTools.filter((t) => t.tool_number === slotNumber);
  $: myPresets = presets.filter((p) => !p.is_hub_default);

  $: if (open && machineId) load();

  async function load() {
    loading = true;
    try {
      const [{ data: loadedRows, error: loadedError }, { data: presetRows, error: presetError }] = await Promise.all([
        supabase.from('cam_machine_tools').select('tool_id, cam_tools(id, tool_number)').eq('machine_id', machineId),
        supabase.from('cam_machine_tool_slot_presets').select('*').eq('machine_id', machineId).order('name')
      ]);
      if (loadedError) throw loadedError;
      if (presetError) throw presetError;
      const next = {};
      for (const row of loadedRows || []) {
        const slot = row.cam_tools?.tool_number;
        if (slot != null) next[slot] = row.cam_tools.id;
      }
      assignments = next;
      presets = presetRows || [];
      hubDefault = presets.find((p) => p.is_hub_default) || null;
    } catch (e) {
      toastActions.show(e.message || 'Failed to load ATC slot configuration');
    } finally {
      loading = false;
    }
  }

  function setSlot(slotNumber, toolId) {
    assignments = { ...assignments, [slotNumber]: toolId };
  }

  function applyPresetAssignments(preset) {
    if (!preset) return;
    assignments = { ...(preset.slot_assignments || {}) };
    toastActions.show(`Loaded "${preset.name}" - remember to Apply to save it to this machine`);
  }

  function resetToHubDefault() {
    if (!hubDefault) { toastActions.show('No hub default set for this machine yet'); return; }
    applyPresetAssignments(hubDefault);
  }

  async function saveAsMyPreset() {
    const name = newPresetName.trim();
    if (!name) { toastActions.show('Name this preset before saving'); return; }
    if (!userId) { toastActions.show('Sign in to save a personal preset'); return; }
    try {
      const { data: existing, error: findError } = await supabase
        .from('cam_machine_tool_slot_presets')
        .select('id')
        .eq('machine_id', machineId)
        .eq('created_by', userId)
        .eq('name', name)
        .maybeSingle();
      if (findError) throw findError;
      if (existing) {
        const { error } = await supabase
          .from('cam_machine_tool_slot_presets')
          .update({ slot_assignments: assignments })
          .eq('id', existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('cam_machine_tool_slot_presets')
          .insert({ machine_id: machineId, created_by: userId, name, slot_assignments: assignments });
        if (error) throw error;
      }
      newPresetName = '';
      await load();
      toastActions.show(`Preset "${name}" saved`);
    } catch (e) {
      toastActions.show(e.message || 'Failed to save preset');
    }
  }

  async function deletePreset(preset) {
    try {
      const { error } = await supabase.from('cam_machine_tool_slot_presets').delete().eq('id', preset.id);
      if (error) throw error;
      await load();
    } catch (e) {
      toastActions.show(e.message || 'Failed to delete preset');
    }
  }

  async function setAsHubDefault() {
    try {
      const { error: deleteError } = await supabase
        .from('cam_machine_tool_slot_presets')
        .delete()
        .eq('machine_id', machineId)
        .eq('is_hub_default', true);
      if (deleteError) throw deleteError;
      const { error: insertError } = await supabase
        .from('cam_machine_tool_slot_presets')
        .insert({ machine_id: machineId, created_by: null, is_hub_default: true, name: 'Hub default', slot_assignments: assignments });
      if (insertError) throw insertError;
      await load();
      toastActions.show('Hub default updated to the current slot assignments');
    } catch (e) {
      toastActions.show(e.message || 'Failed to set hub default');
    }
  }

  async function applyToMachine() {
    saving = true;
    try {
      const numberedToolIds = new Set(numberedTools.map((t) => t.id));
      const { error: deleteError } = await supabase
        .from('cam_machine_tools')
        .delete()
        .eq('machine_id', machineId)
        .in('tool_id', [...numberedToolIds]);
      if (deleteError) throw deleteError;
      const toInsert = Object.values(assignments).filter(Boolean).map((tool_id) => ({ machine_id: machineId, tool_id, created_by: userId || null }));
      if (toInsert.length) {
        const { error: insertError } = await supabase.from('cam_machine_tools').insert(toInsert);
        if (insertError) throw insertError;
      }
      toastActions.show('ATC slot configuration applied');
      dispatch('applied');
      open = false;
    } catch (e) {
      // Also the real DB trigger's own message if this constructed set
      // somehow still collides (e.g. two browser tabs racing) - the
      // single-select-per-slot UI above already prevents it by construction
      // in the common case, this is the last line of defense.
      toastActions.show(e.message || 'Failed to apply ATC slot configuration');
    } finally {
      saving = false;
    }
  }

  function close() {
    open = false;
  }

  let showRenumber = false;

  // Direct correction for stale/wrong tool-library data - the plan doc's own
  // "flag, don't silently fix" data-quality note. A tool's declared slot
  // number is a fact from the imported library file, and that file can be
  // wrong (two real, distinct physical tools both labeled slot #6 here) -
  // this is the only place that number gets corrected, rather than working
  // around it by guessing at load time.
  async function renumberTool(tool, rawValue) {
    const trimmed = String(rawValue ?? '').trim();
    const parsed = trimmed === '' ? null : Number(trimmed);
    if (trimmed !== '' && (!Number.isInteger(parsed) || parsed < 1)) {
      toastActions.show('Slot number must be empty or a positive whole number');
      return;
    }
    try {
      const { error } = await supabase.from('cam_tools').update({ tool_number: parsed }).eq('id', tool.id);
      if (error) throw error;
      dispatch('toolsChanged');
      toastActions.show(`${tool.name} -> ${parsed == null ? 'no slot number' : `slot ${parsed}`}`);
    } catch (e) {
      // The real DB trigger (assert_loaded_cam_tool_slot_update) rejects this
      // if the tool is currently loaded on a machine whose slot it would now
      // collide with - a genuine safety catch, not just an edge case here.
      toastActions.show(e.message || 'Failed to update slot number');
    }
  }
</script>

{#if open}
  <div class="modal-backdrop" on:click|self={close} role="button" tabindex="0" on:keydown={(e) => { if (e.key === 'Escape') close(); }}>
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h3>ATC Slots - {machineName}</h3>
        <button type="button" class="modal-close-button" aria-label="Close" on:click={close}><X size={18} /></button>
      </div>
      <div class="modal-body">
        {#if loading}
          <p class="cam-form-hint">Loading…</p>
        {:else if !slotNumbers.length}
          <p class="cam-form-hint">No tools in the catalog have a physical slot number (tool_number) yet - import a tool library with real ATC slot data first.</p>
        {:else}
          <p class="cam-form-hint">One tool per physical slot - picking a different tool for a slot replaces whatever was there, it never stacks. Unnumbered/general tools are managed separately on the Machine Profile's Installed Tools list.</p>
          <div class="atc-slot-list">
            {#each slotNumbers as slot}
              <div class="atc-slot-row">
                <span class="atc-slot-number">Slot {slot}</span>
                <select class="form-select" value={assignments[slot] || ''} on:change={(e) => setSlot(slot, e.currentTarget.value)}>
                  <option value="">Empty</option>
                  {#each toolsForSlot(slot) as t}
                    <option value={t.id}>{t.name}{t.diameter ? ` (${t.diameter}" dia)` : ''}</option>
                  {/each}
                </select>
              </div>
            {/each}
          </div>

          <div class="atc-preset-actions">
            <button type="button" class="btn btn-ghost btn-sm" on:click={resetToHubDefault} disabled={!hubDefault}>
              Reset to hub default
            </button>
            <button type="button" class="btn btn-ghost btn-sm" on:click={setAsHubDefault}>
              Set current as hub default
            </button>
          </div>

          {#if myPresets.length}
            <div class="form-group">
              <label class="form-label" for="atc-preset-select">My presets</label>
              <div class="input-group">
                <select id="atc-preset-select" class="form-select" bind:value={selectedPresetId}>
                  <option value="">Choose a saved preset…</option>
                  {#each myPresets as p}
                    <option value={p.id}>{p.name}</option>
                  {/each}
                </select>
                <button type="button" class="btn btn-secondary btn-sm btn-nowrap" disabled={!selectedPresetId} on:click={() => applyPresetAssignments(myPresets.find((p) => p.id === selectedPresetId))}>Load</button>
                <button type="button" class="btn btn-ghost btn-sm btn-nowrap" disabled={!selectedPresetId} on:click={() => { deletePreset(myPresets.find((p) => p.id === selectedPresetId)); selectedPresetId = ''; }}>Delete</button>
              </div>
            </div>
          {/if}

          <div class="form-group">
            <label class="form-label" for="atc-preset-name">Save current slots as a preset</label>
            <div class="input-group">
              <input id="atc-preset-name" class="form-input" placeholder="e.g. Countersink day" bind:value={newPresetName} />
              <button type="button" class="btn btn-secondary btn-sm btn-nowrap" on:click={saveAsMyPreset}>Save preset</button>
            </div>
          </div>
        {/if}

        {#if !loading}
          <div class="atc-renumber-section">
            <button type="button" class="btn btn-ghost btn-sm" on:click={() => (showRenumber = !showRenumber)}>
              {showRenumber ? 'Hide' : 'Fix a tool\'s slot number'}
            </button>
            {#if showRenumber}
              <p class="cam-form-hint">The imported tool library's slot numbers can be wrong or stale (e.g. two real, distinct tools both labeled the same slot). Correct it here directly rather than guessing at load time - changing a number takes effect immediately, catalog-wide, not just for this machine.</p>
              <div class="atc-renumber-list">
                {#each tools.filter((t) => t.enabled) as t (t.id)}
                  <div class="atc-renumber-row">
                    <span class="atc-renumber-name">{t.name}{t.diameter ? ` (${t.diameter}" dia)` : ''}</span>
                    <input
                      class="form-input atc-renumber-input"
                      type="number"
                      min="1"
                      step="1"
                      placeholder="none"
                      value={t.tool_number ?? ''}
                      on:change={(e) => renumberTool(t, e.currentTarget.value)}
                    />
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
      <div class="modal-footer-actions">
        <button class="btn btn-ghost" type="button" on:click={close}>Cancel</button>
        <button class="btn btn-primary" type="button" disabled={saving || loading || !slotNumbers.length} on:click={applyToMachine}>
          {saving ? 'Applying…' : 'Apply to Machine'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .atc-slot-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0.75rem 0;
  }
  .atc-slot-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .atc-slot-number {
    flex-shrink: 0;
    width: 4.5rem;
    font-weight: 600;
    font-size: var(--font-sm, 0.9rem);
  }
  .atc-slot-row .form-select {
    flex: 1;
  }
  .atc-preset-actions {
    display: flex;
    gap: 0.5rem;
    margin: 0.75rem 0;
  }
  .atc-renumber-section {
    margin-top: 1rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
  }
  .atc-renumber-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin: 0.5rem 0;
  }
  .atc-renumber-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .atc-renumber-name {
    flex: 1;
    font-size: var(--font-sm, 0.9rem);
  }
  .atc-renumber-input {
    width: 5rem;
    flex-shrink: 0;
  }
</style>
