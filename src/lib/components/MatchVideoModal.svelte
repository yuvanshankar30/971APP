<script>
  import { createEventDispatcher } from 'svelte';
  import { X } from 'lucide-svelte';

  // match: a raw TBA match object (needs .key and .videos)
  export let match = null;

  const dispatch = createEventDispatcher();
  function close() { dispatch('close'); }
  function handleKeydown(e) { if (e.key === 'Escape') close(); }

  $: youtubeKey = (match?.videos || []).find((video) => video?.type === 'youtube' && video?.key)?.key || null;
  $: tbaUrl = match?.key ? `https://www.thebluealliance.com/match/${match.key}` : '';
</script>

{#if match}
  <div
    class="modal-backdrop"
    role="button"
    tabindex="0"
    on:click|self={close}
    on:keydown={(e) => { if (e.key === 'Escape') close(); handleKeydown(e); }}
  >
    <div class="modal video-modal" role="dialog" aria-modal="true" aria-label="Match video" on:click|stopPropagation>
      <div class="modal-header">
        <h3>Match video</h3>
        <button type="button" class="modal-close-button" aria-label="Close" on:click={close}><X size={18} /></button>
      </div>
      <div class="modal-body">
        {#if youtubeKey}
          <div class="video-embed">
            <iframe
              src={`https://www.youtube.com/embed/${youtubeKey}?autoplay=1`}
              title="Match video"
              allow="autoplay; encrypted-media; picture-in-picture"
              allowfullscreen
            ></iframe>
          </div>
        {:else}
          <p class="video-empty">No embeddable video for this match yet.</p>
          {#if tbaUrl}<a class="btn btn-outline btn-sm" href={tbaUrl} target="_blank" rel="noreferrer">Open on The Blue Alliance</a>{/if}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .video-modal { --modal-width: 820px; }
  .video-embed { position: relative; width: 100%; padding-bottom: 56.25%; height: 0; }
  .video-embed iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; border-radius: var(--radius-sm); }
  .video-empty { color: var(--text-muted); margin: 0 0 var(--space-2); }
</style>
