import adsk.core, adsk.fusion, adsk.cam
from ..config import *
import os
import json
import re
import shutil
import time


# Direct instruction: NC programs post here, not to FINAL_PATH - Desktop is
# where the operator actually looks for the file. FINAL_PATH (temp/final/)
# stays the real write target for collect_nc_artifacts()'s upload pipeline
# (see export()'s post-process step below, which copies the same file
# there right after posting) - that directory gets shutil.rmtree()'d by
# every caller (camPlate.py etc.) right after collecting artifacts, so it
# was never a place a person should be looking for their G-code anyway.
#
# Direct instruction: post straight to the user's actual Desktop folder,
# not a symlinked Output subfolder - no shared-repo assumption, no
# machine-setup dependency.
DESKTOP_OUTPUT_PATH = os.path.expanduser("~/Desktop")


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


# Fusion's PostConfiguration objects (see _resolve_post_configuration) carry
# no filename/path property at all - only vendor/description/extension - so
# a bundled .cps can only be found again by matching its own `description =`
# string. Confirmed live against each file actually bundled in
# postprocessors/. Keep in sync if a new post is ever bundled there.
_POST_DESCRIPTIONS = {
    "shopsabre.cps": "ShopSabre with WinCNC control",
    "971_emc.cps": "Generic Enhanced Machine Controller (EMC)",
    "haas_turning.cps": "HAAS Turning",
}


def _ensure_post_registered_locally(cam, post_processor_path):
    """Makes `post_processor_path` resolvable as a PostConfiguration object.

    Confirmed live: NCPrograms.add()/NCProgram.postConfiguration (the API
    that actually files an NC program into the document - see export())
    can only be pointed at a post that Fusion's post LIBRARY already knows
    about; there is no way to hand it an arbitrary local .cps path the way
    the older cam.postProcess(toolpath, PostProcessInput) call could (every
    postConfigurationAtURL/ExternalLibraryLocation form tried against this
    bundled file failed with "does not point to a post" / "does not
    exist"). cam.personalPostFolder - Fusion's own "My Posts" folder - IS
    scanned by a LibraryLocations.LocalLibraryLocation query, with no cloud
    round-trip, so a one-time local copy there is what makes the lookup
    work at all, and keeps working with no internet connection (the same
    reason this post is bundled as a local file in the first place, rather
    than only ever fetched from Fusion's cloud post library - see
    postprocessors/ and resolve_local_post_processor()).

    Self-healing rather than a separate setup step: runs on every export()
    so a fresh machine (or one where this got deleted) fixes itself on the
    next job instead of failing with an opaque library-lookup error.
    """
    destination = os.path.join(cam.personalPostFolder, os.path.basename(post_processor_path))
    if os.path.isfile(destination):
        return
    os.makedirs(cam.personalPostFolder, exist_ok=True)
    shutil.copy2(post_processor_path, destination)


def _resolve_post_configuration(cam, post_processor_path):
    """Returns the PostConfiguration matching `post_processor_path`'s own
    `description =`, registering it locally first if needed (see
    _ensure_post_registered_locally).
    """
    file_name = os.path.basename(post_processor_path)
    expected_description = _POST_DESCRIPTIONS.get(file_name)
    if not expected_description:
        raise ValueError(
            f"No known post library description for {file_name} - add it to "
            "_POST_DESCRIPTIONS (matching that file's own `description = "
            "\"...\"` line) before it can be posted."
        )
    _ensure_post_registered_locally(cam, post_processor_path)
    post_library = adsk.cam.CAMManager.get().libraryManager.postLibrary
    query = post_library.createQuery(adsk.cam.LibraryLocations.LocalLibraryLocation)
    match = next((p for p in query.execute() if p.description == expected_description), None)
    if match is None:
        raise ValueError(
            f"Could not find '{expected_description}' in Fusion's local post "
            f"library after registering it at {cam.personalPostFolder} - a post "
            "with a colliding description may already be there under a "
            "different file."
        )
    return match


