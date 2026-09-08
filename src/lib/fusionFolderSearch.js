// Flattened, name-matched search over the Fusion Data Panel folder tree the
// Runner syncs up (see list_data_folder_tree in
// autocam/fusion/runner/workflows/dropFolder.py).
//
// The picker used to browse one small subfolder, where a plain expandable
// tree was enough. It now starts at the "2026 Season CAM" project root,
// which really does have dozens of nested subsystem folders - scrolling a
// tree to find "0300 Indexer" is no longer reasonable. Kept here rather
// than duplicated inside PartsTab/BoxTubesTab so the two pickers cannot
// drift apart, and so the matching rules are unit-testable without a
// browser.

/**
 * Every folder in `node`'s subtree whose NAME matches `term`, as a flat
 * list of `{ name, path }`, nearest-the-root first.
 *
 * Matching is case-insensitive substring on the folder's own name, not its
 * full path: searching "indexer" should not also return every folder that
 * merely lives underneath a parent called "Indexer", or the whole tree
 * would match as soon as a top-level folder did.
 *
 * The root node itself is included when it matches, but only if it has a
 * real path - the project root's own path is '' (meaning "save at the
 * project root"), which is a legitimate destination but has no name to
 * match on.
 */
export function searchFolderTree(node, term, limit = 50) {
  const needle = String(term || '').trim().toLowerCase();
  if (!node || !needle) return [];
  const results = [];
  // Breadth-first so shallower (more likely intended) folders come first
  // and survive the `limit` cut, rather than one deep branch filling it.
  const queue = [node];
  while (queue.length && results.length < limit) {
    const current = queue.shift();
    const name = String(current?.name || '');
    if (name.toLowerCase().includes(needle) && current.path) {
      results.push({ name, path: current.path });
    }
    for (const child of current?.children || []) queue.push(child);
  }
  return results;
}
