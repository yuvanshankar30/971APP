export const ROUTES = [
  ['Home', '/', 'General', 'dashboard start overview'],
  ['Account Settings', '/profile', 'Account', 'profile password theme appearance navigation notifications'],
  ['Manufacturing', '/manufacture', 'Manufacturing', 'requests work orders shop'],
  ['Manufacturing Hub', '/manufacture-hub', 'Manufacturing', 'workspace tabs launcher shop'],
  ['Create Manufacturing Request', '/manufacture/create', 'Manufacturing', 'new request part job'],
  ['Manufacturing Files', '/manufacture/files', 'Manufacturing', 'drive files uploads'],
  ['Completed Manufacturing', '/manufacture/completed', 'Manufacturing', 'finished jobs history'],
  ['Manufacturing Portal', '/manufacture/portal', 'Manufacturing', 'kiosk shop floor overview'],
  ['Router', '/manufacture/router', 'Manufacturing', 'router management route workflow parts'],
  ['Bins', '/manufacture/bins', 'Manufacturing', 'inventory storage location'],
  ['Manufacturing Kitting', '/manufacture/kitting', 'Manufacturing', 'kit assign parts build'],
  ['Post Processing', '/manufacture/post-processing', 'Manufacturing', 'finishing deburr countersink'],
  ['AutoCAM Settings', '/manufacture/autocam', 'Manufacturing', 'fusion cam configuration machines'],
  ['Fusion AutoCAM', '/autocam/fusion', 'Manufacturing', 'fusion cam add-in toolpaths machining'],
  ['G-code Converter', '/manufacture/gcode-converter', 'Manufacturing', 'gcode convert cnc'],
  ['JProg', '/jprog', 'Manufacturing', 'nesting sheet layout gcode cutting router'],
  ['Kitting', '/kitting', 'Manufacturing', 'kit inventory bins'],
  ['COTS Stocking', '/cots-stocking', 'Manufacturing', 'inventory stock parts'],
  ['CAD', '/cad', 'CAD', 'parts designs files'],
  ['CAD Hub', '/cad-hub', 'CAD', 'workspace tabs launcher design'],
  ['Builds', '/cad/build', 'CAD', 'build project assemblies'],
  ['Purchasing', '/cad/purchasing', 'Purchasing', 'orders vendors price budget'],
  ['Planner', '/planner', 'General', 'schedule gantt timeline'],
  ['Tasks', '/tasks', 'General', 'todo work assignments'],
  ['Competition Hub', '/competition', 'Competition', 'workspace tabs launcher event'],
  ['Strategy', '/strategy', 'Competition', 'scouting match competition'],
  ['Match Scouting', '/matchscout', 'Competition', 'matches scout data'],
  ['Pit Scouting', '/pitscout', 'Competition', 'robot pits scout'],
  ['Quick Scout', '/quickscout', 'Competition', 'fast scouting'],
  ['My Scout', '/myscout', 'Competition', 'my scouting assignments personal'],
  ['Vision Scouting', '/scouting/vision', 'Competition', 'vision analysis'],
  ['Drive Team', '/driveteam', 'Competition', 'driver operator lineup'],
  ['Match Rankings', '/matchrankings', 'Competition', 'qualification rankings teams'],
  ['Power Rankings', '/powerrankings', 'Competition', 'rankings teams'],
  ['Robot Ratings', '/robotratings', 'Competition', 'opr epa ratings teams'],
  ['EPA', '/epa', 'Competition', 'expected points added model ratings'],
  ['Pick List', '/picklist', 'Competition', 'alliance selection draft picks'],
  ['Blue Alliance', '/bluealliance', 'Competition', 'tba event data'],
  ['Team View', '/teamview', 'Competition', 'team stats'],
  ['Notes Scouting', '/notescout', 'Competition', 'notes scout'],
  ['Prediction Market', '/predictions', 'Competition', 'elo predictions matches leaderboard alliance draft picks'],
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
