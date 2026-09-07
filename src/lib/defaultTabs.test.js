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
  it('puts Manufacturing and Competition before Build and Purchasing', () => {
    const order = defaultHeaderTabs().map((tab) => tab.key || tab.label);
    expect(order).toEqual(['Manufacturing', 'Competition', 'build', 'purchasing', 'docs']);
  });

  it('matches the shared header order after the separately rendered Home tab', () => {
    const order = ['home', ...defaultHeaderTabs().map((tab) => tab.key || tab.label), 'admin'];
    expect(order).toEqual(['home', 'Manufacturing', 'Competition', 'build', 'purchasing', 'docs', 'admin']);
  });

  it('omits the disconnected CAD tab while keeping Build available', () => {
    const tabs = defaultHeaderTabs();
    expect(tabs.some((tab) => tab.key === 'cad')).toBe(false);
    expect(tabs.some((tab) => tab.type === 'folder' && tab.children?.some((child) => child.key === 'cad'))).toBe(false);
    expect(tabs).toContainEqual({ type: 'tab', key: 'build', label: 'Build' });
  });

  it('includes Power Rankings and Scouting Admin in the Competition folder', () => {
    const children = competitionChildren(defaultHeaderTabs());
    expect(children).toContainEqual({ key: 'powerrankings', label: 'Power Rankings' });
    expect(children.at(-1)).toEqual({ key: 'scouting-admin', label: 'Scouting Admin' });
  });

  it('includes the raw G-code Converter in the Manufacturing folder', () => {
    expect(manufacturingChildren(defaultHeaderTabs())).toContainEqual({ key: 'gcode-converter', label: 'G-code Converter' });
  });

  it('includes Files in the Manufacturing folder', () => {
    expect(manufacturingChildren(defaultHeaderTabs())).toContainEqual({ key: 'files', label: 'Files' });
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
  it('adds G-code Converter to an existing Manufacturing folder', () => {
    const tabs = [{ type: 'folder', label: 'Manufacturing', children: [{ key: 'manufacture', label: 'Manufacture' }] }];
    const result = ensureGcodeConverterTab(tabs);
    expect(manufacturingChildren(result).at(-1)).toEqual({ key: 'gcode-converter', label: 'G-code Converter' });
  });

  it('replaces the mistaken Text Engraving entry in saved navigation', () => {
    const tabs = [{ type: 'tab', key: 'text-engraving', label: 'Text Engraving' }];
    const result = ensureGcodeConverterTab(tabs);
    expect(result).toEqual([{ type: 'tab', key: 'gcode-converter', label: 'G-code Converter' }]);
    expect(tabs[0].key).toBe('text-engraving');
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
    expect(tabs).toContainEqual({ type: 'tab', key: 'build', label: 'Build' });
    expect(tabs.some((item) => item.label === 'CAD' || item.key === 'cad')).toBe(false);
  });
});
