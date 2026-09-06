import adsk.core, adsk.fusion, adsk.cam
from ..config import *
import os
import json
import re
import time


def get_tool_diameter(toolpath):
    """Get tool diameter in inches from a toolpath"""
    try:
        value = toolpath.tool.parameters.itemByName("tool_diameter").value
        return value.value / 2.54  # Convert from cm to inches
    except Exception:
        return 0


def _format_tool_label(toolpath):
    """Create a filename-friendly label from the tool diameter.

    Used to regex-strip every non-digit out of str(inches) directly -
    inches is a cm-to-inch round trip through Fusion's internal value and
    is almost never an exact float (0.1575in comes back as something like
    0.15750000000000003), so that pulled in 15+ digits of floating-point
    noise along with the real diameter, producing names like
    "S15750000000000004Pocket" instead of "S1575Pocket". Rounding first
    keeps only the digits that actually describe the tool.
    """
    try:
        value = toolpath.tool.parameters.itemByName("tool_diameter").value.value
    except Exception:
        return "0"
    inches = round(value / 2.54, 4)
    label = f"{inches:.4f}".replace(".", "").strip("0")
    return label or "0"


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
    for setup in allSetups:
        releventToolpaths = {
            "Drills": [],
            "Pocket": [],
            "Profile": [],
        }
        app.log(
            f"export(): setup '{setup.name}' has "
            f"{[(op.name, op.strategy) for op in setup.operations]} at categorization time"
        )
        for toolpath in setup.operations:
            if toolpath.name == "Suppress":
                continue
            if toolpath.strategy == "drill":
                releventToolpaths["Drills"].append(toolpath)
            elif toolpath.strategy == "pocket_clearing":
                releventToolpaths["Pocket"].append(toolpath)
            else:
                releventToolpaths["Profile"].append(toolpath)
        app.log(
            f"export(): categorized -> Drills={[t.name for t in releventToolpaths['Drills']]}, "
            f"Pocket={[t.name for t in releventToolpaths['Pocket']]}, "
            f"Profile={[t.name for t in releventToolpaths['Profile']]}"
        )

        # Sort drills by diameter ascending (smallest first)
        releventToolpaths["Drills"].sort(key=get_tool_diameter)
        # Sort pockets by diameter descending (largest first)
        releventToolpaths["Pocket"].sort(key=get_tool_diameter, reverse=True)

        for toolpath in releventToolpaths["Drills"]:
            postProcessInput = adsk.cam.PostProcessInput.create(
                setup.name[0] + str(toolpath.name).split(" ")[0],
                absolutePath,
                folder_path,
                adsk.cam.PostOutputUnitOptions.MillimetersOutput,
            )
            postProcessInput.isOpenInEditor = False
            _post_process_with_retry(app, cam, toolpath, postProcessInput)
        for toolpath in releventToolpaths["Pocket"]:
            tool = _format_tool_label(toolpath)
            postProcessInput = adsk.cam.PostProcessInput.create(
                setup.name[0] + tool + "Pocket",
                absolutePath,
                folder_path,
                adsk.cam.PostOutputUnitOptions.MillimetersOutput,
            )
            postProcessInput.isOpenInEditor = False
            # Used to catch-and-log here, which meant a Pocket toolpath that
            # failed to post was silently missing from the exported G-code
            # while the job still reported success - real, otherwise-silent
            # data loss for whoever ran the resulting file. Retries first
            # (see _post_process_with_retry); if every attempt still fails,
            # that is a genuine failure and has to surface as one.
            _post_process_with_retry(app, cam, toolpath, postProcessInput)

        # Confirmed on a real job: two operations sharing a tool (e.g. a
        # "bore" fallback operation and the real "contour2d" perimeter/tab
        # cut, both landing in this catch-all bucket since neither is
        # "drill" or "pocket_clearing") produced the IDENTICAL program name
        # here (setup.name[0] + tool + "Profile" - the tool label is the
        # only thing that varied, and both used the same tool). The second
        # post silently overwrote the first's file on disk, and
        # collect_nc_artifacts only ever saw whichever one wrote last -
        # real, silent data loss of an entire operation's G-code, not a
        # posting failure (both posts succeeded; postProcess doesn't know
        # or care that another operation already used that filename). Fixed
        # by folding the operation's own index within this bucket into the
        # name so two operations can never collide just for sharing a tool.
        for index, toolpath in enumerate(releventToolpaths["Profile"]):
            tool = _format_tool_label(toolpath)
            suffix = "Profile" if len(releventToolpaths["Profile"]) == 1 else f"Profile{index + 1}"
            postProcessInput = adsk.cam.PostProcessInput.create(
                setup.name[0] + tool + suffix,
                absolutePath,
                folder_path,
                adsk.cam.PostOutputUnitOptions.MillimetersOutput,
            )
            postProcessInput.isOpenInEditor = False
            _post_process_with_retry(app, cam, toolpath, postProcessInput)
