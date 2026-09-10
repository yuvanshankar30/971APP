<script>
  import { marked } from 'marked';
  import { page } from '$app/stores';
  import { ArrowLeft, Download, BookOpen } from 'lucide-svelte';

  // Same file the generic /docs browser also lists (this page is a second,
  // dedicated entry point for it - not a replacement) - see
  // src/routes/docs/+page.server.js's import.meta.glob for how that one
  // works across every *.md in the repo. This page only ever needs the one
  // file, so a direct ?raw import is simpler than replicating that whole
  // glob/search/folder-tree machinery for a single document.
  import teamSetupGuideRaw from '/autocam/fusion/runner/docs/team-setup-guide.md?raw';

  $: renderedHtml = marked.parse(teamSetupGuideRaw);
</script>

<svelte:head><title>Fusion AutoCAM Setup | Spartans Hub</title></svelte:head>

<div class="page-header">
  <h1><BookOpen size={28} /> Fusion AutoCAM Setup</h1>
  <a class="btn btn-secondary btn-sm" href="/autocam/fusion"><ArrowLeft size={14} /> Back to Fusion CAM</a>
</div>

<div class="card install-card">
  <div class="install-card-text">
    <h2>Install the Runner add-in</h2>
    <p>
      Run this in a normal terminal. It downloads and verifies the current Runner, installs it directly in
      Fusion's AddIns folder, then opens a one-field browser page for the Fusion Runner token:
    </p>
    <pre><code>sh -c "$(curl -fsSL {$page.url.origin}/install/fusion-runner)"</code></pre>
  </div>
  <a class="btn btn-primary install-download-btn" href="/downloads/SpartanRoboticsAutoCAM-FusionAddIn.zip" download>
    <Download size={16} /> Download Runner (.zip)
  </a>
</div>

<div class="card docs-markdown">
  {@html renderedHtml}
</div>

<p class="setup-docs-link">
  This guide also lives in <a href="/docs?file=autocam/fusion/runner/docs/team-setup-guide.md">Docs</a>, alongside every other markdown file in the repo.
</p>

<style>
  .install-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-4);
    padding: var(--space-4);
    margin-bottom: var(--space-4);
  }
  .install-card-text {
    min-width: 0;
  }
  .install-download-btn {
    flex-shrink: 0;
    white-space: nowrap;
  }
  .install-card-text h2 {
    margin: 0 0 var(--space-1);
    font-size: var(--font-lg);
  }
  .install-card-text p {
    margin: 0;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .install-card-text code {
    font-family: var(--font-mono-stack);
    background: var(--surface-2);
    padding: 0.1em 0.35em;
    border-radius: var(--radius-sm);
    font-size: 0.9em;
  }
  .install-card-text pre {
    margin: var(--space-2) 0 0;
    overflow-x: auto;
  }
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
  .docs-markdown :global(pre) {
    background: var(--surface-2);
    padding: var(--space-3);
    border-radius: var(--radius-md);
    overflow-x: auto;
  }
  .docs-markdown :global(pre code) { background: none; padding: 0; }
  .docs-markdown :global(blockquote) {
    border-left: 3px solid var(--border);
    margin: var(--space-3) 0;
    padding: var(--space-1) var(--space-3);
    color: var(--text-muted);
  }
  .docs-markdown :global(table) { border-collapse: collapse; width: 100%; margin: var(--space-3) 0; }
  .docs-markdown :global(th),
  .docs-markdown :global(td) { border: 1px solid var(--border); padding: var(--space-2); text-align: left; }
  .docs-markdown :global(a) { color: var(--accent); }
</style>
