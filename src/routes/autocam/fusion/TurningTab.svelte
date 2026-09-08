<script>
  import { RotateCcw } from 'lucide-svelte';
</script>

<section class="turning-empty-state" aria-labelledby="turning-heading">
  <RotateCcw size={24} aria-hidden="true" />
  <div>
    <h2 id="turning-heading">Turning</h2>
    <p>Coming soon.</p>
  </div>
</section>

<style>
  .turning-empty-state {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: 8rem;
    padding: 1.25rem 0;
    color: var(--text-muted);
  }

  h2,
  p {
    margin: 0;
  }

  h2 {
    color: var(--text);
    font-size: 1rem;
  }

  p {
    margin-top: 0.25rem;
  }
</style>
