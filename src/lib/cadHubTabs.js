import { writable } from 'svelte/store';

// The CAD folder's home-page-only tile launcher (/cad-hub) - same pattern as
// competitionTabs.js's own COMPETITION_FOLDER_LABEL/competitionNavChildren.
// This has nothing to do with the CAD folder's own top-nav dropdown, which
// keeps behaving exactly as it already does - only the "CAD" card on the
// home page routes here instead of straight into the CAD subsystem browser.
export const CAD_FOLDER_LABEL = 'CAD';
export const CAD_HUB_ROUTE = '/cad-hub';

// Populated by +layout.svelte from the user's OWN resolved nav (saved
// layout, merged defaults, permission gating and all), so the hub always
// mirrors the folder it stands in front of instead of a second list that
// could drift out of sync with it.
export const cadNavChildren = writable([]);

// One line per surface, keyed by nav tab key - same convention as
// COMPETITION_TAB_DESCRIPTIONS.
export const CAD_TAB_DESCRIPTIONS = {
  cad: 'Subsystems, CAD links, and design review status',
  build: 'Build tracking for released subsystems',
  files: 'BOM exports, STEP files, and drawings'
};

export function cadTabDescription(key) {
  return CAD_TAB_DESCRIPTIONS[key] || '';
}
