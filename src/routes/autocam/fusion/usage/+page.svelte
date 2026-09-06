<script>
  import { marked } from 'marked';
  import { ArrowLeft, HelpCircle } from 'lucide-svelte';

  // Mirrors setup/+page.svelte's approach - see that file's comment for why
  // a direct ?raw import is simpler than the /docs browser's glob machinery
  // for a single document.
  import usageGuideRaw from '/autocam/fusion/runner/docs/usage-guide.md?raw';

  $: renderedHtml = marked.parse(usageGuideRaw);
</script>

<svelte:head><title>Fusion CAM Usage Guide | Spartans Hub</title></svelte:head>

<div class="page-header">
  <h1><HelpCircle size={28} /> Using Fusion CAM</h1>
  <a class="btn btn-secondary btn-sm" href="/autocam/fusion"><ArrowLeft size={14} /> Back to Fusion CAM</a>
</div>

<div class="card docs-markdown">
  {@html renderedHtml}
</div>

<p class="setup-docs-link">
  This guide also lives in <a href="/docs?file=autocam/fusion/runner/docs/usage-guide.md">Docs</a>, alongside every other markdown file in the repo.
</p>

<style>
  .docs-markdown {
    padding: var(--space-4);
  }
  .setup-docs-link {
    color: var(--text-muted);
    margin: var(--space-3) 0 0;
  }

  .docs-markdown :global(h1),
  .docs-markdown :global(h2),
  .docs-markdown :global(h3) {
    margin-top: var(--space-5);
    margin-bottom: var(--space-2);
    color: var(--secondary);
  }
  .docs-markdown :global(h1:first-child),
  .docs-markdown :global(h2:first-child),
  .docs-markdown :global(h3:first-child) {
    margin-top: 0;
  }
  .docs-markdown :global(p) { line-height: 1.6; margin: var(--space-2) 0; }
  .docs-markdown :global(ul),
  .docs-markdown :global(ol) { padding-left: var(--space-5); line-height: 1.6; }
  .docs-markdown :global(code) {
    font-family: var(--font-mono-stack);
    background: var(--surface-2);
    padding: 0.1em 0.35em;
    border-radius: var(--radius-sm);
    font-size: 0.85em;
  }
  .docs-markdown :global(a) { color: var(--accent); }
</style>
