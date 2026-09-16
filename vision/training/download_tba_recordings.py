#!/usr/bin/env python3
"""Build a private TBA/YouTube training corpus without exposing a web service."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen


TBA_EVENT_RE = re.compile(r"^20\d{2}[a-z0-9]+$", re.I)
MATCH_KEY_RE = re.compile(r"^20\d{2}[a-z0-9]+_(?:qm\d+|[a-z]+\d+m\d+)$", re.I)
YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,20}$")
DEFAULT_PROXY = "https://spartanshub.spartanrobotics.org/api/tba/event-matches"
FORMAT_SELECTOR = (
    "bestvideo[height<=1080][fps>=30][fps<=60][ext=mp4]/"
    "bestvideo[height<=1080][fps>=30][fps<=60]/"
    "best[height<=1080][fps>=30][fps<=60]/"
    "bestvideo[height<=1080][fps<=60]/best[height<=1080][fps<=60]/bestvideo/best"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Discover TBA YouTube recordings and optionally download private vision-only copies"
    )
    parser.add_argument("event_keys", nargs="+", help="TBA event keys, such as 2022cc")
    parser.add_argument("--output", required=True, help="Private dataset directory")
    parser.add_argument("--matches", help="Comma-separated exact match keys to include")
    parser.add_argument("--limit", type=int, default=0, help="Maximum matches per event (0 = all)")
    parser.add_argument("--download", action="store_true", help="Download videos with yt-dlp")
    parser.add_argument("--clip-seconds", type=int, default=210,
                        help="Length to download when a TBA video includes a start offset; 0 downloads the rest")
    parser.add_argument("--proxy", default=DEFAULT_PROXY,
                        help="HTTPS TBA metadata proxy used when TBA_API_KEY is unset")
    parser.add_argument("--yt-dlp", help="Optional yt-dlp executable; defaults to the current Python environment")
    args = parser.parse_args()
    if args.limit < 0 or args.clip_seconds < 0:
        parser.error("--limit and --clip-seconds cannot be negative")
    for key in args.event_keys:
        if not TBA_EVENT_RE.fullmatch(key):
            parser.error(f"invalid TBA event key: {key}")
    return args


def fetch_json(url: str, headers: dict[str, str] | None = None) -> object:
    request = Request(url, headers=headers or {"User-Agent": "spartanshub-private-vision-dataset/1"})
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def fetch_event_matches(event_key: str, proxy: str) -> tuple[list[dict], str]:
    token = os.getenv("TBA_API_KEY", "").strip()
    if token:
        url = f"https://www.thebluealliance.com/api/v3/event/{event_key}/matches"
        payload = fetch_json(url, {"X-TBA-Auth-Key": token, "User-Agent": "spartanshub-private-vision-dataset/1"})
        return list(payload or []), "tba-v3"
    parsed = urlparse(proxy)
    if parsed.scheme != "https" or parsed.hostname != "spartanshub.spartanrobotics.org":
        raise SystemExit("--proxy must be the HTTPS SpartansHub TBA proxy")
    separator = "&" if "?" in proxy else "?"
    payload = fetch_json(f"{proxy}{separator}event_key={event_key}&comp_level=all")
    if not isinstance(payload, dict) or not payload.get("success"):
        raise SystemExit(f"TBA proxy failed for {event_key}: {payload}")
    return list(payload.get("data") or []), "spartanshub-tba-proxy"


def parse_youtube_reference(raw_key: str) -> tuple[str, int]:
    raw = str(raw_key or "").strip()
    if "://" in raw:
        parsed = urlparse(raw)
        query = parse_qs(parsed.query)
        video_id = query.get("v", [parsed.path.rsplit("/", 1)[-1]])[0]
    else:
        video_id, _, raw_query = raw.partition("?")
        query = parse_qs(raw_query)
    if not YOUTUBE_ID_RE.fullmatch(video_id):
        raise ValueError(f"invalid YouTube video id: {raw_key!r}")
    start_raw = query.get("t", query.get("start", ["0"]))[0]
    match = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?", str(start_raw))
    if match:
        hours, minutes, seconds = (int(part or 0) for part in match.groups())
        start_seconds = hours * 3600 + minutes * 60 + seconds
    else:
        start_seconds = 0
    return video_id, start_seconds


def youtube_rows(match: dict) -> list[dict]:
    rows = []
    for video in match.get("videos") or []:
        if video.get("type") != "youtube":
            continue
        try:
            video_id, start_seconds = parse_youtube_reference(video.get("key", ""))
        except ValueError:
            continue
        rows.append({
            "video_id": video_id,
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "start_seconds": start_seconds,
        })
    return rows


def compact_match(match: dict) -> dict:
    return {
        "key": match.get("key"),
        "comp_level": match.get("comp_level"),
        "set_number": match.get("set_number"),
        "match_number": match.get("match_number"),
        "actual_time": match.get("actual_time"),
        "winning_alliance": match.get("winning_alliance"),
        "alliances": match.get("alliances"),
        "score_breakdown": match.get("score_breakdown"),
        "youtube": youtube_rows(match),
    }


def run_download(row: dict, output: Path, yt_dlp: str | None, clip_seconds: int) -> None:
    youtube = row["youtube"][0]
    match_dir = output / row["key"]
    match_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    match_dir.chmod(0o700)
    template = str(match_dir / f"{row['key']}__%(id)s__%(height)sp_%(fps)sfps.%(ext)s")
    command = ([yt_dlp] if yt_dlp else [sys.executable, "-m", "yt_dlp"]) + [
        "--no-playlist", "--no-overwrites", "--restrict-filenames",
        "--write-info-json", "--format", FORMAT_SELECTOR, "--output", template,
    ]
    start = int(youtube.get("start_seconds") or 0)
    if start and clip_seconds:
        # Avoid --force-keyframes-at-cuts: it re-encodes an otherwise useful
        # 1080p60 source on CPU. Frame extraction does not require exact cuts.
        command.extend(["--download-sections", f"*{start}-{start + clip_seconds}"])
    command.append(youtube["url"])
    subprocess.run(command, check=True)


def main() -> int:
    args = parse_args()
    os.umask(0o077)
    output = Path(args.output).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    output.chmod(0o700)
    requested = {key.strip() for key in (args.matches or "").split(",") if key.strip()}
    if any(not MATCH_KEY_RE.fullmatch(key) for key in requested):
        raise SystemExit("--matches contains an invalid match key")

    manifest = {
        "format_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "privacy": {
            "public_listener": False,
            "storage": "local-private",
            "purpose": "review-required detector training and evaluation",
        },
        "target_video": {"preferred_height": 1080, "accepted_height": "any", "fps_min": 30, "fps_max": 60},
        "events": [],
    }
    selected_rows = []
    for event_key in args.event_keys:
        matches, metadata_source = fetch_event_matches(event_key, args.proxy)
        rows = [compact_match(match) for match in matches]
        rows = [row for row in rows if row["youtube"] and (not requested or row["key"] in requested)]
        if args.limit:
            rows = rows[:args.limit]
        manifest["events"].append({"event_key": event_key, "metadata_source": metadata_source, "matches": rows})
        selected_rows.extend(rows)

    manifest_path = output / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    manifest_path.chmod(0o600)
    print(f"Wrote {manifest_path} with {len(selected_rows)} recording references")
    failures = []
    if args.download:
        for index, row in enumerate(selected_rows, 1):
            print(f"[{index}/{len(selected_rows)}] {row['key']}", flush=True)
            try:
                run_download(row, output, args.yt_dlp, args.clip_seconds)
            except subprocess.CalledProcessError as error:
                failures.append({"match_key": row["key"], "exit_code": error.returncode})
                print(f"Download failed for {row['key']} (exit {error.returncode}); continuing", file=sys.stderr)
    if failures:
        failure_path = output / "download-errors.json"
        failure_path.write_text(json.dumps(failures, indent=2) + "\n", encoding="utf-8")
        failure_path.chmod(0o600)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
