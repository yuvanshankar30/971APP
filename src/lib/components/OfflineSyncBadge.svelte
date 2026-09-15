<script>
  import { CloudOff, RefreshCw } from 'lucide-svelte';
  import { flushQueue, pendingSyncCount } from '$lib/offlineQueue.js';

  let syncing = false;
  async function syncNow() {
    syncing = true;
    try { await flushQueue(); } finally { syncing = false; }
  }
</script>

{#if $pendingSyncCount > 0}
  <button type="button" class="offline-sync-badge" on:click={syncNow} disabled={syncing} title="Reports saved on this phone, waiting for a connection to sync">
    <CloudOff size={14} />
    <span>{$pendingSyncCount} waiting to sync</span>
    <RefreshCw size={13} class={syncing ? 'spinning' : ''} />
  </button>
{/if}

<style>
  .offline-sync-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1, 4px);
    padding: 4px 10px;
    border: 1px solid var(--warning, #f1c331);
    border-radius: var(--radius-sm, 4px);
    background: color-mix(in srgb, var(--warning, #f1c331) 14%, transparent);
    color: var(--text, #101828);
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
  }
  .offline-sync-badge:disabled { opacity: 0.7; cursor: not-allowed; }
  :global(.spinning) { animation: offline-sync-spin 0.8s linear infinite; }
  @keyframes offline-sync-spin {
    to { transform: rotate(360deg); }
  }
</style>
