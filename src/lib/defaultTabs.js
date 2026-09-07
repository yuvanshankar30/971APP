// Default header tabs shown to a user before they customize their navigation.
//
// Single source of truth shared by:
//   - src/routes/+layout.svelte  (fallback nav when header_tabs is null/empty)
//   - src/routes/profile/+page.svelte (seed list when a user first customizes)
//
// Grouped into three real sections (folders - a fully-supported existing nav
// concept, see buildNavItems/toLinkItem in +layout.svelte, not new UI) per
// direct feedback that a flat list of ~10 top-level tabs read as clutter for
// anyone not touching most of them day to day. Order (Home, Manufacturing,
// Competition, Build, Purchasing, Docs, Admin) keeps the team's primary daily
// workflows at the front of the header.
//   - Manufacturing: the shop-floor tools (manufacture tracking, Fusion
//     AutoCAM, Kitting, COTS Stocking) - "whatever else we add" here later
//     just needs a new entry in manufacturingChildren below. The legacy
//     per-part AutoCAM tab was removed once Fusion CAM took over G-code
//     generation for router parts (still reachable by URL like the other
//     deliberately-hidden-but-not-deleted routes below) - lathe (turning)
//     parts currently have no CAM generation surface at all as a result;
//     see the tracking issue for restoring that.
//   - Build: build tracking remains available at /cad/build. The Onshape-backed
//     CAD tab is disabled while that integration is disconnected.
//   - Competition: the active scouting surfaces only. The legacy routes
//     (Note Scouting and Team View) stay in the
//     codebase for a future restoration but are deliberately out of the
//     default menu - they are still reachable by URL, and by anyone who
//     already added them to their own saved nav.
//     Match Scouting is listed again: #89 removed the route wholesale, and it
//     has been restored and rewired to api/matchscout instead of the
//     browser-local storage it originally used.
//   - Purchasing and Docs: stand alone after the team-workflow folders.
//
// Home is rendered separately and always first; Admin is appended for
// admins by the layout, always last.
//
// The companion migration `20260903_reset_header_tabs_to_shared_default.sql`
// clears stale saved layouts once so every existing account receives this
// shared starting configuration. Subsequent per-user changes remain personal.
import navigation from '$lib/navigation.json';

function normalizeTabKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Saved layouts can retain a folder whose label matches a disabled tab. When
 * that happens, keep the folder's still-enabled children reachable without
 * leaving the retired label in the header (for example CAD -> Build).
 */
export function promoteChildrenOfDisabledFolders(tabs, navConfig = navigation) {
  if (!Array.isArray(tabs)) return tabs;
  return tabs.flatMap((item) => {
    if (item?.type !== 'folder') return [item];
    const folderKey = normalizeTabKey(item.key || item.label);
    if (navConfig?.tabs?.[folderKey] !== false) return [item];
    return (Array.isArray(item.children) ? item.children : []).filter((child) => {
      const childKey = normalizeTabKey(child?.key || child?.label);
      return navConfig?.tabs?.[childKey] !== false;
    });
  });
}

export function defaultHeaderTabs(navConfig = navigation) {
  const tabs = [];

  const manufacturingChildren = [];
  if (navConfig?.tabs?.manufacture !== false) manufacturingChildren.push({ key: 'manufacture', label: 'Manufacture' });
  if (navConfig?.tabs?.['fusion-autocam'] !== false) manufacturingChildren.push({ key: 'fusion-autocam', label: 'Fusion AutoCAM' });
  if (navConfig?.tabs?.['gcode-converter'] !== false) manufacturingChildren.push({ key: 'gcode-converter', label: 'G-code Converter' });
  if (navConfig?.tabs?.kitting !== false) manufacturingChildren.push({ key: 'kitting', label: 'Kitting' });
  if (navConfig?.tabs?.['cots-stocking'] !== false) manufacturingChildren.push({ key: 'cots-stocking', label: 'COTS Stocking' });
  if (navConfig?.tabs?.files !== false) manufacturingChildren.push({ key: 'files', label: 'Files' });
  if (manufacturingChildren.length) {
    tabs.push({ type: 'folder', label: 'Manufacturing', children: manufacturingChildren });
  }

  tabs.push({
    type: 'folder',
    label: 'Competition',
    children: [
      // Strategy leads: it is the board the team actually opens to decide
      // something, and it reads from every other surface below it.
      { key: 'strategy', label: 'Strategy' },
      { key: 'matchscout', label: 'Match Scouting' },
      { key: 'pitscout', label: 'Pit Scouting' },
      { key: 'powerrankings', label: 'Power Rankings' },
      { key: 'vision', label: 'Vision Scouting' },
      { key: 'scouting-admin', label: 'Scouting Admin' }
    ]
  });

  if (navConfig?.tabs?.build !== false) {
    tabs.push({ type: 'tab', key: 'build', label: 'Build' });
  }

  tabs.push({ type: 'tab', key: 'purchasing', label: 'Purchasing' });

  tabs.push({ type: 'tab', key: 'docs', label: 'Docs' });

  return tabs;
}

/**
 * Preserve a member's saved layout but restore every current default tab.
 * Old layouts otherwise remain permanently frozen at the set of pages that
 * existed on the day they first customized their navigation.
 */
