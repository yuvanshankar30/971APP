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

    Walks the exception chain (__cause__/__context__), not just the
    exception handed in. Confirmed live as the reason a fresh launch still
    printed a full traceback after the first fix: being offline surfaced as
    an offline error DURING handling of an unrelated
    InternalValidationError, so the exception that finally reached the
    caller was the validation error with the real, recognizable cause
    buried one level down.
    """
    seen = set()
    current = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        text = str(current)
        if "offline settings" in text.lower() or "CB_NA" in text:
            return True
        current = current.__cause__ or current.__context__
    return False


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
                # One line when it starts, one when it gives up - not one per
                # attempt. This is an expected, self-healing startup
                # condition, and six near-identical lines of it (per folder
                # segment) buried the Text Commands window in what looked
                # like a serious fault every time Fusion launched.
                if attempt == 1:
                    app.log(
                        f"{description}: waiting for Fusion's cloud connection "
                        f"(retrying up to {attempts} times)..."
                    )
                elif attempt == attempts:
                    app.log(
                        f"{description}: still offline after {attempts} attempts - "
                        "giving up for now; this retries on its own shortly."
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


def list_data_folder_tree(app, project_name, base_folder_path, max_depth=3, max_folders=60):
    """Walks the Data Panel folder tree starting at base_folder_path (e.g.
    "" for the project root itself, or "Offseason Projects/AutoCAM" for a
    subfolder) and returns it as nested plain dicts - {"name", "path",
    "children": [...]}, path being the "/"-joined segments from the
    PROJECT ROOT, not base_folder_path (what resolve_drop_folder's
    folder_path argument expects back).

    This is read-only enumeration for the web UI's folder picker (see
    "sync-folders" in the fusion-runner API route) - not involved in
    resolving where a document actually gets saved, that's still
    resolve_drop_folder above.

    max_folders bounds the total number of dataFolders.item() calls across
    the whole walk (each is a real, synchronous Autodesk cloud round-trip)
    - direct instruction: the picker should be able to show every folder
    under the project root (FUSION_DROP_FOLDER_PATH's own default - see
    config.py), not just the one subtree under the configured drop folder.
    That matters here specifically because a full, unbounded walk from the
    project ROOT was confirmed live against the real shop account to block
    Fusion's main thread long enough to time out the MCP bridge twice in a
    row - "2026 Season CAM" has enough top-level folders that enumerating
    all of them (let alone descending 3 levels into each) is genuinely
    slow. Rather than pre-scoping the walk to a small subfolder to dodge
    that cost (the previous fix - workable, but it made "browse the whole
    project" and "the picker's default view" the same setting, which they
    aren't), bound the real cost driver directly: once the budget runs
    out, a node stops enumerating further children and is marked
    "truncated": true, so the picker gets a genuinely complete top end of
    the tree with an honest partial mid/bottom rather than either an
    unbounded blocking call or an artificially narrow default scope.

    Lowered from 200 to 60 after a second live incident: even bounded by
    count, 200 real sequential Autodesk cloud calls at ~0.5-0.9s each is
    ~2-3 minutes of continuous blocking - confirmed directly from a real
    crash-report log showing exactly that (219 getFolderContents calls,
    13:28:09-13:30:30) coinciding with Fusion appearing hung on its own
    "Preparing your experience" startup screen. The actual startup
    collision is fixed at the call site (SpartanRoboticsAutoCAM.py's
    handleServer no longer fires the first sync immediately on launch) -
    this lower default is a second, independent margin: even a
    mid-session sync taking under a minute rather than several is safer
    to run unattended on a background thread that shares Fusion's engine
    with whatever the operator is actually doing.

    Breadth-first, deliberately not the more obvious depth-first
    recursion: every folder at a given depth gets its own direct children
    listed before any of them recurses deeper. A depth-first walk would
    let the very first top-level folder's own subtree consume the whole
    budget before a second top-level folder was ever listed at all - for
    a picker whose whole point is showing the breadth of what exists
    under the project root, that reproduces the exact "only one subtree
    visible" complaint this function's root-walk support was added to
    fix, just one level removed instead of solved.
    """
    data_project, base_folder = resolve_drop_folder(app, project_name, base_folder_path)
    budget = [max_folders]
    root_node = {"name": base_folder.name, "path": base_folder_path, "children": []}
    level = [(base_folder, root_node, 0)]
    while level:
        next_level = []
        for folder, node, depth in level:
            if depth >= max_depth or budget[0] <= 0:
                if budget[0] <= 0:
                    node["truncated"] = True
                continue
            count = folder.dataFolders.count
            for i in range(count):
                if budget[0] <= 0:
                    node["truncated"] = True
                    break
                budget[0] -= 1
                child = folder.dataFolders.item(i)
                child_path = f"{node['path']}/{child.name}" if node['path'] else child.name
                child_node = {"name": child.name, "path": child_path, "children": []}
                node["children"].append(child_node)
                next_level.append((child, child_node, depth + 1))
            node["children"].sort(key=lambda n: n["name"].lower())
        level = next_level

    return {"project": data_project.name, "root": root_node}


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
            # Only the InternalValidationError "not found" flavor may fall
            # through to creating the folder. An offline failure that has
            # exhausted its retries means we still do not KNOW whether the
            # folder exists - and confirmed live in the real startup log,
            # this path was reached while offline and went straight on to
            # "'Offseason Projects' folder not found ... creating it",
            # attempting to create a folder that already exists in the
            # team's real Data Panel. Retrying only delayed that
            # misclassification rather than preventing it. Re-raise instead:
            # the caller (a periodic folder sync, or a job save) is far
            # better off failing and trying again once the connection is up
            # than silently creating a duplicate of a real folder.
            if _is_offline_settings_error(exc):
                raise
            app.log(f"itemByName('{segment}') raised instead of returning None ({exc}) - treating as not found.")
            next_folder = None
        if next_folder is None:
            app.log(f"'{segment}' folder not found under '{folder.name}', creating it...")
            try:
                next_folder = retry(lambda: folder.dataFolders.add(segment), f"dataFolders.add('{segment}')")
            except RuntimeError as add_error:
                # An offline add() means the cloud simply isn't reachable
                # yet - there is nothing to recover from and nothing the
                # fallback below can find, so stop here. Confirmed live: the
                # fallback was reached in exactly this state and raised its
                # own InternalValidationError, which is what produced the
                # full traceback on every fresh Fusion launch. Re-raising
                # the offline error instead keeps the real cause intact for
                # the caller to recognize.
                if _is_offline_settings_error(add_error):
                    raise
                # Otherwise: lost a race with another Runner/session
                # creating the same segment between the lookup above and
                # this add() - the folder exists now, so look it up for real
                # instead of failing a job save over something that isn't
                # actually a problem.
                next_folder = retry(
                    lambda: folder.dataFolders.itemByName(segment),
                    f"itemByName('{segment}') (post-add fallback)",
                )
                if next_folder is None:
                    raise
        folder = next_folder
    return data_project, folder
