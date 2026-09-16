#!/usr/bin/env python3
"""Authenticated Qwen3-VL-30B-A3B-Instruct BF16 service for DGX Spark."""
from __future__ import annotations

import asyncio
import base64
import hmac
import io
import math
import os
import time
from contextlib import asynccontextmanager

import torch
from fastapi import Depends, FastAPI, Header, HTTPException
from PIL import Image
from pydantic import BaseModel, Field
from transformers import AutoProcessor, Qwen3VLMoeForConditionalGeneration

from qwen_contract import SYSTEM_PROMPT, TASK_PROMPT, normalize_result, parse_json_response

MODEL_NAME = os.environ.get("VISION_QWEN_MODEL", "Qwen/Qwen3-VL-30B-A3B-Instruct")
MODEL_REVISION = os.environ.get("VISION_QWEN_REVISION", "9c4b90e1e4ba969fd3b5378b57d966d725f1b86c")
TOKEN = os.environ.get("VISION_QWEN_TOKEN", "")
ATTENTION = os.environ.get("VISION_QWEN_ATTENTION", "sdpa")
DEVICE_MAP = os.environ.get("VISION_QWEN_DEVICE_MAP", "cuda")
MAX_IMAGES = int(os.environ.get("VISION_QWEN_MAX_IMAGES", "8"))
MAX_IMAGE_PIXELS = int(os.environ.get("VISION_QWEN_MAX_IMAGE_PIXELS", str(1280 * 720)))
MAX_JPEG_BYTES = int(os.environ.get("VISION_QWEN_MAX_JPEG_BYTES", str(2 * 1024 * 1024)))
MAX_NEW_TOKENS = int(os.environ.get("VISION_QWEN_MAX_NEW_TOKENS", "900"))

state = {
    "model": None, "processor": None, "loaded_at": None,
    "requests": 0, "failures": 0, "last_latency_ms": None,
}
inference_lock = asyncio.Lock()


class FrameInput(BaseModel):
    timestamp_ms: int = Field(ge=0)
    jpeg_base64: str


class AnalyzeRequest(BaseModel):
    match_key: str | None = None
    view_id: str
    view_label: str | None = None
    clip_start_ms: int = Field(ge=0)
    clip_end_ms: int = Field(gt=0)
    frames: list[FrameInput]


def decode_frame(frame: FrameInput):
    try:
        if len(frame.jpeg_base64) > (MAX_JPEG_BYTES * 4 // 3) + 16:
            raise ValueError("encoded frame exceeds byte limit")
        decoded = base64.b64decode(frame.jpeg_base64, validate=True)
        if len(decoded) > MAX_JPEG_BYTES:
            raise ValueError("decoded frame exceeds byte limit")
        image = Image.open(io.BytesIO(decoded)).convert("RGB")
    except Exception as error:
        raise HTTPException(status_code=400, detail=f"Invalid JPEG frame: {error}") from error
    if image.width * image.height > MAX_IMAGE_PIXELS:
        scale = math.sqrt(MAX_IMAGE_PIXELS / (image.width * image.height))
        image = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.Resampling.LANCZOS)
    return image


def model_health():
    cuda = {"available": torch.cuda.is_available()}
    if torch.cuda.is_available():
        try:
            free, total = torch.cuda.mem_get_info()
            cuda.update({"free_bytes": free, "total_bytes": total})
        except RuntimeError:
            cuda["memory_reporting"] = "unavailable"
    return {
        "ready": state["model"] is not None,
        "model": MODEL_NAME, "revision": MODEL_REVISION, "dtype": "bfloat16",
        "attention": ATTENTION, "loaded_at": state["loaded_at"],
        "requests": state["requests"], "failures": state["failures"],
        "last_latency_ms": state["last_latency_ms"], "cuda": cuda,
    }


def verify_token(authorization: str | None = Header(default=None)):
    supplied = authorization.removeprefix("Bearer ") if authorization else ""
    if not TOKEN or not hmac.compare_digest(supplied, TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized")


@asynccontextmanager
async def lifespan(_app):
    if not torch.cuda.is_available():
        raise RuntimeError("Qwen service requires CUDA on the DGX Spark")
    options = {
        "dtype": torch.bfloat16,
        "device_map": DEVICE_MAP,
        "attn_implementation": ATTENTION,
        "low_cpu_mem_usage": True,
    }
    if MODEL_REVISION:
        options["revision"] = MODEL_REVISION
    state["model"] = Qwen3VLMoeForConditionalGeneration.from_pretrained(MODEL_NAME, **options).eval()
    state["processor"] = AutoProcessor.from_pretrained(MODEL_NAME, revision=MODEL_REVISION)
    state["loaded_at"] = time.time()
    yield
    state["model"] = None
    state["processor"] = None


app = FastAPI(title="Spartans Vision Qwen", lifespan=lifespan)


@app.get("/health")
def health():
    return model_health()


@app.post("/analyze", dependencies=[Depends(verify_token)])
async def analyze(payload: AnalyzeRequest):
    if payload.clip_end_ms <= payload.clip_start_ms:
        raise HTTPException(status_code=400, detail="clip_end_ms must exceed clip_start_ms")
    if not 2 <= len(payload.frames) <= MAX_IMAGES:
        raise HTTPException(status_code=400, detail=f"frames must contain 2..{MAX_IMAGES} images")
    images = [decode_frame(frame) for frame in payload.frames]
    content = []
    for frame, image in zip(payload.frames, images):
        content.extend([
            {"type": "text", "text": f"Frame timestamp_ms={frame.timestamp_ms}"},
            {"type": "image", "image": image},
        ])
    content.append({"type": "text", "text": TASK_PROMPT})
    messages = [
        {"role": "system", "content": [{"type": "text", "text": SYSTEM_PROMPT}]},
        {"role": "user", "content": content},
    ]
    started = time.perf_counter()
    async with inference_lock:
        try:
            inputs = state["processor"].apply_chat_template(
                messages, tokenize=True, add_generation_prompt=True,
                return_dict=True, return_tensors="pt", enable_thinking=False,
            ).to(state["model"].device)
            with torch.inference_mode():
                generated = state["model"].generate(
                    **inputs, max_new_tokens=MAX_NEW_TOKENS, do_sample=False,
                )
            trimmed = generated[:, inputs["input_ids"].shape[-1]:]
            raw = state["processor"].batch_decode(
                trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False,
            )[0]
            parsed, error = parse_json_response(raw)
            result = None
            if not error:
                result, error = normalize_result(parsed, payload.clip_start_ms, payload.clip_end_ms)
            if error:
                raise HTTPException(status_code=422, detail={"error": error, "raw_response": raw})
            state["requests"] += 1
            state["last_latency_ms"] = round((time.perf_counter() - started) * 1000)
            return {
                "model": MODEL_NAME, "revision": MODEL_REVISION, "dtype": "bfloat16",
                "latency_ms": state["last_latency_ms"], "result": result,
                "raw_response": raw,
            }
        except HTTPException:
            state["failures"] += 1
            raise
        except Exception as error:
            state["failures"] += 1
            raise HTTPException(status_code=500, detail=str(error)) from error
