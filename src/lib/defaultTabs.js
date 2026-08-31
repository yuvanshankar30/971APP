// Default header tabs shown to a user before they customize their navigation.
//
// Single source of truth shared by:
//   - src/routes/+layout.svelte  (fallback nav when header_tabs is null/empty)
//   - src/routes/profile/+page.svelte (seed list when a user first customizes)
//
// Grouped into three real sections (folders - a fully-supported existing nav
// concept, see buildNavItems/toLinkItem in +layout.svelte, not new UI) per
// direct feedback that a flat list of ~10 top-level tabs read as clutter for
// anyone not touching most of them day to day. Order (Home, Purchasing,
// Manufacturing, CAD, Competition, Docs, Admin) is also per direct feedback:
//   - Manufacturing: the shop-floor tools (manufacture tracking, AutoCAM,
//     Kitting, COTS Stocking) - "whatever else we add" here later just needs
//     a new entry in manufacturingChildren below.
//   - CAD: CAD and Build combined into one group, since Build is really a
//     CAD sub-concern (already lives at /cad/build).
//   - Competition: the active scouting surfaces only. The legacy routes
//     (Note Scouting and Team View) stay in the
//     codebase for a future restoration but are deliberately out of the
//     default menu - they are still reachable by URL, and by anyone who
//     already added them to their own saved nav.
//     Match Scouting is listed again: #89 removed the route wholesale, and it
//     has been restored and rewired to api/matchscout instead of the
//     browser-local storage it originally used.
//   - Purchasing and Docs: stand alone.
//
// Home is rendered separately and always first; Admin is appended for
// admins by the layout, always last. Planner/Tasks/etc. remain opt-in via
// the "Add tab" UI on the profile page - not part of this reorg, unmentioned
// in the feedback that prompted it.
//
// Note: this only changes what a user with NO saved header_tabs sees.
// Anyone who has already customized their nav keeps their own saved layout
// - same limitation already hit once before (see the Docs tab's git
// history) - there's no automatic re-migration of existing customizations.
import navigation from '$lib/navigation.json';

export function defaultHeaderTabs(navConfig = navigation) {
  const tabs = [];

  tabs.push({ type: 'tab', key: 'purchasing', label: 'Purchasing' });

  const manufacturingChildren = [];
  if (navConfig?.tabs?.manufacture !== false) manufacturingChildren.push({ key: 'manufacture', label: 'Manufacture' });
  if (navConfig?.tabs?.autocam !== false) manufacturingChildren.push({ key: 'autocam', label: 'AutoCAM' });
  if (navConfig?.tabs?.kitting !== false) manufacturingChildren.push({ key: 'kitting', label: 'Kitting' });
  if (navConfig?.tabs?.['cots-stocking'] !== false) manufacturingChildren.push({ key: 'cots-stocking', label: 'COTS Stocking' });
  if (manufacturingChildren.length) {
    tabs.push({ type: 'folder', label: 'Manufacturing', children: manufacturingChildren });
  }

  const cadChildren = [{ key: 'cad', label: 'CAD' }];
  if (navConfig?.tabs?.build !== false) cadChildren.push({ key: 'build', label: 'Build' });
  tabs.push({ type: 'folder', label: 'CAD', children: cadChildren });

  tabs.push({
    type: 'folder',
    label: 'Competition',
    children: [
      { key: 'scouting', label: 'Pick List' },
      { key: 'pitscout', label: 'Pit Scouting' },
      { key: 'matchscout', label: 'Match Scouting' },
      { key: 'vision', label: 'Vision Scouting' },
      { key: 'powerrankings', label: 'Power Rankings' },
      { key: 'scouting-admin', label: 'Scouting Admin' }
    ]
  });

  tabs.push({ type: 'tab', key: 'docs', label: 'Docs' });

  return tabs;
}


const COMPETITION_FOLDER_LABEL = 'Competition';

function containsTabKey(items, wantedKey) {
  if (!Array.isArray(items)) return false;
  return items.some((item) => {
    if (!item || typeof item !== 'object') return false;
    if (item.key === wantedKey) return true;
    return item.type === 'folder' && containsTabKey(item.children, wantedKey);
  });
}

/**
 * Put Power Rankings in someone's Competition folder without disturbing the
 * rest of their navigation.
 *
 * Anyone who already customized their header keeps a saved `header_tabs` that
 * predates this tab, and defaults never apply to them again - the same
 * limitation this file documents for every other added tab. Rather than
 * rewriting saved rows, this augments at render time: it only ever appends,
 * never reorders or removes, and does nothing at all once the tab is present
 * (including when someone has deliberately placed it elsewhere).
 *
 * Falls back to a top-level tab when there is no Competition folder to join,
 * so a user with a flat custom nav still gets it rather than silently missing
 * the feature.
 */
export function ensurePowerRankingsTab(tabs, navConfig = navigation) {
  if (navConfig?.tabs?.powerrankings === false) return tabs;
  if (!Array.isArray(tabs)) return tabs;
  if (containsTabKey(tabs, 'powerrankings')) return tabs;

  const entry = { key: 'powerrankings', label: 'Power Rankings' };
  const folderIndex = tabs.findIndex(
    (item) => item?.type === 'folder' && item?.label === COMPETITION_FOLDER_LABEL
  );
  if (folderIndex === -1) return [...tabs, { type: 'tab', ...entry }];

  const folder = tabs[folderIndex];
  const next = [...tabs];
  next[folderIndex] = {
    ...folder,
    children: [...(Array.isArray(folder.children) ? folder.children : []), entry]
  };
  return next;
}

// Scouting Admin is filtered by the layout based on the signed-in user's role.
// Adding it here also lets an authorized user with a saved/custom header see it.
export function ensureScoutingAdminTab(tabs) {
  if (!Array.isArray(tabs)) return tabs;
  if (containsTabKey(tabs, 'scouting-admin')) return tabs;

  const entry = { key: 'scouting-admin', label: 'Scouting Admin' };
  const folderIndex = tabs.findIndex(
    (item) => item?.type === 'folder' && item?.label === COMPETITION_FOLDER_LABEL
  );
  if (folderIndex === -1) return [...tabs, { type: 'tab', ...entry }];

  const folder = tabs[folderIndex];
  const next = [...tabs];
  next[folderIndex] = {
    ...folder,
    children: [...(Array.isArray(folder.children) ? folder.children : []), entry]
  };
  return next;
}
