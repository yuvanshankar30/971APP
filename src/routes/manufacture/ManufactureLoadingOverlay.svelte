<script>
  export let compact = false;
  export let inline = false;
  export let label = 'Loading manufacturing';
</script>

<div
  class="manufacture-loader"
  class:manufacture-loader--compact={compact}
  class:manufacture-loader--inline={inline}
  role="status"
  aria-live="polite"
>
  <div class="manufacture-loader__mark" aria-hidden="true">
    <span></span><span></span><span></span><i></i>
  </div>
  <span>{label}</span>
</div>

<style>
  .manufacture-loader {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: grid;
    place-content: center;
    gap: var(--space-3);
    min-height: 9rem;
    color: var(--text-muted);
    /* The current workspace remains visible underneath. An opaque scrim
       made navigation look like a flash to a different page/theme. */
    background: transparent;
    font-size: var(--font-sm);
    text-align: center;
    pointer-events: none;
    animation: manufacturing-loader-fade 160ms ease-out both;
  }

  .manufacture-loader--compact {
    position: absolute;
    z-index: 4;
  }

  .manufacture-loader--inline {
    position: relative;
    inset: auto;
    background: transparent;
  }

  .manufacture-loader__mark {
    position: relative;
    display: grid;
    gap: 4px;
    width: 4.5rem;
    margin: 0 auto;
  }

  .manufacture-loader__mark span {
    display: block;
    height: 2px;
    background: var(--border);
  }

  .manufacture-loader__mark span:nth-child(2) { width: 78%; }
  .manufacture-loader__mark span:nth-child(3) { width: 58%; }

  .manufacture-loader__mark i {
    position: absolute;
    top: -4px;
    width: 8px;
    height: 8px;
    background: var(--brand-gold-strong);
    animation: toolpath-sweep 900ms ease-in-out infinite;
  }

  @keyframes toolpath-sweep {
    0%, 100% { left: 0; }
    50% { left: calc(100% - 8px); }
  }

  @keyframes manufacturing-loader-fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .manufacture-loader,
    .manufacture-loader__mark i { animation: none; }
    .manufacture-loader__mark i { left: calc(50% - 4px); }
  }
</style>
