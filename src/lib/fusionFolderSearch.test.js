import { describe, it, expect } from 'vitest';
import { searchFolderTree } from './fusionFolderSearch.js';

// Shaped like the real synced tree: the project root has path '' and a
// display name, subsystem folders nest a few deep under it.
const tree = {
  name: '2026 Season CAM',
  path: '',
  children: [
    {
      name: '1st Robot',
      path: '1st Robot',
      children: [
        { name: '0100 Drivetrain', path: '1st Robot/0100 Drivetrain', children: [] },
        {
          name: '0300 Indexer',
          path: '1st Robot/0300 Indexer',
          children: [{ name: 'Plates', path: '1st Robot/0300 Indexer/Plates', children: [] }]
        }
      ]
    },
    { name: 'Tube Import', path: 'Tube Import', children: [] }
  ]
};

describe('searchFolderTree', () => {
  it('finds a nested folder by a fragment of its own name', () => {
    expect(searchFolderTree(tree, 'indexer')).toEqual([
      { name: '0300 Indexer', path: '1st Robot/0300 Indexer' }
    ]);
  });

  it('is case-insensitive', () => {
    expect(searchFolderTree(tree, 'DRIVETRAIN')).toHaveLength(1);
    expect(searchFolderTree(tree, 'drivetrain')).toHaveLength(1);
  });

  it('matches the folder name only, never its ancestors path', () => {
    // "Plates" lives under "0300 Indexer". Searching "indexer" must return
    // the Indexer folder itself and NOT its child - matching on full path
    // would drag in every descendant of any matching parent, which for a
    // top-level match is the entire tree.
    const paths = searchFolderTree(tree, 'indexer').map((r) => r.path);
    expect(paths).not.toContain('1st Robot/0300 Indexer/Plates');
  });

  it('excludes the project root, which has no path to select', () => {
    // The root matches "2026" by name, but its path is '' - already the
    // default destination, and not a meaningful search result.
    expect(searchFolderTree(tree, '2026')).toEqual([]);
  });

  it('returns nothing for an empty or whitespace-only term', () => {
    expect(searchFolderTree(tree, '')).toEqual([]);
    expect(searchFolderTree(tree, '   ')).toEqual([]);
  });

  it('returns nothing rather than throwing on a missing tree', () => {
    expect(searchFolderTree(null, 'anything')).toEqual([]);
    expect(searchFolderTree(undefined, 'anything')).toEqual([]);
  });

  it('orders shallower matches first so the limit keeps the likely intent', () => {
    // Depth-first would let one deep branch fill the limit before a
    // shallower, more likely-intended match was ever reached.
    const wide = {
      name: 'root',
      path: '',
      children: [
        {
          name: 'deep-a',
          path: 'deep-a',
          children: [{ name: 'target inner', path: 'deep-a/target inner', children: [] }]
        },
        { name: 'target top', path: 'target top', children: [] }
      ]
    };
    expect(searchFolderTree(wide, 'target', 1)).toEqual([
      { name: 'target top', path: 'target top' }
    ]);
  });

  it('caps results at the requested limit', () => {
    const many = {
      name: 'root',
      path: '',
      children: Array.from({ length: 80 }, (_, i) => ({
        name: `match ${i}`,
        path: `match ${i}`,
        children: []
      }))
    };
    expect(searchFolderTree(many, 'match')).toHaveLength(50);
    expect(searchFolderTree(many, 'match', 5)).toHaveLength(5);
  });
});
