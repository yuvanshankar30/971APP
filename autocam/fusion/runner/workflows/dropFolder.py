"""Resolves the Fusion Data Panel destination AutoCAM-generated documents
get saved into.

Both camPlate.py and camTube.py used to inline `app.data.dataProjects.item(1)`
- an index into an unordered list, not "whichever project is relevant."
Checked live against the real shop Fusion account (9 projects): item(1)
resolves to "2020 Robot CAM," a years-stale project, never the current one.

Shared here (instead of duplicated in both workflow files, this codebase's
usual pattern) because it's now more than a one-line lookup: the real
configured destination is a nested path - project "2026 Season CAM" ->
"Offseason Projects" -> "AutoCAM" (all three already exist in the shop's
account) - not a single top-level folder, so resolving it means walking
multiple path segments, not one itemByName call.
"""


def resolve_data_project(app, project_name):
    """Finds a Data Panel project by exact name.

    Falls back to app.data.activeProject (whatever's selected in the Data
    Panel right now) if project_name is falsy or not found - a safety net
    for if this project is ever renamed or deleted, not the primary way
    this is expected to resolve day to day (FUSION_DATA_PROJECT_NAME
    defaults to the team's real project name in config.py).
    """
    if project_name:
        projects = app.data.dataProjects
        for i in range(projects.count):
            candidate = projects.item(i)
            if candidate.name == project_name:
                return candidate
        app.log(
            f"FUSION_DATA_PROJECT_NAME '{project_name}' not found among "
            "this account's Fusion projects - falling back to the active "
            "project."
        )
    return app.data.activeProject


def list_data_folder_tree(app, project_name, base_folder_path, max_depth=3):
    """Walks the Data Panel folder tree starting at base_folder_path (e.g.
    "Offseason Projects/AutoCAM", the configured drop folder) and returns
    it as nested plain dicts - {"name", "path", "children": [...]}, path
    being the "/"-joined segments from the PROJECT ROOT, not base_folder_path
    (what resolve_drop_folder's folder_path argument expects back).

    This is read-only enumeration for the web UI's folder picker (see
    "sync-folders" in the fusion-runner API route) - not involved in
    resolving where a document actually gets saved, that's still
    resolve_drop_folder above.

    Deliberately scoped to base_folder_path rather than the whole project:
    confirmed live against the real shop account that even a shallow
    (depth-3) walk from the project ROOT blocked Fusion's main thread long
    enough to time out the MCP bridge twice in a row - "2026 Season CAM"
    has enough unrelated top-level folders that enumerating them all is
    genuinely too slow for a periodic sync, each dataFolders access being
    a real synchronous Autodesk cloud round-trip. Jumping straight to the
    AutoCAM folder via resolve_drop_folder's existing (already fast, used
    on every job) walk and only recursing from there keeps this to the
    part of the tree someone queueing a job actually needs to browse.
    Folders outside this subtree still work fine as a save destination via
    resolve_drop_folder; they just don't appear in the picker.
    """
    data_project, base_folder = resolve_drop_folder(app, project_name, base_folder_path)

    def walk(folder, path, depth):
        node = {"name": folder.name, "path": path, "children": []}
        if depth >= max_depth:
            return node
        for i in range(folder.dataFolders.count):
            child = folder.dataFolders.item(i)
            child_path = f"{path}/{child.name}" if path else child.name
            node["children"].append(walk(child, child_path, depth + 1))
        node["children"].sort(key=lambda n: n["name"].lower())
        return node

    return {"project": data_project.name, "root": walk(base_folder, base_folder_path, 0)}


def resolve_drop_folder(app, project_name, folder_path):
    """Finds (or creates) the nested Data Panel folder documents get saved
    into, e.g. folder_path="Offseason Projects/AutoCAM".

    Walks one path segment at a time from the resolved project's root
    folder, creating any segment that doesn't exist yet - so a fresh
    Fusion account with none of this set up still works, while an account
    that already has the real path (as this shop's does) just finds it.

    Returns (data_project, drop_folder).
    """
    data_project = resolve_data_project(app, project_name)
    folder = data_project.rootFolder
    segments = [s for s in (folder_path or "").split("/") if s.strip()]
    for segment in segments:
        # itemByName is documented to return None for a missing item, but
        # confirmed live against the real shop account: it can instead raise
        # RuntimeError("... InternalValidationError : status.isOk() &&
        # folders") for the exact same "not found" case (transient Data
        # Panel sync lag, most likely - a plain retry-as-not-found recovers
        # every time this has been seen). An uncaught raise here crashed the
        # whole folder sync/job save with no fallback, even though "create
        # it" was already the correct next step one line down.
        try:
            next_folder = folder.dataFolders.itemByName(segment)
        except RuntimeError as exc:
            app.log(f"itemByName('{segment}') raised instead of returning None ({exc}) - treating as not found.")
            next_folder = None
        if next_folder is None:
            app.log(f"'{segment}' folder not found under '{folder.name}', creating it...")
            try:
                next_folder = folder.dataFolders.add(segment)
            except RuntimeError:
                # Lost a race with another Runner/session creating the same
                # segment between the lookup above and this add() - the
                # folder exists now, so look it up for real instead of
                # failing a job save over something that isn't actually a
                # problem.
                next_folder = folder.dataFolders.itemByName(segment)
                if next_folder is None:
                    raise
        folder = next_folder
    return data_project, folder
