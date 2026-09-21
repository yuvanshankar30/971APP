import { writable } from 'svelte/store';

// The Manufacturing folder's home-page-only tile launcher (/manufacture-hub)
// - same pattern as competitionTabs.js/cadHubTabs.js. This has nothing to do
// with the Manufacturing folder's own top-nav dropdown, which keeps
// behaving exactly as it already does - only the "Manufacturing" card on
// the home page routes here instead of straight into the manufacturing
// tracker.
export const MANUFACTURING_FOLDER_LABEL = 'Manufacturing';
export const MANUFACTURING_HUB_ROUTE = '/manufacture-hub';

// Populated by +layout.svelte from the user's OWN resolved nav (saved
// layout, merged defaults, permission gating and all), so the hub always
// mirrors the folder it stands in front of instead of a second list that
// could drift out of sync with it.
export const manufacturingNavChildren = writable([]);

// One line per surface, keyed by nav tab key - same convention as
// COMPETITION_TAB_DESCRIPTIONS/CAD_TAB_DESCRIPTIONS.
export const MANUFACTURING_TAB_DESCRIPTIONS = {
  manufacture: 'Active parts, production status, and the router/lathe queue',
  'fusion-autocam': 'Automatic CAM generation and G-code posting for router parts',
  'gcode-converter': 'Convert and clean up G-code files by hand',
  kitting: 'Kit parts for a subsystem before it goes to build',
  'cots-stocking': 'Track COTS part stock levels',
  jprog: 'Load and manage programs on the shop CNC controllers',
  files: 'BOM exports, STEP files, and drawings'
};

export function manufacturingTabDescription(key) {
  return MANUFACTURING_TAB_DESCRIPTIONS[key] || '';
}