export function mergeDefaultHeaderTabs(savedTabs, navConfig = navigation) {
  const saved = Array.isArray(savedTabs) ? savedTabs.map((item) => ({
    ...item,
    ...(item?.type === 'folder' ? { children: Array.isArray(item.children) ? [...item.children] : [] } : {})
  })) : [];
  const hasKey = (items, key) => items.some((item) => item?.key === key || (item?.type === 'folder' && hasKey(item.children || [], key)));

  for (const defaultItem of defaultHeaderTabs(navConfig)) {
    if (defaultItem.type !== 'folder') {
      if (!hasKey(saved, defaultItem.key)) saved.push({ ...defaultItem });
      continue;
    }
    const folderIndex = saved.findIndex((item) => item?.type === 'folder' && item.label === defaultItem.label);
    if (folderIndex === -1) {
      saved.push({ ...defaultItem, children: [...defaultItem.children] });
      continue;
    }
    const folder = saved[folderIndex];
    const children = Array.isArray(folder.children) ? [...folder.children] : [];
    for (const child of defaultItem.children) {
      if (!hasKey(children, child.key)) children.push({ ...child });
    }
    saved[folderIndex] = { ...folder, children };
  }
  return saved;
}


const COMPETITION_FOLDER_LABEL = 'Competition';
const MANUFACTURING_FOLDER_LABEL = 'Manufacturing';

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

// Strategy replaces the former Data Scouting navigation destination.
//
// The Data Scouting page itself is gone. /datascout still exists as the
// endpoint that reads and writes scout_data_events - Pick List, Power
// Rankings, Team View and Quick Scout all depend on it - so only the UI was
// removed, not the data.
//
// This still has to run: anyone who customized their header before the
// change has a saved 'datascout' entry pointing at a page that no longer
// renders, and swapping it here is what keeps their nav working without
// rewriting saved rows.
export function ensureStrategyTab(tabs) {
  if (!Array.isArray(tabs)) return tabs;
  if (containsTabKey(tabs, 'strategy')) return tabs;
  const entry = { key: 'strategy', label: 'Strategy' };
  const replaceDataScout = (items) => items.map((item) => {
    if (!item || typeof item !== 'object') return item;
    if (item.type === 'folder') return { ...item, children: replaceDataScout(Array.isArray(item.children) ? item.children : []) };
    return item.key === 'datascout' ? { ...item, ...entry } : item;
  });
  if (containsTabKey(tabs, 'datascout')) return replaceDataScout(tabs);
  const folderIndex = tabs.findIndex(
    (item) => item?.type === 'folder' && item?.label === COMPETITION_FOLDER_LABEL
  );
  if (folderIndex === -1) return [...tabs, { type: 'tab', ...entry }];
  const folder = tabs[folderIndex];
  const next = [...tabs];
  next[folderIndex] = { ...folder, children: [...(Array.isArray(folder.children) ? folder.children : []), entry] };
  return next;
}

export function ensureGcodeConverterTab(tabs, navConfig = navigation) {
  if (navConfig?.tabs?.['gcode-converter'] === false || !Array.isArray(tabs)) return tabs;
  if (containsTabKey(tabs, 'gcode-converter')) return tabs;
  const entry = { key: 'gcode-converter', label: 'G-code Converter' };
  const replaceTextEngraving = (items) => items.map((item) => {
    if (!item || typeof item !== 'object') return item;
    if (item.type === 'folder') return { ...item, children: replaceTextEngraving(Array.isArray(item.children) ? item.children : []) };
    return item.key === 'text-engraving' ? { ...item, ...entry } : item;
  });
  if (containsTabKey(tabs, 'text-engraving')) return replaceTextEngraving(tabs);
  const folderIndex = tabs.findIndex((item) => item?.type === 'folder' && item?.label === MANUFACTURING_FOLDER_LABEL);
  if (folderIndex === -1) return [...tabs, { type: 'tab', ...entry }];
  const folder = tabs[folderIndex];
  const next = [...tabs];
  next[folderIndex] = { ...folder, children: [...(Array.isArray(folder.children) ? folder.children : []), entry] };
  return next;
}

// Files (the manufacturing-drive shared file browser) is new - anyone with
// a saved header_tabs from before it existed needs it appended the same way
// every other post-launch tab does, or "add this for everyone" silently
// never reaches accounts that already customized their header. See
// ensureGcodeConverterTab() for the identical Manufacturing-folder pattern.
export function ensureFilesTab(tabs, navConfig = navigation) {
  if (navConfig?.tabs?.files === false || !Array.isArray(tabs)) return tabs;
  if (containsTabKey(tabs, 'files')) return tabs;
  const entry = { key: 'files', label: 'Files' };
  const folderIndex = tabs.findIndex((item) => item?.type === 'folder' && item?.label === MANUFACTURING_FOLDER_LABEL);
  if (folderIndex === -1) return [...tabs, { type: 'tab', ...entry }];
  const folder = tabs[folderIndex];
  const next = [...tabs];
  next[folderIndex] = { ...folder, children: [...(Array.isArray(folder.children) ? folder.children : []), entry] };
  return next;
}

// Fusion AutoCAM (autocam/fusion/ - the Fusion-360-backed milling pipeline)
// is new and, per its own README, deliberately kept as its own section
// rather than folded into the main /autocam "New Job" flow yet - same
// append-only augmentation every other post-launch tab needs, or "add this
// for everyone" silently never reaches accounts that already customized
// their header. See ensureGcodeConverterTab() for the identical
// Manufacturing-folder pattern.
export function ensureFusionAutocamTab(tabs, navConfig = navigation) {
  if (navConfig?.tabs?.['fusion-autocam'] === false || !Array.isArray(tabs)) return tabs;
  if (containsTabKey(tabs, 'fusion-autocam')) return tabs;
  const entry = { key: 'fusion-autocam', label: 'Fusion AutoCAM' };
  const folderIndex = tabs.findIndex((item) => item?.type === 'folder' && item?.label === MANUFACTURING_FOLDER_LABEL);
  if (folderIndex === -1) return [...tabs, { type: 'tab', ...entry }];
  const folder = tabs[folderIndex];
  const next = [...tabs];
  next[folderIndex] = { ...folder, children: [...(Array.isArray(folder.children) ? folder.children : []), entry] };
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
