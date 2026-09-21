<script>
  import { Hammer } from 'lucide-svelte';
  import FolderHubPage from '$lib/components/FolderHubPage.svelte';
  import { manufacturingNavChildren, manufacturingTabDescription } from '$lib/manufacturingHubTabs.js';

  // Mirrors /competition and /cad-hub: tiles come from the same resolved
  // nav the header builds (see +layout.svelte), so a surface the user has
  // removed from their Manufacturing folder - or one their permissions
  // hide - does not show up here either.
  $: tabs = $manufacturingNavChildren.map((tab) => ({ ...tab, description: manufacturingTabDescription(tab.key) }));
</script>

<FolderHubPage
  icon={Hammer}
  title="Manufacturing"
  subtitle="Production tracking, CAM, and shop tools, in one place."
  {tabs}
  searchPlaceholder="Search manufacturing tools…"
  emptyTitle="No manufacturing tabs available"
  emptyBody="Your account does not have access to any manufacturing surfaces yet."
/>
