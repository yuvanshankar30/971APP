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

This is also the actual job-save destination, not just the web UI's folder
picker - list_data_folder_tree's own "best-effort sync" framing doesn't
apply to camPlate.py's own call into resolve_drop_folder below, which is
how a completed job's document gets its real name and Data Panel location.
A crash here used to mean "documents not being named/saved to the AutoCAM
folder" silently - see _retry_on_offline's own docstring for why and how
that's fixed.
"""
import time


def _is_offline_settings_error(exc) -> bool:
    """True for Fusion's own "System in offline settings" / CB_NA failure -
    confirmed live as a real, transient condition in the first several
    seconds after a fresh Fusion launch, before its cloud connection has
    finished establishing, not a permanent configuration problem. Matched
    by substring since this is a generic RuntimeError with no distinct
    exception type of its own.
    """
    text = str(exc)
    return "offline settings" in text.lower() or "CB_NA" in text


def _retry_on_offline(app, attempts=6, initial_delay_seconds=1.0):
    """Decorator-style retry for a single Data Panel call that can fail
    with "System in offline settings" - confirmed live, repeatedly, as a
    real and reproducible failure mode right after Fusion starts: cloud
    Data Panel calls (dataFolders.add, itemByName re-lookups after a lost
    add() race) fail outright until the connection finishes establishing,
    typically within the first several seconds. The previous behavior
    (catch the first itemByName failure, fall through to add(), then
    re-try itemByName as a race-recovery fallback with no retry of its
    own) worked fine once Fusion was actually online, but had no path
    forward at all while genuinely offline - the fallback itemByName
    raised the identical error, uncaught, crashing the whole folder
    resolution (and with it, on the real job-save path, silently leaving
    the completed document unsaved and unnamed in the Data Panel).
    Retrying the exact same call after a short, exponentially-increasing
    pause matches what actually resolves this in practice - the
    connection finishing establishing on its own - rather than a theory
    about exactly why any single call fails.
    """
    def run(call, description):
        delay_seconds = initial_delay_seconds
        last_exc = None
        for attempt in range(1, attempts + 1):
            try:
                return call()
            except RuntimeError as exc:
                if not _is_offline_settings_error(exc):
                    raise
                last_exc = exc
                app.log(
                    f"{description} failed with 'System in offline settings' "
                    f"(attempt {attempt}/{attempts}) - Fusion's cloud "
                    f"connection may still be establishing after startup: {exc}"
                )
                if attempt < attempts:
                    time.sleep(delay_seconds)
                    delay_seconds *= 2
        raise last_exc
    return run


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
    retry = _retry_on_offline(app)
    for segment in segments:
        # itemByName is documented to return None for a missing item, but
        # confirmed live against the real shop account: it can instead raise
        # RuntimeError("... InternalValidationError : status.isOk() &&
        # folders") for the exact same "not found" case (transient Data
        # Panel sync lag, most likely - a plain retry-as-not-found recovers
        # every time this has been seen). An uncaught raise here crashed the
        # whole folder sync/job save with no fallback, even though "create
        # it" was already the correct next step one line down. Routed
        # through _retry_on_offline first, since the same call can also
        # fail with a genuine "System in offline settings" error this
        # substring-based catch would otherwise misclassify as "not found"
        # and try to (uselessly) create - see that function's own
        # docstring for why a bounded retry, not a fallback path, is the
        # real fix for that specific error.
        try:
            next_folder = retry(
                lambda: folder.dataFolders.itemByName(segment), f"itemByName('{segment}')"
            )
        except RuntimeError as exc:
            app.log(f"itemByName('{segment}') raised instead of returning None ({exc}) - treating as not found.")
            next_folder = None
        if next_folder is None:
            app.log(f"'{segment}' folder not found under '{folder.name}', creating it...")
            try:
                next_folder = retry(lambda: folder.dataFolders.add(segment), f"dataFolders.add('{segment}')")
            except RuntimeError:
                # Lost a race with another Runner/session creating the same
                # segment between the lookup above and this add() - the
                # folder exists now, so look it up for real instead of
                # failing a job save over something that isn't actually a
                # problem. Also routed through the same retry wrapper: if
                # add() failed because Fusion is genuinely still offline
                # (not a race), this re-lookup would otherwise hit the
                # identical uncaught error immediately afterward.
                next_folder = retry(
                    lambda: folder.dataFolders.itemByName(segment),
                    f"itemByName('{segment}') (post-add fallback)",
                )
                if next_folder is None:
                    raise
        folder = next_folder
    return data_project, folder
