<script>
  import { confirmation, resolveConfirmation } from '$lib/confirmation.js';

  let typed = '';
  $: config = $confirmation;
  $: if (!config) typed = '';
  $: canConfirm = !config?.requireText || typed.trim() === config.requireText;

  function close() {
    resolveConfirmation(false);
  }

  function confirm() {
    if (canConfirm) resolveConfirmation(true);
  }

  function handleKeydown(event) {
    if (event.key === 'Escape') close();
  }
</script>

{#if config}
  <div class="confirm-backdrop" role="presentation" on:click|self={close} on:keydown={handleKeydown}>
    <dialog class="confirm-dialog" open aria-labelledby="confirmation-title">
      <h2 id="confirmation-title">{config.title}</h2>
      <p>{config.message}</p>
      {#if config.requireText}
        <label>
          Type <strong>{config.requireText}</strong> to continue
          <input class="form-input" bind:value={typed} autocomplete="off" on:keydown={(event) => { if (event.key === 'Enter') confirm(); }} />
        </label>
      {/if}
      <div class="confirm-actions">
        <button class="btn" on:click={close}>Cancel</button>
        <button class:btn-danger={config.danger} class:btn-primary={!config.danger} class="btn" disabled={!canConfirm} on:click={confirm}>{config.confirmLabel}</button>
      </div>
    </dialog>
  </div>
{/if}

<style>
  .confirm-backdrop { position:fixed; inset:0; z-index:1400; display:grid; place-items:center; padding:var(--space-4); background:rgb(22 24 23 / .52); }
  .confirm-dialog { width:min(100%, 30rem); padding:var(--space-5); border:1px solid var(--border); border-radius:8px; background:var(--surface-1); box-shadow:var(--shadow-lg); }
  .confirm-dialog h2 { margin:0 0 var(--space-2); font-size:var(--font-lg); }
  .confirm-dialog p { margin:0; color:var(--text-muted); white-space:pre-wrap; line-height:1.5; }
  .confirm-dialog label { display:grid; gap:var(--space-2); margin-top:var(--space-4); color:var(--text); font-size:var(--font-sm); }
  .confirm-actions { display:flex; justify-content:flex-end; gap:var(--space-2); margin-top:var(--space-5); }
</style>
