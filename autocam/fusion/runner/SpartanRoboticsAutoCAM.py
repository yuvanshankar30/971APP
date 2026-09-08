import adsk.core, adsk.fusion, adsk.cam, traceback
import json
import os
import queue
import re
import sys
import threading
import time
from typing import List, Optional
# Bootstrap the external requests dependency before workflow imports. Those
# modules import requests at module load time, so doing this after them makes
# a valid .overridepath ineffective and causes the add-in to stop instantly.
from .config import *
from .workflows import importPlate as importPlate
from .workflows import camPlate as camPlate
from .workflows import camTube as camTube
from .workflows import setupTemp as setupTemp
from .workflows.dropFolder import _is_offline_settings_error, list_data_folder_tree
from .workflows.job_status import send_job_error
from .RunnerUpdate import check_and_stage_update
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

_ADDIN_DIR = os.path.dirname(os.path.realpath(__file__))
_ENV_PATH = os.path.join(_ADDIN_DIR, ".env")
_API_KEY_LINE_RE = re.compile(r"^\s*API_KEY\s*=\s*(?P<value>.*)\s*$")


_app = adsk.core.Application.cast(None)
_ui = adsk.core.UserInterface.cast(None)
_server_thread = None  # type: Optional[threading.Thread]
_stop_event = None  # type: Optional[threading.Event]
session = None  # type: Optional[requests.Session]
_custom_event = None  # type: Optional[adsk.core.CustomEvent]
_handlers = []  # type: List[adsk.core.EventHandler]
_job_queue = queue.Queue()  # type: queue.Queue
_log_queue = queue.Queue()  # type: queue.Queue
_job_processing = threading.Event()
_active_job_id = None  # type: Optional[str]
# Set from the background poll thread (handleServer), consumed on the main
# thread (_JobQueueEventHandler.notify) - the actual Fusion Data Panel walk
# has to run there, same as every other Fusion API call in this add-in.
# Fusion's API is documented as unsafe to call off the main UI thread; the
# background thread only ever signals "please sync" and fires the existing
# custom event, it never touches app.data itself.
_folder_sync_requested = threading.Event()

_JOB_QUEUE_EVENT_ID = f"{ADDIN_NAME}_job_queue_event"


def _configure_http_retries(http_session: requests.Session) -> None:
    """Retry transient resets from the Runner API without duplicating jobs.

    Claim/heartbeat/status endpoints are idempotent at the API level through
    their job and runner IDs. A reset before Fusion receives an HTTP response
    should therefore retry a few times instead of printing a full traceback
    and leaving the poll loop idle until its next cycle.
    """
    retry_options = dict(
        total=3, connect=3, read=3, status=3, backoff_factor=0.5,
        status_forcelist=(429, 500, 502, 503, 504), raise_on_status=False,
    )
    try:
        retry = Retry(allowed_methods=None, **retry_options)
    except TypeError:  # urllib3 bundled by an older Fusion requests install.
        retry = Retry(method_whitelist=False, **retry_options)
    adapter = HTTPAdapter(max_retries=retry)
    http_session.mount("https://", adapter)
    http_session.mount("http://", adapter)


def _drain_queue(q: "queue.Queue") -> None:
    while True:
        try:
            q.get_nowait()
        except queue.Empty:
            break
        try:
            q.task_done()
        except Exception:
            pass


def _queue_log(message: str) -> None:
    try:
        _log_queue.put_nowait(message)
        _fire_job_queue_event()
    except Exception:
        pass


def _fire_job_queue_event() -> None:
    try:
        if _app:
            _app.fireCustomEvent(_JOB_QUEUE_EVENT_ID, "")
    except Exception:
        pass


def _process_job(job: dict, session: requests.Session) -> None:
    # Fusion CAM's cam_jobs.params holds { fusionJobKind, plateId, boxTubeId }
    # (see src/lib/fusionCam.js's queueFusionJob) - a nested field, not the
    # original AutoCAM's top-level job.kind. Same three job kinds either way
    # (plate:cam / box_tube / plate:arrange), so the dispatch table below is
    # otherwise unchanged from upstream.
    params = job.get("params") or {}
    kind = params.get("fusionJobKind")
    _app.log(str(job))

    # A cancelled or rejected claim must not proceed to CAM work.
    response = session.post(
        f"{BASE_URL}/api/fusion-runner",
        params={"action": "processing"},
        json={"jobId": job.get("id"), "runnerId": RUNNER_ID},
        timeout=30,
    )
    response.raise_for_status()

    if kind == "plate:cam":
        camPlate.start(job, session)
    elif kind == "box_tube":
        camTube.start(job, session)
    elif kind == "plate:arrange":
        importPlate.start(job, session)
    else:
        raise ValueError(f"Unknown job type: {kind!r}")


