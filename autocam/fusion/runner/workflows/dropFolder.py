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
        next_folder = folder.dataFolders.itemByName(segment)
        if next_folder is None:
            app.log(f"'{segment}' folder not found under '{folder.name}', creating it...")
            next_folder = folder.dataFolders.add(segment)
        folder = next_folder
    return data_project, folder
