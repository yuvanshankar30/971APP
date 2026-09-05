# Author-
# Description-
import adsk.core, adsk.fusion, adsk.cam
from ..config import *
import os
import time


def _post_process_with_retry(app, cam, post_target, postProcessInput, attempts=3, delay_seconds=1.0):
    """cam.postProcess() has been observed to fail with "RuntimeError 3:
    Initialization fails" specifically on the FIRST toolpath posted in a
    run, while an identical call for the very next toolpath (moments later
    in wall-clock time) succeeds - see the wait added in DeleteToolpaths.py
    for one attempt at the underlying cause (toolpath generation still
    settling), which real local testing showed was not sufficient on its
    own. Retrying the exact same call after a short pause matches what was
    actually observed to work (a later call succeeding on its own), rather
    than a theory about exactly why the first one fails.

    Raises the last error if every attempt fails, instead of a caller
    silently treating a real failure as success.
    """
    last_error = None
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
                    f"postProcess about to run for '{post_target.name}': "
                    f"strategy={getattr(post_target, 'strategy', '?')}, "
                    f"isToolpathValid={getattr(post_target, 'isToolpathValid', '?')}, "
                    f"isGenerating={getattr(post_target, 'isGenerating', '?')}, "
                    f"warning={getattr(post_target, 'warning', '?')!r}, "
                    f"programName={getattr(postProcessInput, 'programName', '?')!r}, "
                    f"outputFolder={getattr(postProcessInput, 'outputFolder', '?')!r}"
                )
            except Exception as diag_error:
                app.log(f"(could not read toolpath diagnostics: {diag_error})")
        try:
            cam.postProcess(post_target, postProcessInput)
            return
        except Exception as e:
            last_error = e
            app.log(
                f"postProcess attempt {attempt}/{attempts} failed for "
                f"'{post_target.name}': {e}"
            )
            if attempt < attempts:
                adsk.doEvents()
                time.sleep(delay_seconds)
    raise last_error


def export(name, post_processor_path):
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
    if allSetups.count == 0:
        raise ValueError('Fusion document has no CAM setups to post')
    for index, setup in enumerate(allSetups):
        operations = [operation for operation in setup.operations if not getattr(operation, 'isSuppressed', False)]
        if not operations:
            raise ValueError(f'Fusion setup {setup.name} has no enabled operations')
        # A setup is one ordered Fusion program. Posting each operation and
        # concatenating the results duplicates headers/trailers and changes
        # post semantics. Fusion documents that a Setup is a valid postProcess
        # target and preserves programmed operation order.
        program_name = f'{name}_setup_{index + 1}'
        post_input = adsk.cam.PostProcessInput.create(
            program_name,
            absolutePath,
            folder_path,
            adsk.cam.PostOutputUnitOptions.MillimetersOutput,
        )
        post_input.isOpenInEditor = False
        _post_process_with_retry(app, cam, setup, post_input)
    return folder_path
