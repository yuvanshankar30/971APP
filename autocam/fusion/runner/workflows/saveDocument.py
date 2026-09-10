def save_new_document(document, folder, name: str) -> None:
    """Save a new Fusion document without destroying an existing one."""
    existing = folder.dataFiles.itemByName(name)
    if existing:
        raise FileExistsError(
            "A Fusion document named {!r} already exists in the selected folder; "
            "choose a different name".format(name)
        )

    saved = document.saveAs(name, folder, "", "")
    if saved is False:
        raise RuntimeError("Fusion refused to save document {!r}".format(name))
