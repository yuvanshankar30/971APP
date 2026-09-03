import { describe, expect, it } from 'vitest';
import { defaultHeaderTabs, ensurePowerRankingsTab, ensureScoutingAdminTab, ensureDataScoutTab, ensureStrategyTab } from './defaultTabs.js';

const enabled = { tabs: { powerrankings: true } };

function competitionChildren(tabs) {
  return tabs.find((tab) => tab.type === 'folder' && tab.label === 'Competition')?.children || [];
}

const savedNav = () => [
  { type: 'tab', key: 'purchasing', label: 'Purchasing' },
  {
    type: 'folder',
    label: 'Competition',
    children: [
      { key: 'pitscout', label: 'Pit Scouting' },
      { key: 'vision', label: 'Vision Scouting' }
    ]
  },
  { type: 'tab', key: 'docs', label: 'Docs' }
];

describe('defaultHeaderTabs', () => {
  it('puts Manufacturing and Competition before CAD and Purchasing', () => {
    const order = defaultHeaderTabs().map((tab) => tab.key || tab.label);
    expect(order).toEqual(['Manufacturing', 'Competition', 'CAD', 'purchasing', 'docs']);
  });

  it('includes Power Rankings and Scouting Admin in the Competition folder', () => {
    const children = competitionChildren(defaultHeaderTabs());
    expect(children).toContainEqual({ key: 'powerrankings', label: 'Power Rankings' });
    expect(children.at(-1)).toEqual({ key: 'scouting-admin', label: 'Scouting Admin' });
  });

  it('orders the scouting surfaces the way the team asked for them', () => {
    // Deliberate order, not incidental: match -> pit -> strategy -> rankings -> vision
    // -> data, with the Pick List and the admin surface after them.
    const keys = competitionChildren(defaultHeaderTabs()).map((child) => child.key);
    expect(keys).toEqual([
      'matchscout', 'pitscout', 'strategy', 'powerrankings', 'vision', 'datascout', 'scouting', 'scouting-admin'
    ]);
  });

  it('gives Data Scouting a nav entry at all', () => {
    // /datascout is a real page that previously had no entry anywhere in
    // the nav - it was reachable only by typing the URL.
    const keys = competitionChildren(defaultHeaderTabs()).map((child) => child.key);
    expect(keys).toContain('datascout');
  });

  it('keeps the other active scouting surfaces alongside it', () => {
    const keys = competitionChildren(defaultHeaderTabs()).map((child) => child.key);
    expect(keys).toContain('pitscout');
    expect(keys).toContain('matchscout');
    expect(keys).toContain('vision');
  });
});

describe('ensureStrategyTab', () => {
  it('adds Strategy to an existing Competition folder without disturbing saved tabs', () => {
    const result = ensureStrategyTab(savedNav());
    expect(competitionChildren(result).at(-1)).toEqual({ key: 'strategy', label: 'Strategy' });
  });

  it('does not duplicate Strategy when a user already placed it', () => {
    const tabs = savedNav();
    tabs[1].children.push({ key: 'strategy', label: 'Game Plan' });
    expect(ensureStrategyTab(tabs)).toBe(tabs);
  });
});

describe('ensureScoutingAdminTab', () => {
  it('appends Scouting Admin to an existing Competition folder', () => {
    const result = ensureScoutingAdminTab(savedNav());
    expect(competitionChildren(result).at(-1)).toEqual({ key: 'scouting-admin', label: 'Scouting Admin' });
  });

  it('does not add a duplicate Scouting Admin item', () => {
    const nav = savedNav();
    nav[1].children.push({ key: 'scouting-admin', label: 'Scouting Admin' });
    expect(ensureScoutingAdminTab(nav)).toBe(nav);
  });
});