def _set_nc_program_parameter(nc_program, parameter_name, value):
    """Sets one of NCProgram's own `nc_program_*` parameters (Name/number,
    Output Folder, Unit, etc. - the exact fields the Post Process dialog's
    "Program"/"Save in the document" sections expose) by its internal
    name, confirmed live via CAMParameter.name (NOT .expressionId, which
    doesn't exist on this object - see NCProgram.parameters in the Fusion
    API stub for the full set of `nc_program_*` ids).
    """
    parameter = next((p for p in nc_program.parameters if p.name == parameter_name), None)
    if parameter is None:
        raise ValueError(f"NC program has no '{parameter_name}' parameter")
    parameter.value.value = value


def _post_process_with_retry(app, nc_program, options, attempts=6, initial_delay_seconds=1.0):
    """NCProgram.postProcess() has been observed to fail with "RuntimeError
    3: Initialization fails" specifically on the FIRST program posted in a
    run, while an identical call moments later succeeds - see the wait
    added in DeleteToolpaths.py for one attempt at the underlying cause
    (toolpath generation still settling), which real local testing showed
    was not sufficient on its own. Retrying the exact same call after a
    short pause matches what was actually observed to work (a later call
    succeeding on its own), rather than a theory about exactly why the
    first one fails. Same flakiness, same fix, as the older
    cam.postProcess(toolpath, PostProcessInput) call this replaced -
    nothing here suggests the new API is any less prone to it.

    Confirmed a real 3-attempt/1s-flat-delay budget (~2s total between
    calls) is not always enough on its own: a real job still failed all 3
    attempts. Raised to 6 attempts with exponential backoff (1, 2, 4, 8,
    16s between calls - about 31s of total runway instead of 2s).

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
            # go on.
            try:
                app.log(
                    f"NCProgram.postProcess about to run for '{nc_program.name}': "
                    f"warning={getattr(nc_program, 'warning', '?')!r}"
                )
            except Exception as diag_error:
                app.log(f"(could not read NC program diagnostics: {diag_error})")
        try:
            nc_program.postProcess(options)
            return
        except Exception as e:
            last_error = e
            app.log(
                f"NCProgram.postProcess attempt {attempt}/{attempts} failed for "
                f"'{nc_program.name}': {e}"
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

    # Real, confirmed live crash: app.activeProduct returns whatever
    # workspace happens to have UI focus, not necessarily the CAM product -
    # a Save As (save_new_document runs immediately before every caller's
    # own export() call) commonly switches Fusion's active workspace back
    # to Design, so cam = adsk.cam.CAM.cast(app.activeProduct) silently
    # resolved to None and cam.setups raised AttributeError. Resolved the
    # same robust way camPlate.py's own validators already do, straight
    # from the document's products collection rather than "whatever is
    # active" - not dependent on which tab happens to be focused.
    cam_product = app.activeDocument.products.itemByProductType("CAMProductType")
    cam = adsk.cam.CAM.cast(cam_product) if cam_product else None
    if not cam:
        raise RuntimeError(
            "No active CAM product to export from - the document may have "
            "lost its CAM context (e.g. Save As switching Fusion's active "
            "workspace back to Design)."
        )
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

    posted_program_names = []
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

        # Posting through an NCProgram (NCPrograms.add(), below) rather than
        # the older cam.postProcess(toolpath, PostProcessInput) call is what
        # actually files a persistent "NC Programs" entry into the document
        # itself (confirmed live: the older call never left anything behind
        # in cam.ncPrograms, matching a real gap - the document only ever
        # showed a posted program if someone had *also* manually run Post
        # Process through the UI for it). PostConfiguration has to be
        # resolved from Fusion's own local post library first (see
        # _resolve_post_configuration) - unlike the old API, there is no way
        # to just hand this an arbitrary .cps path directly.
        ncProgramInput = cam.ncPrograms.createInput()
        ncProgramInput.operations = [setup]
        # Every posted program groups under the SAME browser name - direct
        # instruction, not per-setup naming like `program_name` below (which
        # still controls the actual output filename in FINAL_PATH/Output).
        ncProgramInput.displayName = f"{app.activeDocument.name} AUTOCAM"
        ncProgram = cam.ncPrograms.add(ncProgramInput)

        post_configuration = _resolve_post_configuration(cam, absolutePath)
        ncProgram.postConfiguration = post_configuration
        _set_nc_program_parameter(ncProgram, "nc_program_name", program_name)
        _set_nc_program_parameter(ncProgram, "nc_program_filename", program_name)
        # Direct instruction: this is where the operator actually looks for
        # the file, not FINAL_PATH (see DESKTOP_OUTPUT_PATH's own comment).
        _set_nc_program_parameter(ncProgram, "nc_program_output_folder", DESKTOP_OUTPUT_PATH)
        _set_nc_program_parameter(ncProgram, "nc_program_openInEditor", False)
        # Direct instruction: the whole point of posting through NCProgram
        # instead of the old ad-hoc call is that Fusion keeps this entry in
        # the document's own "NC Programs" browser folder afterward.
        _set_nc_program_parameter(ncProgram, "nc_program_createInBrowser", True)
        # Direct instruction: everything AutoCAM posts should be in inches.
        # Real, confirmed live root cause of a whole class of bugs: this was
        # hardcoded to MillimetersOutput, so every New Router job posted
        # through shopsabre.cps came out in millimeters regardless of the
        # design's own modeling units - shopsabre.cps emits G22 for
        # millimeters (writeBlock(gUnitModal.format(unit == MM ? 22 : 20))),
        # and JProg's WinCNC parser has no G22 case at all, aborting the
        # whole file with "Fatal Error: UnknownGCodeError" the moment an
        # operator opens it. gcodeUnitConvert.js already patches this up
        # after the fact at download/export time (JobQueueTab.svelte,
        # manufacture/+page.svelte) - fixing it here, at the actual source
        # of every posted program's units, means that downstream patch is
        # no longer covering for a real gap in what this file asks Fusion
        # to produce in the first place. "Inches" (bare, no quotes) is this
        # choice parameter's actual value - confirmed live; its own
        # getChoices() lists it as "'Inches'" (quoted), which is NOT what it
        # accepts back.
        _set_nc_program_parameter(ncProgram, "nc_program_unit", "Inches")

        options = adsk.cam.NCProgramPostProcessOptions.create()
        # One program per setup (see the ordering comment above) routinely
        # reuses a tool's number across operations within that same setup -
        # never a real conflict there, only the older cam.postProcess() call
        # never flagged it. NCProgram.postProcess() defaults this to True and
        # raises "Different tools have the same tool number assigned to
        # them." the moment it does, which would turn every such job into a
        # failure this API introduced, not a real problem with the job.
        options.isFailOnToolNumberDuplication = False
        # Retries first (see _post_process_with_retry); if every attempt
        # still fails that is a genuine failure and has to surface as one,
        # rather than a job reporting success with G-code missing from it.
        _post_process_with_retry(app, ncProgram, options)

        # The real write happened at DESKTOP_OUTPUT_PATH (above), but
        # collect_nc_artifacts() (called by every workflow that calls
        # export() - camPlate.py etc.) still reads from FINAL_PATH/name,
        # then shutil.rmtree()s it - mirror the file there so that upload
        # pipeline keeps working unchanged. PostConfiguration.extension
        # already carries its own leading dot (confirmed live).
        source_file = os.path.join(DESKTOP_OUTPUT_PATH, f"{program_name}{post_configuration.extension}")
        if not os.path.isfile(source_file):
            raise FileNotFoundError(
                f"NCProgram.postProcess() reported success but {source_file} does not exist"
            )
        shutil.copy2(source_file, os.path.join(folder_path, os.path.basename(source_file)))
        posted_program_names.append(program_name)

    return posted_program_names
