import asyncio
import os
import time
import traceback
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from TTS.api import TTS


MODEL_NAME = os.environ.get("XTTS_MODEL", "tts_models/multilingual/multi-dataset/xtts_v2")
REQUESTED_DEVICE = os.environ.get("XTTS_DEVICE", "auto").lower()

model: Any | None = None
device = "cpu"
load_ms: int | None = None
load_error: str | None = None
synthesis_lock = asyncio.Lock()


class SynthesizeRequest(BaseModel):
    text: str = Field(min_length=1)
    language: str = Field(min_length=1)
    speaker_wav: str = Field(min_length=1)
    output_path: str = Field(min_length=1)
    split_sentences: bool = True


@asynccontextmanager
async def lifespan(_app: FastAPI):
    load_model()
    yield


app = FastAPI(title="XTTS Worker", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health():
    return {
        "ok": model is not None and load_error is None,
        "ready": model is not None and load_error is None,
        "model": MODEL_NAME,
        "device": device,
        "load_ms": load_ms,
        "error": load_error,
    }


@app.post("/synthesize")
async def synthesize(request: SynthesizeRequest):
    if model is None:
        raise HTTPException(status_code=503, detail=load_error or "XTTS model is not ready.")

    speaker_wav = Path(request.speaker_wav).expanduser().resolve()
    output_path = Path(request.output_path).expanduser().resolve()
    if not speaker_wav.exists():
        raise HTTPException(status_code=400, detail=f"speaker_wav does not exist: {speaker_wav}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    try:
        async with synthesis_lock:
            await asyncio.to_thread(run_synthesis, request, speaker_wav, output_path)
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"{exc}\n{traceback.format_exc()}",
        ) from exc

    return {
        "ok": True,
        "output_path": str(output_path),
        "duration_ms": round((time.perf_counter() - started) * 1000),
        "device": device,
        "model": MODEL_NAME,
    }


def run_synthesis(request: SynthesizeRequest, speaker_wav: Path, output_path: Path):
    assert model is not None
    model.tts_to_file(
        text=request.text,
        speaker_wav=str(speaker_wav),
        language=request.language,
        file_path=str(output_path),
        split_sentences=request.split_sentences,
    )


def load_model():
    global model, device, load_ms, load_error
    started = time.perf_counter()
    device = resolve_device()
    try:
        model = TTS(MODEL_NAME).to(device)
        load_error = None
    except Exception:
        if REQUESTED_DEVICE == "auto" and device != "cpu":
            device = "cpu"
            model = TTS(MODEL_NAME).to(device)
            load_error = None
        else:
            load_error = traceback.format_exc()
            raise
    finally:
        load_ms = round((time.perf_counter() - started) * 1000)


def resolve_device():
    if REQUESTED_DEVICE in {"cuda", "mps", "cpu"}:
        return REQUESTED_DEVICE
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


if __name__ == "__main__":
    uvicorn.run(
        app,
        host=os.environ.get("XTTS_WORKER_HOST", "127.0.0.1"),
        port=int(os.environ.get("XTTS_WORKER_PORT", "8765")),
        log_level=os.environ.get("XTTS_WORKER_LOG_LEVEL", "info"),
    )
