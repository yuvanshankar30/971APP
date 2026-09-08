"""Shared, Fusion-generic diagnostics for reporting on CAM operations after
toolpath generation - used by both the plate and tube workflows so a real
Fusion-reported problem isn't left silent on either path.
"""

# A job with a genuinely broken template could otherwise report one warning
# per operation and fill the row with near-identical text. Enough to see the
# pattern; the Runner's own log still has every one of them.
MAX_OPERATION_WARNINGS = 10


def operation_warnings(app, cam) -> list:
    """Every surviving operation's own Fusion-reported warning, as job
    warnings.

    Fusion raises real, non-fatal warnings on operations that still report
    isToolpathValid=True and still post successfully - the operation just
    quietly machines less than it should. Issue #316 is exactly this: "One or
    more pockets were not machined because they are too small to be reached
    with given ramping constraints" appears only in Fusion's own Text
    Commands log on the machine that ran the job, so some small pocket or
    corner silently doesn't get cut and nothing anywhere in the web UI says
    so.

    Only operations still present on the setup when this runs are read - a
    caller that already deletes operations it decided not to keep (plate's
    DeleteToolpaths cleanup, tube's own _configure_face_operations) should
    call this after that cleanup, so a removed operation with no applicable
    geometry isn't reported as a warning about this part.

    Deliberately best-effort: a diagnostic must never fail a job whose
    G-code is otherwise fine.
    """
    warnings = []
    try:
        for setup in cam.setups:
            for operation in setup.operations:
                if len(warnings) >= MAX_OPERATION_WARNINGS:
                    warnings.append(
                        "More operations reported warnings than are listed here - "
                        "see the Runner's own log for the rest."
                    )
                    return warnings
                try:
                    text = str(operation.warning or "").strip()
                    name = str(operation.name or "operation")
                except Exception:
                    continue
                if not text:
                    continue
                # Collapse Fusion's own trailing newlines into one line so
                # the warning reads cleanly in a table cell.
                text = " ".join(text.split())
                warnings.append(f"Fusion reported on '{name}': {text}")
    except Exception as exc:  # noqa: BLE001 - see docstring
        app.log(f"Operation-warning check could not run: {exc}")
    return warnings


def failed_operations(cam) -> list:
    """Operations Fusion could not compute any toolpath for at all -
    genuine failures, not the ordinary "not generated yet" state every
    operation sits in for a moment right after handleTube()/SetupGenerator
    creates it (before generateAllToolpaths() has run at all).

    Call this only AFTER toolpath generation has actually completed
    (future.isGenerationCompleted). A caller that finds any entries here
    should fail the job outright rather than proceed to export/post - an
    operation with no toolpath produces no real G-code for that feature,
    silently missing it from the posted program.

    Returns a list of "<setup name> / <operation name>" strings, empty when
    every operation succeeded.
    """
    failed = []
    for setup in cam.setups:
        for operation in setup.operations:
            if operation.hasError or not operation.hasToolpath:
                failed.append("{} / {}".format(setup.name, operation.name))
    return failed
