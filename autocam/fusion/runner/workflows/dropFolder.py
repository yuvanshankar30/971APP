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


_RESOLVE_PROJECT_ATTEMPTS = 6
_RESOLVE_PROJECT_RETRY_DELAY_SEC = 1.0


def resolve_data_project(app, project_name):
    """Finds a Data Panel project by exact name.

    Falls back to app.data.activeProject (whatever's selected in the Data
    Panel right now) if project_name is falsy or genuinely not found - a
    safety net for if this project is ever renamed or deleted, not the
    primary way this is expected to resolve day to day
    (FUSION_DATA_PROJECT_NAME defaults to the team's real project name in
    config.py).

    Real, confirmed live bug this retry exists to fix: the periodic
    folder-sync walker (SpartanRoboticsAutoCAM.py's _advance_folder_sync)
    calls this on a background timer, including early in a fresh Fusion
    session, and the scan over app.data.dataProjects had no error
    handling at all, unlike every other Data Panel call in this file.

    A first attempt at this retried only on a raised RuntimeError (the
    same class of stale-handle glitch FolderTreeWalker.run_chunk already
    tolerates) - and still wasn't enough: confirmed live, the tree's own
    root reverted to "AutoCAM" again on a fresh relaunch, with a live,
    direct call to this exact function moments later (well past startup)
    resolving correctly on the very first try. That timing points at
    Fusion's own Data Panel project list not having finished loading yet
    right after launch - the same real, reproducible startup window
    _retry_on_offline's own docstring documents for offline cloud calls -
    except here it surfaces as projects.count silently reporting 0 (or an
    incomplete list), not a raised exception, so the old exception-only
    retry never triggered at all. A real shop account always has several
    projects; a clean scan that finds none is treated as this same
    cold-start gap and retried with the same longer, exponential backoff
    _retry_on_offline itself uses, not the short, fixed-delay retry a
    stale-handle glitch alone would have warranted.

    A scan that finds at least one project but genuinely never matches
    project_name is a different case - a real rename/deletion, not a
    timing gap - and falls back immediately without wasting retries on
    it.
    """
    if project_name:
        delay_seconds = _RESOLVE_PROJECT_RETRY_DELAY_SEC
        scanned_a_nonempty_list_without_a_match = False
        for attempt in range(1, _RESOLVE_PROJECT_ATTEMPTS + 1):
            try:
                projects = app.data.dataProjects
                count = projects.count
                for i in range(count):
                    candidate = projects.item(i)
                    if candidate.name == project_name:
                        return candidate
                if count > 0:
                    scanned_a_nonempty_list_without_a_match = True
                    break
            except RuntimeError as exc:
                if attempt == _RESOLVE_PROJECT_ATTEMPTS:
                    app.log(
                        f"Listing Fusion Data Panel projects failed {attempt} times "
                        f"while looking for '{project_name}' ({exc}) - falling back "
                        "to the active project."
                    )
                    break
                time.sleep(delay_seconds)
                delay_seconds *= 2
                continue
            # count == 0 on a clean scan (no exception) - the real
            # cold-start gap this retry exists for. Keep retrying with
            # the same backoff as a caught RuntimeError would use.
            if attempt == _RESOLVE_PROJECT_ATTEMPTS:
                app.log(
                    f"Fusion reported zero Data Panel projects on every attempt "
                    f"while looking for '{project_name}' - falling back to the "
                    "active project."
                )
                break
            time.sleep(delay_seconds)
            delay_seconds *= 2
        if scanned_a_nonempty_list_without_a_match:
            app.log(
                f"FUSION_DATA_PROJECT_NAME '{project_name}' not found among "
                "this account's Fusion projects - falling back to the active "
                "project."
            )
    return app.data.activeProject


# Folder names (case-insensitive) that get first claim on the shared
# max_folders budget at every depth of list_data_folder_tree's walk - see
# that function's own comment at the sort call for why this exists.
# "Offseason Projects" is where AutoCAM documents actually live
# (resolve_drop_folder's own docstring uses "Offseason Projects/AutoCAM"
# as its real, established example) - the one subtree the picker must
# never leave empty, even when the rest of a large project can't all fit
# in the same budget.
_PRIORITY_FOLDER_NAMES = {"offseason projects"}

