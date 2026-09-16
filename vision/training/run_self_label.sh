#!/usr/bin/env bash
set -euo pipefail

data_root="${1:-$HOME/vision-data}"
version="${2:-2026-self-label-v1}"
sample_fps="${SAMPLE_FPS:-0.2}"
start_seconds="${START_SECONDS:-80}"
model="${QWEN_MODEL:-qwen3-vl:32b-instruct}"
python_bin="${PYTHON_BIN:-$data_root/tools/.venv/bin/python}"
tools_dir="${TOOLS_DIR:-$data_root/tools}"

mapfile -d '' videos < <(find "$data_root/2026-corpus" -mindepth 2 -maxdepth 2 -type f -name '*.mp4' -print0 | sort -z)
if [[ "${#videos[@]}" -eq 0 ]]; then
  echo "No 2026 match recordings found under $data_root/2026-corpus" >&2
  exit 1
fi

robot_output="$data_root/qwen-pseudo-labels/${version}-robots"
fuel_output="$data_root/qwen-pseudo-labels/${version}-fuel"
dataset_output="$data_root/datasets/$version"

"$python_bin" "$tools_dir/bootstrap_qwen_yolo.py" "${videos[@]}" \
  --output "$robot_output" \
  --start-seconds "$start_seconds" \
  --sample-fps "$sample_fps" \
  --task robots \
  --ollama-model "$model"

"$python_bin" "$tools_dir/bootstrap_fuel_candidates.py" "${videos[@]}" \
  --output "$fuel_output" \
  --start-seconds "$start_seconds" \
  --sample-fps "$sample_fps" \
  --max-candidates 8 \
  --ollama-model "$model"

if [[ -e "$dataset_output" ]]; then
  echo "Merged dataset already exists: $dataset_output" >&2
  exit 1
fi

"$python_bin" "$tools_dir/merge_qwen_pseudo_labels.py" \
  "$robot_output/pseudo-label-manifest.json" \
  "$fuel_output/pseudo-label-manifest.json" \
  --output "$dataset_output"

echo "Completed private pseudo-label dataset: $dataset_output"
