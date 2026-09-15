#!/usr/bin/env python3
"""Read-only readiness check for a vision runner host.

The command never prints secret values and never claims or mutates a run.
"""

import argparse
import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def reachable(url: str, timeout: float = 5.0) -> tuple[bool, str]:
    try:
        with urlopen(Request(url, method="GET"), timeout=timeout) as response:
            return True, f"HTTP {response.status}"
    except HTTPError as error:
        # A 401/403/405 still proves DNS, TLS and the service are reachable.
        return error.code in {401, 403, 405}, f"HTTP {error.code}"
    except (URLError, TimeoutError, ValueError) as error:
        return False, str(error.reason if isinstance(error, URLError) else error)


def collect(args: argparse.Namespace) -> list[dict]:
    api_url = args.api_url or os.getenv("VISION_API_URL", "")
    model_path = args.model_path or os.getenv("VISION_MODEL_PATH", "")
    qwen_url = args.qwen_url or os.getenv("VISION_QWEN_URL", "")
    checks = [
        {"name": "VISION_API_URL", "ok": bool(api_url), "detail": api_url or "missing"},
        {"name": "VISION_RUNNER_TOKEN", "ok": bool(os.getenv("VISION_RUNNER_TOKEN")), "detail": "set" if os.getenv("VISION_RUNNER_TOKEN") else "missing"},
        {"name": "model weights", "ok": bool(model_path and Path(model_path).is_file()), "detail": model_path or "missing VISION_MODEL_PATH"},
        {"name": "Qwen URL", "ok": bool(qwen_url), "detail": qwen_url or "missing"},
    ]
    if model_path and Path(model_path).is_file():
        size = Path(model_path).stat().st_size
        checks.append({"name": "model is not placeholder-sized", "ok": size >= 1_000_000, "detail": f"{size / 1_000_000:.1f} MB"})
    if not args.skip_network and api_url:
        ok, detail = reachable(api_url.rstrip("/"))
        checks.append({"name": "web API reachable", "ok": ok, "detail": detail})
    if not args.skip_network and qwen_url:
        ok, detail = reachable(f"{qwen_url.rstrip('/')}/health")
        checks.append({"name": "Qwen health reachable", "ok": ok, "detail": detail})
    return checks


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only vision runner preflight")
    parser.add_argument("--api-url")
    parser.add_argument("--model-path")
    parser.add_argument("--qwen-url")
    parser.add_argument("--skip-network", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    checks = collect(args)
    if args.json:
        print(json.dumps({"ok": all(check["ok"] for check in checks), "checks": checks}, indent=2))
    else:
        for check in checks:
            print(f"{'PASS' if check['ok'] else 'FAIL'}  {check['name']}: {check['detail']}")
    return 0 if all(check["ok"] for check in checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