# A brief pause between each dataFolders.item() call in the walk below -
# live-confirmed: a real sync (148 calls, fired back-to-back) coincided
# with Fusion itself crashing right around when the walk finished. Not a
# confirmed root cause (a native crash dump isn't something this codebase
# can fully diagnose), but a reasonable, low-cost mitigation: the same
# total call count and tree completeness, spread over a bit more
# wall-clock time instead of hammering the Data Panel client in one
# unbroken burst. 0.15s adds ~22s to a full 150-call walk - real, but
# small next to the walk's own ~75-135s of real network time.
_FOLDER_WALK_CALL_PACING_SEC = 0.15


class FolderTreeWalker:
    """Resumable breadth-first Data Panel folder walk - the same algorithm
    list_data_folder_tree documents below, split so a caller running on
    Fusion's main UI thread can advance it in short chunks instead of
    blocking that thread for the whole walk in one call.

    Root cause this exists to fix: SpartanRoboticsAutoCAM.py's
    _JobQueueEventHandler.notify() runs on Fusion's main thread (Fusion
    custom events are always dispatched there), and used to call
    list_data_folder_tree synchronously inline - up to 150 real cloud
    round-trips (each ~0.5-0.9s, plus the deliberate
    _FOLDER_WALK_CALL_PACING_SEC pacing), meaning the main thread could
    freeze solid for 97-157 seconds every _FOLDER_SYNC_INTERVAL_SEC (5
    minutes), automatically, forever, for as long as the add-in runs.
    Confirmed live: a real crash-report log from 2026-09-08 shows the main
    thread's stack frozen exactly inside this call chain (notify ->
    _sync_data_folders -> list_data_folder_tree -> dataFolders.count ->
    libcurl's _curl_easy_perform), with 5 separate crash reports inside a
    single hour - consistent with this 5-minute cadence, not a one-off.
    The previous pacing fix (spacing dataFolders.item() calls out instead
    of firing them back-to-back) reduced the risk of colliding with
    Fusion's own startup work, but never addressed that the walk still
    ran as one unbroken blocking call on the thread that owns Fusion's UI.

    Call run_chunk() repeatedly. Each incomplete call makes at most one
    cloud API call; the caller schedules the next chunk after returning to
    Fusion's event loop (see SpartanRoboticsAutoCAM.py's
    _advance_folder_sync). Once run_chunk returns True, result() has the
    same {"project", "root"} shape list_data_folder_tree always returned.
    """

    def __init__(self, app, project_name, base_folder_path, max_depth=3, max_folders=150):
        self.data_project, base_folder = resolve_drop_folder(app, project_name, base_folder_path)
        self.max_depth = max_depth
        self.budget = max_folders
        self.root_node = {"name": base_folder.name, "path": base_folder_path, "children": []}
        self._level = [(base_folder, self.root_node, 0)]
        self._next_level = []
        self._cur_index = 0
        self._child_index = None
        self._child_count = None
        self.done = False

    def run_chunk(self):
        """Makes at most one Data Panel cloud call before yielding.

        Returns True once the whole walk is done (result() is then valid),
        otherwise False so the caller can schedule a later UI event.
        """
        while True:
            if self._cur_index >= len(self._level):
                if not self._next_level:
                    self.done = True
                    return True
                for _folder, node, _depth in self._level:
                    node["children"].sort(key=lambda n: n["name"].lower())
                self._next_level.sort(
                    key=lambda entry: entry[1]["name"].strip().lower() not in _PRIORITY_FOLDER_NAMES
                )
                self._level = self._next_level
                self._next_level = []
                self._cur_index = 0
                continue

            folder, node, depth = self._level[self._cur_index]
            if depth >= self.max_depth or self.budget <= 0:
                if self.budget <= 0:
                    node["truncated"] = True
                self._cur_index += 1
                continue

            if self._child_count is None:
                try:
                    self._child_count = folder.dataFolders.count
                except RuntimeError:
                    # Confirmed live: "2 : InternalValidationError :
                    # status.isOk() && folders" from dataFolders.count/item -
                    # a folder object captured many chunks (real minutes)
                    # earlier occasionally goes stale before this walk
                    # actually reaches it. Letting this propagate resets the
                    # ENTIRE walker (see _advance_folder_sync's except
                    # clause), discarding all progress and restarting from
                    # the root - if this folder is reliably the one that
                    # fails, the sync could never get past it. Treat it the
                    # same as a real budget-exhaustion truncation instead:
                    # skip just this one node, keep everything else.
                    node["truncated"] = True
                    self._cur_index += 1
                    continue
                self._child_index = 0
                return False

            while self._child_index < self._child_count:
                if self.budget <= 0:
                    node["truncated"] = True
                    break
                try:
                    child = folder.dataFolders.item(self._child_index)
                except RuntimeError:
                    node["truncated"] = True
                    break
                self.budget -= 1
                self._child_index += 1
                # Live-confirmed: a real sync (148 dataFolders.item() calls,
                # fired back-to-back with no pause) coincided with Fusion
                # itself crashing at almost exactly the point the walk
                # finished. Spacing calls out is a real mitigation for
                # that even without a fully confirmed root cause - see the
                # class docstring above for the separate, now-diagnosed
                # main-thread-blocking issue this class fixes.
                child_path = f"{node['path']}/{child.name}" if node['path'] else child.name
                child_node = {"name": child.name, "path": child_path, "children": []}
                node["children"].append(child_node)
                self._next_level.append((child, child_node, depth + 1))
                return False

            self._cur_index += 1
            self._child_count = None
            self._child_index = None

    def result(self):
        if not self.done:
            raise RuntimeError("FolderTreeWalker.result() called before run_chunk() returned True")
        return {"project": self.data_project.name, "root": self.root_node}


