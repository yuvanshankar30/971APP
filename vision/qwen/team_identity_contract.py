"""Strict contract for private, roster-constrained team-number reads."""
from __future__ import annotations

import json
import re


TEAM_KEY = re.compile(r"^frc(\d{1,5})$", re.I)

SYSTEM_PROMPT = """You read FRC team numbers from robot crops for a private
scouting system. A crop can be blurry, obstructed, or show a referee. Never
guess a number. Return only JSON matching the requested shape."""

TASK_PROMPT = """Each image is a crop from one robot track. Read the bumper
team number only when it is plainly visible. The only permitted answers are
the candidate team numbers supplied for that crop, or null. Return exactly:
{"reads":[{"crop_id":"input crop id","team_key":"frc####|null",
"confidence":0.0,"evidence":"brief visible text or why unreadable"}]}.
Use confidence 0 when the number is unreadable; do not infer from alliance,
robot appearance, or another image."""


def normalize_team_key(value: object) -> str | None:
    text = str(value or "").strip().lower()
    if text.isdigit():
        text = f"frc{text}"
    match = TEAM_KEY.fullmatch(text)
    return f"frc{match.group(1)}" if match else None


def parse_json_response(text: str):
    stripped = re.sub(r"^```(?:json)?\s*|\s*```$", "", str(text or "").strip(), flags=re.I | re.S)
    try:
        return json.loads(stripped), None
    except json.JSONDecodeError as error:
        match = re.search(r"\{.*\}", stripped, flags=re.S)
        if match:
            try:
                return json.loads(match.group()), None
            except json.JSONDecodeError:
                pass
        return None, f"Invalid model JSON: {error}"


def normalize_reads(parsed: object, permitted: dict[str, set[str]]):
    if not isinstance(parsed, dict) or not isinstance(parsed.get("reads"), list):
        return None, "Response lacks a reads array"
    output = []
    seen = set()
    for item in parsed["reads"]:
        if not isinstance(item, dict):
            continue
        crop_id = str(item.get("crop_id") or "")
        if crop_id not in permitted or crop_id in seen:
            continue
        team_key = normalize_team_key(item.get("team_key"))
        if team_key not in permitted[crop_id]:
            team_key = None
        try:
            confidence = max(0.0, min(1.0, float(item.get("confidence", 0))))
        except (TypeError, ValueError):
            confidence = 0.0
        if team_key is None:
            confidence = 0.0
        output.append({
            "crop_id": crop_id,
            "team_key": team_key,
            "confidence": confidence,
            "evidence": str(item.get("evidence") or "")[:300],
        })
        seen.add(crop_id)
    return output, None
