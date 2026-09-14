import { describe, expect, it } from 'vitest';
import { defaultHeaderTabs, ensurePowerRankingsTab, ensureScoutingAdminTab, ensureStrategyTab, ensureGcodeConverterTab, ensureFilesTab, ensureFusionAutocamTab, promoteChildrenOfDisabledFolders } from './defaultTabs.js';

const enabled = { tabs: { powerrankings: true } };

function competitionChildren(tabs) {
  return tabs.find((tab) => tab.type === 'folder' && tab.label === 'Competition')?.children || [];
}

function manufacturingChildren(tabs) {
  return tabs.find((tab) => tab.type === 'folder' && tab.label === 'Manufacturing')?.children || [];
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

  it('matches the shared header order after the separately rendered Home tab', () => {
    const order = ['home', ...defaultHeaderTabs().map((tab) => tab.key || tab.label), 'admin'];
    expect(order).toEqual(['home', 'Manufacturing', 'Competition', 'CAD', 'purchasing', 'docs', 'admin']);
  });

  it('groups CAD, Build, and Files together in the CAD folder', () => {
    const tabs = defaultHeaderTabs();
    const cad = tabs.find((tab) => tab.type === 'folder' && tab.label === 'CAD');
    expect(cad?.children).toEqual([
      { key: 'cad', label: 'CAD' },
      { key: 'build', label: 'Build' },
      { key: 'files', label: 'Files' }
    ]);
  });

  it('drops a disabled CAD or Build entry from the folder without hiding the others', () => {
    expect(defaultHeaderTabs({ tabs: { cad: false } }).find((tab) => tab.label === 'CAD').children)
      .toEqual([{ key: 'build', label: 'Build' }, { key: 'files', label: 'Files' }]);
    expect(defaultHeaderTabs({ tabs: { build: false } }).find((tab) => tab.label === 'CAD').children)
      .toEqual([{ key: 'cad', label: 'CAD' }, { key: 'files', label: 'Files' }]);
  });

  it('omits the CAD folder entirely once CAD, Build, and Files are all disabled', () => {
    const tabs = defaultHeaderTabs({ tabs: { cad: false, build: false, files: false } });
    expect(tabs.some((tab) => tab.label === 'CAD')).toBe(false);
  });

  it('includes Power Rankings and Scouting Admin in the Competition folder', () => {
    const children = competitionChildren(defaultHeaderTabs());
    expect(children).toContainEqual({ key: 'powerrankings', label: 'Power Rankings' });
    expect(children.at(-1)).toEqual({ key: 'scouting-admin', label: 'Scouting Admin' });
  });

  it('omits G-code Converter from the Manufacturing folder by default (deliberately out of the default menu, still reachable by URL)', () => {
    const keys = manufacturingChildren(defaultHeaderTabs()).map((child) => child.key);
    expect(keys).not.toContain('gcode-converter');
  });

  it('includes G-code Converter in the Manufacturing folder when explicitly re-enabled', () => {
    const tabs = defaultHeaderTabs({ tabs: { 'gcode-converter': true } });
    expect(manufacturingChildren(tabs)).toContainEqual({ key: 'gcode-converter', label: 'G-code Converter' });
  });

  it('omits Kitting and COTS Stocking from the Manufacturing folder by default (deliberately out of the default menu, still reachable by URL)', () => {
    const keys = manufacturingChildren(defaultHeaderTabs()).map((child) => child.key);
    expect(keys).not.toContain('kitting');
    expect(keys).not.toContain('cots-stocking');
  });

  it('includes Kitting and COTS Stocking in the Manufacturing folder when explicitly re-enabled', () => {
    const tabs = defaultHeaderTabs({ tabs: { kitting: true, 'cots-stocking': true } });
    const keys = manufacturingChildren(tabs).map((child) => child.key);
    expect(keys).toContain('kitting');
    expect(keys).toContain('cots-stocking');
  });

  it('includes Files in the Manufacturing folder', () => {
    expect(manufacturingChildren(defaultHeaderTabs())).toContainEqual({ key: 'files', label: 'Files' });
  });

  it('places JProg immediately above Files in the Manufacturing folder', () => {
    const keys = manufacturingChildren(defaultHeaderTabs()).map((child) => child.key);
    expect(keys.indexOf('jprog')).toBe(keys.indexOf('files') - 1);
  });

  it('includes Fusion AutoCAM but not the removed legacy AutoCAM tab in the Manufacturing folder', () => {
    const keys = manufacturingChildren(defaultHeaderTabs()).map((child) => child.key);
    expect(keys).toContain('fusion-autocam');
    expect(keys).not.toContain('autocam');
  });

  it('orders the scouting surfaces the way the team asked for them', () => {
    // Deliberate order, not incidental: strategy leads as the board the team
    // opens to decide something, then the collection surfaces that feed it
    // (match -> pit -> rankings -> vision), with the admin surface last.
    // Exactly these 6 - Pick List (the 'scouting' key) is no longer a
    // default entry, per direct feedback naming this exact list.
    const keys = competitionChildren(defaultHeaderTabs()).map((child) => child.key);
    expect(keys).toEqual([
      'strategy', 'matchscout', 'pitscout', 'powerrankings', 'vision', 'scouting-admin'
    ]);
  });

  it('replaces Data Scouting with Strategy in the default Competition menu', () => {
    const keys = competitionChildren(defaultHeaderTabs()).map((child) => child.key);
    expect(keys).toContain('strategy');
    expect(keys).not.toContain('datascout');
  });

  it('keeps the other active scouting surfaces alongside it', () => {
    const keys = competitionChildren(defaultHeaderTabs()).map((child) => child.key);
    expect(keys).toContain('pitscout');
    expect(keys).toContain('matchscout');
    expect(keys).toContain('vision');
  });
});