class _JobQueueEventHandler(adsk.core.CustomEventHandler):
    def __init__(self, session: requests.Session):
        super().__init__()
        self.session = session

    def notify(self, args: "adsk.core.CustomEventArgs") -> None:
        global _active_job_id
        try:
            while True:
                try:
                    message = _log_queue.get_nowait()
                except queue.Empty:
                    break
                try:
                    if _app:
                        _app.log(str(message))
                finally:
                    _log_queue.task_done()

            if _job_processing.is_set():
                return

            while True:
                try:
                    job = _job_queue.get_nowait()
                except queue.Empty:
                    break

                _job_processing.set()
                _active_job_id = str(job.get("id") or "") or None
                try:
                    _process_job(job, session=self.session)
                except Exception:
                    detail = traceback.format_exc()
                    if _app:
                        _app.log("Error processing job:\n{}".format(detail))
                    if _active_job_id:
                        send_job_error(self.session, _active_job_id, detail)
                finally:
                    _active_job_id = None
                    _job_processing.clear()
                    _job_queue.task_done()

            if _folder_sync_requested.is_set():
                _folder_sync_requested.clear()
                _sync_data_folders()
        except Exception:
            if _app:
                _app.log(
                    "Error in job queue event handler:\n{}".format(
                        traceback.format_exc()
                    )
                )


def _mask_api_key(api_key: Optional[str]) -> str:
    if not api_key:
        return "<not set>"
    api_key = api_key.strip()
    if len(api_key) <= 8:
        return "*" * len(api_key)
    return f"{api_key[:4]}…{api_key[-4:]}"


def _read_api_key_from_env_file(env_path: str) -> Optional[str]:
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for raw_line in f:
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                match = _API_KEY_LINE_RE.match(line)
                if not match:
                    continue
                value = match.group("value").strip()
                if (value.startswith('"') and value.endswith('"')) or (
                    value.startswith("'") and value.endswith("'")
                ):
                    value = value[1:-1]
                value = value.strip()
                return value or None
    except FileNotFoundError:
        return None
    except Exception:
        return None


def _write_api_key_to_env_file(env_path: str, api_key: str) -> None:
    api_key = api_key.strip()
    safe_value = api_key.replace("\\", "\\\\").replace('"', '\\"')
    api_key_line = f'API_KEY="{safe_value}"\n'

    lines = []  # type: List[str]
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except FileNotFoundError:
        lines = []

    replaced = False
    new_lines = []  # type: List[str]
    for line in lines:
        if _API_KEY_LINE_RE.match(line):
            new_lines.append(api_key_line)
            replaced = True
        else:
            new_lines.append(line)

    if not replaced:
        if new_lines and not new_lines[-1].endswith("\n"):
            new_lines[-1] = new_lines[-1] + "\n"
        new_lines.append(api_key_line)

    with open(env_path, "w", encoding="utf-8") as f:
        f.writelines(new_lines)


def _prompt_for_api_key(
    ui: adsk.core.UserInterface, existing_key: Optional[str]
) -> Optional[str]:
    default_value = (existing_key or "").strip()
    while True:
        value, cancelled = ui.inputBox(
            "Enter your API key (stored locally in this add-in's .env file).",
            "API Key",
            default_value,
        )
        if cancelled:
            return None
        value = (value or "").strip()
        if value:
            return value
        ui.messageBox("API key cannot be empty.")


def _startup_key_gate(
    ui: adsk.core.UserInterface, api_key: Optional[str], timeout_s: int = 10
) -> Optional[str]:
    if not api_key:
        new_key = _prompt_for_api_key(ui, existing_key=None)
        if not new_key:
            return None
        _write_api_key_to_env_file(_ENV_PATH, new_key)
        os.environ["API_KEY"] = new_key
        return new_key

    # ``run`` is called while Fusion is still completing its own startup.
    # Opening a modal progress dialog and pumping ``adsk.doEvents`` here can
    # re-enter Fusion's initialization event loop and leave the application
    # permanently on its splash screen. A stored key needs no user action;
    # return it immediately. The missing-key path above remains interactive.
    os.environ["API_KEY"] = api_key
    return api_key