def list_data_folder_tree(app, project_name, base_folder_path, max_depth=3, max_folders=150):
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

    Lowered from 200 to 60, then raised to 150, across two more live
    incidents. 60 fixed the startup-hang symptom (root cause was actually
    timing, not budget size - see below) but confirmed live to be too
    tight for this project's real structure: "Offseason Projects" (the
    actual AutoCAM save destination's parent) came back with zero
    children and truncated=true, its whole subtree consumed by other
    top-level folders enumerated earlier in the same breadth-first pass.
    That's a real usability regression, not a safe trade-off - the
    picker's whole point is showing what's actually there.
    The real root cause of the original hang was SpartanRoboticsAutoCAM.py
    firing the first sync immediately on launch, fixed independently at
    that call site (handleServer now waits ~90s past startup before its
    first sync). With that timing collision actually fixed, this budget
    no longer needs to be nearly this defensive - 150 real sequential
    calls at ~0.5-0.9s each is still bounded (~75-135s), comfortably
    covering this project's real folder count (12 top-level folders)
    without the multi-minute cost the original 200 had, while no longer
    truncating a subtree that matters.

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
                # Live-confirmed: a real sync (148 dataFolders.item() calls,
                # fired back-to-back with no pause) coincided with Fusion
                # itself crashing (a real crash dump, not just a slow UI) at
                # almost exactly the point the walk finished. Spacing calls
                # out instead of hammering the Data Panel client in one
                # unbroken burst is a real mitigation for that, even without
                # a confirmed root cause - the same total call count and
                # tree completeness, over a bit more wall-clock time.
                time.sleep(_FOLDER_WALK_CALL_PACING_SEC)
                child_path = f"{node['path']}/{child.name}" if node['path'] else child.name
                child_node = {"name": child.name, "path": child_path, "children": []}
                node["children"].append(child_node)
                next_level.append((child, child_node, depth + 1))
            node["children"].sort(key=lambda n: n["name"].lower())
        # Live-measured, not assumed: the real project has 12 top-level
        # folders, and raising max_folders alone (60 -> 150) still left
        # "Offseason Projects" - the folder AutoCAM documents actually
        # live under - with zero children and truncated=true, because 7
        # of those 12 folders' own child listings happened to exhaust the
        # shared depth-2 budget before Offseason Projects' turn came up
        # in whatever order the Data Panel API happened to return them.
        # A flat budget can't be both fast and complete for a project
        # this size - reordering so the one subtree that actually matters
        # gets first claim on whatever budget remains, every time, fixes
        # the real complaint directly instead of chasing a bigger number.
        # Every top-level folder is still listed by name either way (that
        # part was never the problem - see the module's own root-walk
        # history); this only decides whose CHILDREN get walked when
        # budget is tight.
        next_level.sort(key=lambda entry: entry[1]["name"].strip().lower() not in _PRIORITY_FOLDER_NAMES)
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