describe('promoteChildrenOfDisabledFolders', () => {
  it('removes a saved CAD folder shell and promotes Build', () => {
    const tabs = [{
      type: 'folder',
      label: 'CAD',
      children: [
        { key: 'cad', label: 'CAD' },
        { key: 'build', label: 'Build' }
      ]
    }];

    expect(promoteChildrenOfDisabledFolders(tabs, { tabs: { cad: false } })).toEqual([
      { key: 'build', label: 'Build' }
    ]);
  });

  it('leaves enabled and custom folders unchanged', () => {
    const tabs = [{ type: 'folder', label: 'Competition', children: [] }];
    expect(promoteChildrenOfDisabledFolders(tabs, { tabs: { cad: false } })).toEqual(tabs);
  });
});

describe('ensureGcodeConverterTab', () => {
  // Passes an explicit empty navConfig ({}) rather than the real app
  // navigation.json - G-code Converter is off there by default now
  // (deliberately out of the default menu), and this backfill helper
  // itself already honors that flag (see the guard test below), so these
  // exercise the backfill mechanism in isolation from that default.
  it('adds G-code Converter to an existing Manufacturing folder', () => {
    const tabs = [{ type: 'folder', label: 'Manufacturing', children: [{ key: 'manufacture', label: 'Manufacture' }] }];
    const result = ensureGcodeConverterTab(tabs, {});
    expect(manufacturingChildren(result).at(-1)).toEqual({ key: 'gcode-converter', label: 'G-code Converter' });
  });

  it('replaces the mistaken Text Engraving entry in saved navigation', () => {
    const tabs = [{ type: 'tab', key: 'text-engraving', label: 'Text Engraving' }];
    const result = ensureGcodeConverterTab(tabs, {});
    expect(result).toEqual([{ type: 'tab', key: 'gcode-converter', label: 'G-code Converter' }]);
    expect(tabs[0].key).toBe('text-engraving');
  });

  it('does nothing when gcode-converter is disabled in navConfig (the current real default)', () => {
    const tabs = [{ type: 'folder', label: 'Manufacturing', children: [{ key: 'manufacture', label: 'Manufacture' }] }];
    const result = ensureGcodeConverterTab(tabs);
    expect(result).toBe(tabs);
  });
});

