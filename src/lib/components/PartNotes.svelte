<script>
  import { createEventDispatcher } from 'svelte';
  import { supabase } from '$lib/supabase.js';

  // Reusable notes control. Notes can either open from a compact link or be
  // rendered inline while retaining the modal editor.
  export let item;                 // row object containing { id, notes }
  export let table = 'parts';      // 'parts' (manufacturing) or 'purchasing'
  export let editable = true;
  export let inline = false;

  const dispatch = createEventDispatcher();

  let draft = item?.notes || '';
  let saving = false;
  let showModal = false;

  function openModal() {
    draft = item?.notes || '';
    showModal = true;
  }

  async function save() {
    const next = (draft || '').trim() || null;
    if (next === (item?.notes || null)) { showModal = false; return; }
    if (saving) return;
    saving = true;
    try {
      const { error } = await supabase
        .from(table)
        .update({ notes: next, updated_at: new Date().toISOString() })
        .eq('id', item.id);
      if (error) throw error;
      item = { ...item, notes: next };
      dispatch('update', { id: item.id, notes: next });
      showModal = false;
    } catch (e) {
      console.error('Failed to save note', e);
      alert('Failed to save note');
    } finally {
      saving = false;
    }
  }
</script>

<!-- stopPropagation so clicking here never triggers the parent row/card -->
<div class="part-notes" on:click|stopPropagation on:keydown|stopPropagation role="presentation">
  {#if item?.notes}
    {#if inline}
      <div class="inline-note">
        <svg class="note-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="8" y1="13" x2="16" y2="13" />
          <line x1="8" y1="17" x2="13" y2="17" />
        </svg>
        <span class="inline-note-text"><span class="inline-note-label">Note:</span> {item.notes}</span>
        {#if editable}
          <button type="button" class="edit-note-link" on:click={openModal} aria-label="Edit note">Edit</button>
        {/if}
      </div>
    {:else}
      <button type="button" class="view-note-link" on:click={openModal}>
        <svg class="note-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="8" y1="13" x2="16" y2="13" />
          <line x1="8" y1="17" x2="13" y2="17" />
        </svg>
        View note
      </button>
    {/if}
  {:else if editable}
    <button type="button" class="view-note-link" on:click={openModal}>
      Add note
    </button>
  {/if}
</div>

{#if showModal}
  <div
    class="note-modal-backdrop"
    on:click|self|stopPropagation={() => (showModal = false)}
    on:keydown|stopPropagation={(e) => { if (e.key === 'Escape' && e.target === e.currentTarget) showModal = false; }}
    role="button"
    tabindex="0"
  >
    <div class="note-modal" role="dialog" aria-modal="true" tabindex="-1" on:click|stopPropagation on:keydown|stopPropagation>
      <h3>Note</h3>
      {#if editable}
        <textarea
          class="note-textarea"
          bind:value={draft}
          placeholder="Write a note about this part..."
          disabled={saving}
          rows="6"
          aria-label="Note"
        ></textarea>
      {:else}
        <div class="note-body">{item.notes}</div>
      {/if}
      <div class="note-actions">
        <button type="button" class="btn" on:click={() => (showModal = false)} disabled={saving}>Cancel</button>
        {#if editable}
          <button type="button" class="btn btn-primary" on:click={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .part-notes {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.2rem;
  }

  .view-note-link {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    background: none;
    border: none;
    padding: 0;
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--accent-strong, #1d4ed8);
    text-decoration: underline;
    cursor: pointer;
    white-space: nowrap;
  }

  .view-note-link:hover { opacity: 0.8; }

  .note-icon { flex: 0 0 auto; }

  .inline-note {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
    color: var(--text-muted, #64748b);
    font-size: 0.78rem;
    line-height: 1.4;
  }

  .inline-note-text {
    /* Grows to fill the row so Edit lands right after the text (or wraps
       cleanly under it via the row's own flex-wrap for a long note) instead
       of sitting at a different height/column than the note text - the
       icon and Edit link both being their own flex-basis:auto items next
       to a growing text item is what put them on visibly different levels. */
    flex: 1 1 auto;
    min-width: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .inline-note-label {
    color: var(--text, #1f2933);
    font-weight: 700;
  }

  .edit-note-link {
    flex: 0 0 auto;
    border: none;
    background: none;
    padding: 0;
    color: var(--accent-strong, #1d4ed8);
    font: inherit;
    font-weight: 700;
    text-decoration: underline;
    cursor: pointer;
  }

  .edit-note-link:hover { opacity: 0.8; }

  .note-modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .note-modal {
    background: var(--surface-1, #fff);
    border-radius: var(--radius-md, 8px);
    padding: 1.25rem;
    width: min(460px, 92vw);
    box-shadow: var(--shadow-md, 0 10px 25px rgba(0,0,0,0.2));
  }

  .note-modal h3 { margin: 0 0 0.75rem; }

  .note-body {
    white-space: pre-wrap;
    max-height: 320px;
    overflow: auto;
    font-size: 0.9rem;
    color: var(--text, #1f2933);
    line-height: 1.5;
  }

  .note-textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    min-height: 120px;
    font-size: 0.9rem;
    line-height: 1.5;
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--border, #d1d5db);
    border-radius: var(--radius-sm, 4px);
    background: var(--surface-1, #fff);
    color: var(--text, #1f2933);
    font-family: inherit;
  }

  .note-textarea:disabled { opacity: 0.6; }

  .note-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }

  .note-actions .btn {
    padding: 0.4rem 0.9rem;
    border-radius: var(--radius-sm, 4px);
    border: 1px solid var(--border, #d1d5db);
    background: var(--surface-1, #fff);
    color: var(--text, #1f2933);
    font-size: 0.85rem;
    cursor: pointer;
  }

  .note-actions .btn:disabled { opacity: 0.6; cursor: default; }

  .note-actions .btn-primary {
    background: var(--accent-strong, #1d4ed8);
    border-color: var(--accent-strong, #1d4ed8);
    color: var(--color-white);
  }
</style>