_FOLDER_SYNC_INTERVAL_SEC = 300.0
_HEARTBEAT_INTERVAL_SEC = 30.0
# Fusion may drop custom events while it is busy or has a modal open. A
# claimed job then remains in _job_queue with no main-thread handler ever
# starting it, which used to deadlock this Runner until the stale-claim sweep.
# Re-firing the event is idempotent: the handler returns while a job is active
# and drains a queued job exactly once when it is not.
_DISPATCH_RETRY_POLLS = 3
_dispatch_retry = [0]
_last_folder_sync = 0.0
_last_heartbeat = 0.0
_last_folder_tree_json = None  # type: Optional[str]


def _sync_data_folders():
    """Pushes a snapshot of the real Fusion Data Panel folder tree up to
    Supabase so the web UI's folder picker (queueing a plate job) has
    something to show - the web app itself has no live connection to
    Fusion's Data Panel, only a Runner does. Best-effort: failures are
    logged, not raised, so a sync hiccup never interrupts job claiming.
    """
    global _last_folder_tree_json
    try:
        tree = list_data_folder_tree(_app, FUSION_DATA_PROJECT_NAME, FUSION_DROP_FOLDER_PATH)
        serialized = json.dumps(tree, sort_keys=True, separators=(",", ":"))
        if serialized == _last_folder_tree_json:
            return
        response = session.post(
            f"{BASE_URL}/api/fusion-runner",
            params={"action": "sync-folders"},
            json={"runnerId": RUNNER_ID, "projectName": tree["project"], "tree": tree["root"]},
            timeout=30,
        )
        response.raise_for_status()
        _last_folder_tree_json = serialized
    except Exception as exc:  # noqa: BLE001 - best-effort by design, see docstring
        # Fusion's cloud connection not being up yet is the normal state for
        # the first several seconds after launch, and this sync runs again
        # every _FOLDER_SYNC_INTERVAL_SEC regardless - so it resolves itself
        # without anyone doing anything. Printing a full Python traceback for
        # it made every single Fusion launch look like the add-in had
        # crashed. One calm line instead; a genuine failure still gets the
        # full traceback, because that one is worth looking at.
        if _is_offline_settings_error(exc):
            _queue_log(
                "Folder sync skipped: Fusion's cloud connection isn't up yet. "
                "This is normal right after launch and retries automatically."
            )
        else:
            _queue_log(f"Folder sync failed:\n{traceback.format_exc()}")


def handleServer(temp_dir: str, stop_event: threading.Event):
    global _last_folder_sync, _last_heartbeat
    while not stop_event.is_set():
        try:
            time.sleep(5)
            if _job_processing.is_set():
                now = time.monotonic()
                # The main-thread handler may clear _active_job_id while this
                # poll thread is preparing a heartbeat. Snapshot it once so a
                # valid check cannot turn into an API request with jobId=null.
                active_job_id = _active_job_id
                if active_job_id and now - _last_heartbeat >= _HEARTBEAT_INTERVAL_SEC:
                    _last_heartbeat = now
                    # Use a one-shot request rather than sharing the Session
                    # object concurrently with Fusion's main UI thread.
                    response = requests.post(
                        f"{BASE_URL}/api/fusion-runner",
                        params={"action": "heartbeat"},
                        headers={"Authorization": session.headers.get("Authorization", "")},
                        json={"jobId": active_job_id, "runnerId": RUNNER_ID},
                        timeout=30,
                    )
                    if response.status_code == 409:
                        # The job already left claimed/processing (completed,
                        # failed, or reassigned) between this heartbeat being
                        # scheduled and it actually landing - the main thread's
                        # _JobQueueEventHandler.notify() already reported that
                        # outcome and clears _active_job_id right after
                        # _process_job returns. A stale heartbeat racing that
                        # is an expected, harmless timing gap, not a runner
                        # fault - log it calmly instead of a scary traceback
                        # under the generic handler below, which was
                        # confusing operators reading the log right after a
                        # real job failure that had already been reported
                        # correctly.
                        _queue_log(
                            f"Heartbeat for job {active_job_id} skipped: job is no "
                            "longer active (already completed, failed, or "
                            "reassigned)."
                        )
                    else:
                        response.raise_for_status()
                stop_event.wait(0.2)
                continue
            if not _job_queue.empty():
                _dispatch_retry[0] += 1
                if _dispatch_retry[0] >= _DISPATCH_RETRY_POLLS:
                    _dispatch_retry[0] = 0
                    _queue_log(
                        "Queued job has not started; re-firing Fusion's dispatch event "
                        "in case the original was dropped."
                    )
                stop_event.wait(0.2)
                continue
            _dispatch_retry[0] = 0
            if session is None:
                raise RuntimeError("HTTP session not initialized.")
            now = time.monotonic()
            if now - _last_folder_sync >= _FOLDER_SYNC_INTERVAL_SEC:
                _last_folder_sync = now
                _folder_sync_requested.set()
                _fire_job_queue_event()
            # Claim endpoint (src/routes/api/fusion-runner/+server.js,
            # action=claim) - a compare-and-swap on cam_jobs.status, not the
            # original /api/jobs/request. Returns HTTP 200 with
            # {"job": null} when nothing is queued (not a 204), and the
            # claimed row directly under "job" (not the top-level dict).
            response = session.post(
                f"{BASE_URL}/api/fusion-runner",
                params={"action": "claim"},
                json={"runnerId": RUNNER_ID, "machineId": RUNNER_MACHINE_ID},
                timeout=30,
            )
            if stop_event.is_set():
                break
            if not response.ok:
                _queue_log(f"Claim request failed: {response.status_code} {response.text}")
                stop_event.wait(2)
                continue
            body = response.json()
            data = body.get("job") if isinstance(body, dict) else None
            if data is None:
                stop_event.wait(0.5)
                continue
            if not isinstance(data, dict):
                raise TypeError(f"Unexpected job payload type: {type(data)}")

            if stop_event.is_set():
                break
            _job_queue.put(data)
            _fire_job_queue_event()
        except Exception:
            try:
                _queue_log(f"Error handling job:\n{traceback.format_exc()}")
            except Exception:
                pass
            try:
                stop_event.wait(1)
            except Exception:
                time.sleep(1)