describe('ensureFilesTab', () => {
  it('adds Files to an existing Manufacturing folder without disturbing saved tabs', () => {
    const tabs = [{ type: 'folder', label: 'Manufacturing', children: [{ key: 'manufacture', label: 'Manufacture' }] }];
    const result = ensureFilesTab(tabs);
    expect(manufacturingChildren(result)).toContainEqual({ key: 'files', label: 'Files' });
    expect(manufacturingChildren(result)).toContainEqual({ key: 'manufacture', label: 'Manufacture' });
  });

  it('does nothing once Files is already present, including if someone moved it', () => {
    const tabs = [{ type: 'tab', key: 'files', label: 'My Files' }];
    const result = ensureFilesTab(tabs);
    expect(result).toEqual(tabs);
  });

  it('falls back to a top-level tab when there is no Manufacturing folder', () => {
    const tabs = [{ type: 'tab', key: 'docs', label: 'Docs' }];
    const result = ensureFilesTab(tabs);
    expect(result).toContainEqual({ type: 'tab', key: 'files', label: 'Files' });
  });
});

describe('ensureFusionAutocamTab', () => {
  it('adds Fusion AutoCAM to an existing Manufacturing folder without disturbing saved tabs', () => {
    const tabs = [{ type: 'folder', label: 'Manufacturing', children: [{ key: 'manufacture', label: 'Manufacture' }] }];
    const result = ensureFusionAutocamTab(tabs);
    expect(manufacturingChildren(result)).toContainEqual({ key: 'fusion-autocam', label: 'Fusion AutoCAM' });
    expect(manufacturingChildren(result)).toContainEqual({ key: 'manufacture', label: 'Manufacture' });
  });

  it('does nothing once Fusion AutoCAM is already present, including if someone moved it', () => {
    const tabs = [{ type: 'tab', key: 'fusion-autocam', label: 'Fusion CAM' }];
    const result = ensureFusionAutocamTab(tabs);
    expect(result).toEqual(tabs);
  });

  it('falls back to a top-level tab when there is no Manufacturing folder', () => {
    const tabs = [{ type: 'tab', key: 'docs', label: 'Docs' }];
    const result = ensureFusionAutocamTab(tabs);
    expect(result).toContainEqual({ type: 'tab', key: 'fusion-autocam', label: 'Fusion AutoCAM' });
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

  it('replaces a saved Data Scouting entry in the same location', () => {
    const tabs = [{ type: 'folder', label: 'Competition', children: [
      { key: 'matchscout', label: 'Match Scouting' },
      { key: 'datascout', label: 'Data Scouting' },
      { key: 'vision', label: 'Vision Scouting' }
    ] }];
    const result = ensureStrategyTab(tabs);
    expect(competitionChildren(result).map((item) => item.key)).toEqual(['matchscout', 'strategy', 'vision']);
    expect(competitionChildren(result)[1].label).toBe('Strategy');
    expect(competitionChildren(tabs)[1].key).toBe('datascout');
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
import { describe, expect, it } from 'vitest';
import { mergeDefaultHeaderTabs } from './defaultTabs.js';

describe('mergeDefaultHeaderTabs', () => {
  it('keeps a saved layout while restoring missing default children', () => {
    const tabs = mergeDefaultHeaderTabs([{ type: 'folder', label: 'Manufacturing', children: [{ key: 'manufacture', label: 'Manufacture' }] }]);
    const manufacturing = tabs.find((item) => item.label === 'Manufacturing');
    expect(manufacturing.children.some((item) => item.key === 'fusion-autocam')).toBe(true);
    const cad = tabs.find((item) => item.label === 'CAD');
    expect(cad?.children).toEqual([
      { key: 'cad', label: 'CAD' },
      { key: 'build', label: 'Build' },
      { key: 'files', label: 'Files' }
    ]);
  });
});