describe('ensurePowerRankingsTab', () => {
  // Anyone who customized their header keeps a saved header_tabs that predates
  // this tab, and defaults never apply to them again. The augment has to add
  // the tab without disturbing anything they chose.
  it('appends to an existing Competition folder', () => {
    const result = ensurePowerRankingsTab(savedNav(), enabled);
    expect(competitionChildren(result).at(-1)).toEqual({ key: 'powerrankings', label: 'Power Rankings' });
  });

  it('preserves every other tab and their order', () => {
    const before = savedNav();
    const result = ensurePowerRankingsTab(before, enabled);
    expect(result.map((tab) => tab.key || tab.label)).toEqual(['purchasing', 'Competition', 'docs']);
    expect(competitionChildren(result).slice(0, 2)).toEqual(competitionChildren(before));
  });

  it('does not mutate the caller’s saved tabs', () => {
    const before = savedNav();
    ensurePowerRankingsTab(before, enabled);
    expect(competitionChildren(before)).toHaveLength(2);
  });

  it('is a no-op when the tab is already in the folder', () => {
    const already = savedNav();
    already[1].children.push({ key: 'powerrankings', label: 'Power Rankings' });
    expect(ensurePowerRankingsTab(already, enabled)).toBe(already);
  });

  it('respects a deliberate placement elsewhere rather than adding a second copy', () => {
    const topLevel = [
      { type: 'tab', key: 'powerrankings', label: 'Power Rankings' },
      { type: 'folder', label: 'Competition', children: [{ key: 'pitscout', label: 'Pit Scouting' }] }
    ];
    expect(ensurePowerRankingsTab(topLevel, enabled)).toBe(topLevel);
  });

  it('falls back to a top-level tab when there is no Competition folder', () => {
    const flat = [{ type: 'tab', key: 'docs', label: 'Docs' }];
    const result = ensurePowerRankingsTab(flat, enabled);
    expect(result.at(-1)).toEqual({ type: 'tab', key: 'powerrankings', label: 'Power Rankings' });
    expect(result).toHaveLength(2);
  });

  it('stays out entirely when the tab is disabled in navigation config', () => {
    const nav = savedNav();
    expect(ensurePowerRankingsTab(nav, { tabs: { powerrankings: false } })).toBe(nav);
  });

  it('tolerates malformed saved navigation', () => {
    expect(ensurePowerRankingsTab(null, enabled)).toBeNull();
    const oddFolder = [{ type: 'folder', label: 'Competition' }];
    expect(competitionChildren(ensurePowerRankingsTab(oddFolder, enabled))).toEqual([
      { key: 'powerrankings', label: 'Power Rankings' }
    ]);
  });
});

describe('ensureDataScoutTab', () => {
  it('appends Data Scouting to an existing Competition folder', () => {
    const tabs = [{ type: 'folder', label: 'Competition', children: [{ key: 'pitscout', label: 'Pit Scouting' }] }];
    const out = ensureDataScoutTab(tabs);
    expect(out[0].children.map((c) => c.key)).toEqual(['pitscout', 'datascout']);
  });

  it('leaves a nav that already has it completely alone', () => {
    const tabs = [{ type: 'folder', label: 'Competition', children: [{ key: 'datascout', label: 'Renamed By User' }] }];
    expect(ensureDataScoutTab(tabs)).toBe(tabs);
  });

  it('falls back to a top-level tab when there is no Competition folder', () => {
    const tabs = [{ type: 'tab', key: 'docs', label: 'Docs' }];
    const out = ensureDataScoutTab(tabs);
    expect(out.at(-1)).toEqual({ type: 'tab', key: 'datascout', label: 'Data Scouting' });
  });

  it('never reorders or removes what is already there', () => {
    const tabs = [
      { type: 'tab', key: 'docs', label: 'Docs' },
      { type: 'folder', label: 'Competition', children: [{ key: 'matchscout', label: 'Match Scouting' }] }
    ];
    const out = ensureDataScoutTab(tabs);
    expect(out[0]).toEqual(tabs[0]);
    expect(out[1].children[0]).toEqual(tabs[1].children[0]);
  });
});