def run(_context):
    ui = None
    fusion_app = None
    try:
        fusion_app = adsk.core.Application.get()
        ui = fusion_app.userInterface
        global _app, _ui, _server_thread, _stop_event, session, _custom_event, _handlers
        _app, _ui = fusion_app, ui

        api_key = _startup_key_gate(
            ui, _read_api_key_from_env_file(_ENV_PATH), timeout_s=1
        )
        if not api_key:
            ui.messageBox("Add-in not started (no API key set).")
            return

        if not RUNNER_MACHINE_ID:
            ui.messageBox("Add-in not started: RUNNER_MACHINE_ID is required. Run setup.py and choose this physical machine's cam_machines UUID.")
            return

        session = requests.Session()
        session.headers.update({"Authorization": f"Bearer {api_key}"})
        _configure_http_retries(session)

        try:
            updated_version = check_and_stage_update(session, BASE_URL, _ADDIN_DIR)
        except Exception as update_error:
            # An unavailable update service must never stop a working router
            # from processing queued jobs. Log the diagnostic and continue.
            fusion_app.log(f"Runner update check failed: {update_error}")
        else:
            if updated_version:
                message = (
                    f"Fusion AutoCAM Runner updated to {updated_version}. "
                    "Fully quit and reopen Fusion before running jobs."
                )
                fusion_app.log(message)
                ui.messageBox(message)
                return

        _job_processing.clear()
        _dispatch_retry[0] = 0
        _drain_queue(_job_queue)
        _drain_queue(_log_queue)

        try:
            _app.unregisterCustomEvent(_JOB_QUEUE_EVENT_ID)
        except Exception:
            pass

        _custom_event = _app.registerCustomEvent(_JOB_QUEUE_EVENT_ID)
        handler = _JobQueueEventHandler(session)
        _custom_event.add(handler)
        _handlers.append(handler)

        temp = setupTemp.setupTempDir()
        _stop_event = threading.Event()
        _server_thread = threading.Thread(
            target=handleServer,
            args=(temp, _stop_event),
            daemon=True,
        )
        _server_thread.start()

    except:
        if ui:
            ui.messageBox("Failed:\n{}".format(traceback.format_exc()))
            fusion_app.log("Failed:\n{}".format(traceback.format_exc()))


def stop(context):
    try:
        global _stop_event, _server_thread, _custom_event, _handlers, session
        if _stop_event:
            _stop_event.set()
        if _server_thread and _server_thread.is_alive():
            _server_thread.join(timeout=2)
        try:
            if _app:
                _app.unregisterCustomEvent(_JOB_QUEUE_EVENT_ID)
        except Exception:
            pass
        _custom_event = None
        _handlers = []
        if session:
            try:
                session.close()
            except Exception:
                pass
        session = None
        _job_processing.clear()
        _dispatch_retry[0] = 0
        _drain_queue(_job_queue)
        _drain_queue(_log_queue)
        _stop_event = None
        _server_thread = None

    except:
        if _ui:
            _ui.messageBox("Failed stop:\n{}".format(traceback.format_exc()))
            _app.log("Failed:\n{}".format(traceback.format_exc()))
