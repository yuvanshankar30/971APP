def save_new_document(document, folder, name: str) -> None:
    """Save a new Fusion document without destroying an existing one.

    Real, confirmed live bug this replaced: Fusion's DataFiles collection
    has no itemByName method at all (unlike DataFolders, which does - see
    dropFolder.py's own itemByName calls on folder.dataFolders) - every
    real plate/tube job crashed outright with AttributeError: 'DataFiles'
    object has no attribute 'itemByName' the moment it tried to save.
    DataFiles supports the same count/item(i) indexing every other Fusion
    Data Panel collection in this codebase already uses (see
    resolve_data_project's own project-list scan in dropFolder.py).
    """
    existing = None
    for i in range(folder.dataFiles.count):
        candidate = folder.dataFiles.item(i)
        if candidate.name == name:
            existing = candidate
            break
    if existing:
        raise FileExistsError(
            "A Fusion document named {!r} already exists in the selected folder; "
            "choose a different name".format(name)
        )

    saved = document.saveAs(name, folder, "", "")
    if saved is False:
        raise RuntimeError("Fusion refused to save document {!r}".format(name))
