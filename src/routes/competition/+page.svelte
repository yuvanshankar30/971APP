<script>
  import { Trophy } from 'lucide-svelte';
  import FolderHubPage from '$lib/components/FolderHubPage.svelte';
  import { competitionNavChildren, competitionTabDescription } from '$lib/competitionTabs.js';

  // The tiles come from the same resolved nav the header builds (see
  // +layout.svelte, which populates this store), so a surface the user has
  // removed from their Competition folder - or one their permissions hide -
  // does not show up here either.
  $: tabs = $competitionNavChildren.map((tab) => ({ ...tab, description: competitionTabDescription(tab.key) }));
</script>

<FolderHubPage
  icon={Trophy}
  title="Competition"
  subtitle="Every scouting and competition surface, in one place."
  {tabs}
  searchPlaceholder="Search competition tools…"
  emptyTitle="No competition tabs available"
  emptyBody="Your account does not have access to any competition surfaces yet."
/>
