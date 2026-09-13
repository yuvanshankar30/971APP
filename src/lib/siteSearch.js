const ROUTES = [
  ['Home', '/', 'General', 'dashboard start overview'],
  ['Account Settings', '/profile', 'Account', 'profile password theme appearance navigation notifications'],
  ['Manufacturing', '/manufacture', 'Manufacturing', 'requests work orders shop'],
  ['Create Manufacturing Request', '/manufacture/create', 'Manufacturing', 'new request part job'],
  ['Manufacturing Files', '/manufacture/files', 'Manufacturing', 'drive files uploads'],
  ['Completed Manufacturing', '/manufacture/completed', 'Manufacturing', 'finished jobs history'],
  ['Fusion AutoCAM', '/autocam/fusion', 'Manufacturing', 'fusion cam add-in toolpaths machining'],
  ['G-code Converter', '/manufacture/gcode-converter', 'Manufacturing', 'gcode convert cnc'],
  ['Kitting', '/kitting', 'Manufacturing', 'kit inventory bins'],
  ['COTS Stocking', '/cots-stocking', 'Manufacturing', 'inventory stock parts'],
  ['CAD', '/cad', 'CAD', 'parts designs files'],
  ['Builds', '/cad/build', 'CAD', 'build project assemblies'],
  ['Bill of Materials', '/cad/bom', 'CAD', 'bom parts list'],
  ['Purchasing', '/cad/purchasing', 'Purchasing', 'orders vendors price budget'],
  ['Planner', '/planner', 'General', 'schedule gantt timeline'],
  ['Tasks', '/tasks', 'General', 'todo work assignments'],
  ['Strategy', '/strategy', 'Competition', 'scouting match competition'],
  ['Match Scouting', '/matchscout', 'Competition', 'matches scout data'],
  ['Pit Scouting', '/pitscout', 'Competition', 'robot pits scout'],
  ['Quick Scout', '/quickscout', 'Competition', 'fast scouting'],
  ['Vision Scouting', '/scouting/vision', 'Competition', 'vision analysis'],
  ['Power Rankings', '/powerrankings', 'Competition', 'rankings teams'],
  ['Team View', '/teamview', 'Competition', 'team stats'],
  ['Notes Scouting', '/notescout', 'Competition', 'notes scout'],
  ['Docs', '/docs', 'Resources', 'documentation help guide'],
  ['Discover', '/discover', 'Resources', 'explore tools'],
  ['Admin', '/admin', 'Administration', 'roles teams users settings', 'VIEW_ADMIN_PANEL'],
  ['Scouting Admin', '/scouting-admin', 'Administration', 'scouting management assignments', 'SCOUTING_ADMIN']
].map(([label, href, category, keywords, permission]) => ({ label, href, category, keywords, permission }));

export function searchSiteRoutes(query, { canViewAdmin = false, canViewScoutingAdmin = false } = {}) {
  const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return ROUTES
    .filter((route) => !route.permission
      || (route.permission === 'VIEW_ADMIN_PANEL' && canViewAdmin)
      || (route.permission === 'SCOUTING_ADMIN' && canViewScoutingAdmin))
    .map((route) => {
      const haystack = `${route.label} ${route.category} ${route.keywords}`.toLowerCase();
      const score = terms.reduce((total, term) => total + (route.label.toLowerCase().startsWith(term) ? 4 : haystack.includes(term) ? 1 : -10), 0);
      return { ...route, score };
    })
    .filter((route) => terms.length === 0 || route.score >= 0)
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, 8);
}
