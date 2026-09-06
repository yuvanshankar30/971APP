import { describe, expect, it } from 'vitest';
import { searchSiteRoutes } from './siteSearch.js';

describe('searchSiteRoutes', () => {
  it('returns relevant routes for a search', () => {
    expect(searchSiteRoutes('vendor order')[0].href).toBe('/cad/purchasing');
  });

  it('does not expose admin results without admin access', () => {
    expect(searchSiteRoutes('admin').some((route) => route.href === '/admin')).toBe(false);
    expect(searchSiteRoutes('admin', { canViewAdmin: true }).some((route) => route.href === '/admin')).toBe(true);
  });

  it('does not expose Scouting Admin without its scoped access', () => {
    expect(searchSiteRoutes('scouting admin').some((route) => route.href === '/scouting-admin')).toBe(false);
    expect(searchSiteRoutes('scouting admin', { canViewScoutingAdmin: true }).some((route) => route.href === '/scouting-admin')).toBe(true);
  });
});
