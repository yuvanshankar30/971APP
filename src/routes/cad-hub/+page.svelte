<script>
  import { Move3d } from 'lucide-svelte';
  import FolderHubPage from '$lib/components/FolderHubPage.svelte';
  import { cadNavChildren, cadTabDescription } from '$lib/cadHubTabs.js';

  // Mirrors /competition's own page: tiles come from the same resolved nav
  // the header builds (see +layout.svelte), so a surface the user has
  // removed from their CAD folder - or one their permissions hide - does
  // not show up here either.
  $: tabs = $cadNavChildren.map((tab) => ({ ...tab, description: cadTabDescription(tab.key) }));
</script>

<FolderHubPage
  icon={Move3d}
  title="CAD"
  subtitle="Subsystems, builds, and files, in one place."
  {tabs}
  searchPlaceholder="Search CAD tools…"
  emptyTitle="No CAD tabs available"
  emptyBody="Your account does not have access to any CAD surfaces yet."
/>
