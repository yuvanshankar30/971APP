"""Shared, testable wrapper around Fusion's CAM machining-time API."""

import math
from typing import Callable, Optional


FEED_SCALE_PERCENT = 100
RAPID_FEED_CM_PER_SEC = 50.0  # 30,000 mm/min, matching the shop routers.
TOOL_CHANGE_SECONDS = 15.0  # Estimate until the shop supplies a measurement.


def total_machining_time(
    cam,
    create_object_collection: Callable,
    *,
    rapid_feed_cm_per_sec: float = RAPID_FEED_CM_PER_SEC,
    tool_change_seconds: float = TOOL_CHANGE_SECONDS,
) -> Optional[float]:
    """Return seconds for valid, unsuppressed operations, or ``None``.

    Fusion exposes this through ``CAM.getMachiningTime``. Operations do not
    expose the speculative ``machiningTime``/``cycleTime`` attributes that the
    old tube workflow probed, so both plate and tube jobs must use this API.
    """
    operations = create_object_collection()
    for setup in cam.setups:
        for operation in setup.operations:
            if getattr(operation, "isSuppressed", False):
                continue
            if hasattr(operation, "isToolpathValid") and not operation.isToolpathValid:
                continue
            operations.add(operation)

    if operations.count == 0:
        return None

    try:
        result = cam.getMachiningTime(
            operations,
            FEED_SCALE_PERCENT,
            rapid_feed_cm_per_sec,
            tool_change_seconds,
        )
        machining_time = float(result.machiningTime)
    except (AttributeError, TypeError, ValueError, RuntimeError):
        return None

    # Real, confirmed live bug: Fusion's own estimate can come back inf/nan
    # for certain operations (e.g. one with an effectively-zero feed rate)
    # without raising - the caller then serializes this straight into the
    # job's completion payload. Python's json module writes those as the
    # bare tokens NaN/Infinity, which is valid for it but not for strict
    # JSON - the server's request.json() (JSON.parse()) rejects the whole
    # body with "Invalid JSON body", failing a job that otherwise posted
    # correctly. Same convention as every other failure to get a usable
    # estimate: return None rather than a value that isn't trustworthy.
    return machining_time if math.isfinite(machining_time) else None
