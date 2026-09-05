import json
from typing import Optional

import adsk.core
import sys

from ..config import BASE_URL, OVERRIDE_PATH, RUNNER_ID
sys.path.append(OVERRIDE_PATH)
import requests


def _log(message: str) -> None:
    """Write a message to the Fusion log window if available."""
    try:
        app = adsk.core.Application.get()
        if app:
            app.log(message)
    except Exception:
        pass


def send_job_error(session: requests.Session, job_id: str, error_message: str) -> None:
    """Notify the API that the job has failed.

    Posts to Spartans Hub's own /api/fusion-runner (action=fail) - plain
    JSON, not the original AutoCAM WebUI's multipart /api/jobs/complete.
    job_id is required here (unlike upstream, which could infer "the job
    this session currently has claimed" server-side via its own
    one-active-job-per-API-key uniqueness constraint) - this app's cam_jobs
    doesn't have that same constraint, so every call site must pass it
    explicitly, same as cam-generate/+server.js's own jobId-required pattern.
    """
    _log('Failure Occurred: ' + error_message)
    message = (error_message or "").strip() or "Unknown job failure"
    try:
        session.post(
            f"{BASE_URL}/api/fusion-runner",
            params={"action": "fail"},
            json={"jobId": job_id, "runnerId": RUNNER_ID, "error": message[:2000]},
            timeout=30,
        )
    except Exception as exc:
        _log(f"Failed to send job error: {exc}")


def ensure_completion_response(
    session: requests.Session, response: Optional[requests.Response], job_id: str, context: str
) -> None:
    """Send an error request when the completion response is missing or not successful."""
    if response is None:
        send_job_error(session, job_id, f"{context} (no response received)")
        return

    if response.ok:
        return

    try:
        detail = response.text.strip()
    except Exception:
        detail = ""

    message = f"{context} failed with status {response.status_code} {response.reason}"
    if detail:
        message = f"{message}: {detail}"
    send_job_error(session, job_id, message)
