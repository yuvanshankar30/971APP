#!/usr/bin/env python3
"""Create a private ffprobe inventory for downloaded vision recordings."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path


VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}


def rate_to_float(raw: str | None) -> float:
    if not raw:
        return 0.0
    numerator, separator, denominator = raw.partition("/")
    try:
        return float(numerator) / float(denominator) if separator else float(numerator)
    except (ValueError, ZeroDivisionError):
        return 0.0


def inspect(path: Path) -> dict:
    result = subprocess.run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,avg_frame_rate,codec_name,nb_frames:format=duration",
        "-of", "json", str(path),
    ], check=True, capture_output=True, text=True)
    payload = json.loads(result.stdout)
    stream = (payload.get("streams") or [{}])[0]
    fps = rate_to_float(stream.get("avg_frame_rate"))
    height = int(stream.get("height") or 0)
    return {
        "path": str(path),
        "bytes": path.stat().st_size,
        "codec": stream.get("codec_name"),
        "width": int(stream.get("width") or 0),
        "height": height,
        "fps": round(fps, 3),
        "duration_seconds": round(float((payload.get("format") or {}).get("duration") or 0), 3),
        "preferred_1080p_30_60fps": height == 1080 and 30 <= fps <= 60.1,
        "accepted_for_label_review": height > 0 and fps > 0,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", help="Private recording corpus directory")
    parser.add_argument("--output", help="Defaults to ROOT/inventory.json")
    args = parser.parse_args()
    os.umask(0o077)
    root = Path(args.root).expanduser().resolve()
    videos = sorted(path for path in root.rglob("*") if path.is_file() and path.suffix.lower() in VIDEO_SUFFIXES)
    rows = []
    for video in videos:
        try:
            rows.append(inspect(video))
        except (subprocess.CalledProcessError, json.JSONDecodeError) as error:
            rows.append({"path": str(video), "error": str(error), "accepted_for_label_review": False})
    output = Path(args.output).expanduser().resolve() if args.output else root / "inventory.json"
    output.write_text(json.dumps({
        "created_at": datetime.now(timezone.utc).isoformat(),
        "recording_count": len(rows),
        "preferred_count": sum(row.get("preferred_1080p_30_60fps", False) for row in rows),
        "recordings": rows,
    }, indent=2) + "\n", encoding="utf-8")
    output.chmod(0o600)
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
