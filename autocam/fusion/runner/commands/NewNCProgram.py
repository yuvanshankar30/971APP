import adsk.core, adsk.fusion, adsk.cam
from ..config import *
import os
import json
import re
import time


def _safe_program_name(name, fallback="Program"):
    """A program name safe to use as a filename on any host.

    Job/plate names are free text ("dihRetry Test Plate", and anything a
    user types), so they can carry spaces, slashes and punctuation that
    either break a filename or silently change what gets written. Reduced
    to letters, digits, dash and underscore, which every post processor and
    filesystem in this pipeline handles.
    """
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "", str(name or "").strip().replace(" ", ""))
    return cleaned[:60] or fallback


def _post_process_with_retry(app, cam, toolpath, postProcessInput, attempts=6, initial_delay_seconds=1.0):
    """cam.postProcess() has been observed to fail with "RuntimeError 3:
    Initialization fails" specifically on the FIRST toolpath posted in a
    run, while an identical call for the very next toolpath (moments later
    in wall-clock time) succeeds - see the wait added in DeleteToolpaths.py
    for one attempt at the underlying cause (toolpath generation still
    settling), which real local testing showed was not sufficient on its
    own. Retrying the exact same call after a short pause matches what was
    actually observed to work (a later call succeeding on its own), rather
    than a theory about exactly why the first one fails.

    Confirmed a real 3-attempt/1s-flat-delay budget (~2s total between
    calls) is not always enough on its own: a real job still failed all 3
    attempts. Raised to 6 attempts with exponential backoff (1, 2, 4, 8,
    16s between calls - about 31s of total runway instead of 2s) rather
    than guessing at a different root cause (confirmed live against the
    real Fusion API docstring: postProcess's `operations` parameter
    explicitly accepts a single Operation, Setup, Folder, or Pattern
    object directly - "wrap it in an ObjectCollection" is not the fix,
    since a single object was never the problem).

    Raises the last error if every attempt fails, instead of a caller
    silently treating a real failure as success.
    """
    last_error = None
    delay_seconds = initial_delay_seconds
    for attempt in range(1, attempts + 1):
        if attempt == 1:
            # Diagnostic context for whatever this attempt is about to try,
            # logged before the call rather than only on failure - if this
            # fails again, the next run's log carries these instead of just
            # the same opaque "Initialization fails" with nothing else to
            # go on. isToolpathValid/warning reflect the toolpath's own
            # state; the rest confirms what's actually being asked for.
            try:
                app.log(
                    f"postProcess about to run for '{toolpath.name}': "
                    f"strategy={getattr(toolpath, 'strategy', '?')}, "
                    f"isToolpathValid={getattr(toolpath, 'isToolpathValid', '?')}, "
                    f"isGenerating={getattr(toolpath, 'isGenerating', '?')}, "
                    f"warning={getattr(toolpath, 'warning', '?')!r}, "
                    f"programName={getattr(postProcessInput, 'programName', '?')!r}, "
                    f"outputFolder={getattr(postProcessInput, 'outputFolder', '?')!r}"
                )
            except Exception as diag_error:
                app.log(f"(could not read toolpath diagnostics: {diag_error})")
        try:
            cam.postProcess(toolpath, postProcessInput)
            return
        except Exception as e:
            last_error = e
            app.log(
                f"postProcess attempt {attempt}/{attempts} failed for "
                f"'{toolpath.name}': {e}"
            )
            if attempt < attempts:
                adsk.doEvents()
                time.sleep(delay_seconds)
                delay_seconds *= 2
    raise last_error


def export(name, post_processor_path, setup_program_names=None):
    ui = None
    app = adsk.core.Application.get()
    ui = app.userInterface
    design = app.activeProduct

    # Ensure we are in the CAM workspace
    cam = adsk.cam.CAM.cast(design)
    allSetups = cam.setups
    if not post_processor_path or not os.path.isfile(post_processor_path):
        raise ValueError(f"Fusion post processor is unavailable: {post_processor_path}")
    absolutePath = post_processor_path
    folder_path = os.path.join(FINAL_PATH, name)
    if not os.path.exists(folder_path):
        os.makedirs(folder_path)
    # One program per SETUP, not one per operation. Direct instruction: a
    # job should hand back a single G-code file, not a pile of them - a
    # single-part plate was producing three (one per operation), which the
    # operator then has to load and run in the right order by hand.
    #
    # Fusion's own postProcess accepts a Setup directly (see
    # _post_process_with_retry's docstring) and emits every operation in
    # that setup, in CAM-browser order, into one program with the proper
    # tool changes between them. That browser order is already the correct
    # machining order and is not incidental: the template puts the outer
    # "2D Slot Cut" last precisely so the part isn't released from the stock
    # until every internal feature has been cut. Posting the setup as a unit
    # preserves that ordering by construction, where the previous
    # per-operation loops had to re-derive it by bucketing and sorting.
    #
    # This also removes a whole class of bug the old approach kept hitting:
    # two operations sharing a tool could generate the same program name and
    # silently overwrite each other's file on disk, losing an entire
    # operation's G-code while the job still reported success. With one
    # program per setup there is no name to collide.
    if setup_program_names is not None and len(setup_program_names) != allSetups.count:
        raise ValueError(
            "Expected one program name per Fusion setup; got {} names for {} setups".format(
                len(setup_program_names), allSetups.count
            )
        )

    for index, setup in enumerate(allSetups):
        operations = [op for op in setup.operations if op.name != "Suppress"]
        app.log(
            f"export(): setup '{setup.name}' has "
            f"{[(op.name, op.strategy) for op in operations]} at post time"
        )
        if not operations:
            app.log(f"export(): setup '{setup.name}' has no operations to post, skipping")
            continue

        # Nearly always exactly one setup, so the common case is a single
        # file named after the job. A second setup would otherwise post
        # under the same name and overwrite the first.
        program_name = _safe_program_name(
            setup_program_names[index] if setup_program_names is not None else name
        )
        if setup_program_names is None and allSetups.count > 1:
            program_name = f"{program_name}-{index + 1}"

        postProcessInput = adsk.cam.PostProcessInput.create(
            program_name,
            absolutePath,
            folder_path,
            adsk.cam.PostOutputUnitOptions.MillimetersOutput,
        )
        postProcessInput.isOpenInEditor = False
        # Retries first (see _post_process_with_retry); if every attempt
        # still fails that is a genuine failure and has to surface as one,
        # rather than a job reporting success with G-code missing from it.
        _post_process_with_retry(app, cam, setup, postProcessInput)
