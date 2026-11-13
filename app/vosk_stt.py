"""Speech recognition via Vosk (Kaldi) — works well for Ukrainian."""

from __future__ import annotations

import json
import shutil
import subprocess
import threading
import urllib.request
import zipfile
from pathlib import Path
from typing import Callable

from vosk import KaldiRecognizer, Model, SetLogLevel

SetLogLevel(-1)

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"
BASE_URL = "https://alphacephei.com/vosk/models/"

MODELS = {
    "uk": "vosk-model-uk-v3",
    "uk-small": "vosk-model-small-uk-v3-small",
}

SAMPLE_RATE = 16000

_models: dict[str, Model] = {}
_lock = threading.Lock()


def _download(name: str, on_progress: Callable[[float, str], None] | None) -> Path:
    target = MODELS_DIR / name
    if target.exists():
        return target
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    zip_path = MODELS_DIR / f"{name}.zip.part"
    with urllib.request.urlopen(BASE_URL + f"{name}.zip") as resp, zip_path.open("wb") as f:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while chunk := resp.read(1 << 20):
            f.write(chunk)
            done += len(chunk)
            if on_progress and total:
                on_progress(done / total * 0.99, f"Downloading Vosk model ({done >> 20} of {total >> 20} MB)…")
    if on_progress:
        on_progress(0.99, "Unpacking model…")
    tmp_dir = MODELS_DIR / f"{name}.tmp"
    shutil.rmtree(tmp_dir, ignore_errors=True)
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(tmp_dir)
    # The archive contains a single folder named after the model
    inner = next(tmp_dir.iterdir())
    inner.rename(target)
    shutil.rmtree(tmp_dir, ignore_errors=True)
    zip_path.unlink()
    return target


def get_model(key: str, on_progress=None) -> Model:
    if key not in MODELS:
        raise ValueError(f"Unknown Vosk model: {key}")
    with _lock:
        if key not in _models:
            path = _download(MODELS[key], on_progress)
            if on_progress:
                on_progress(0.0, "Loading model…")
            _models[key] = Model(str(path))
        return _models[key]


def transcribe(path: str, model_key: str = "uk", on_progress: Callable[[float, str], None] | None = None) -> dict:
    model = get_model(model_key, on_progress)
    rec = KaldiRecognizer(model, SAMPLE_RATE)
    rec.SetWords(True)

    dur = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
        capture_output=True, text=True,
    ).stdout.strip()
    duration = float(dur) if dur and dur != "N/A" else 0.0
    total_bytes = duration * SAMPLE_RATE * 2 or 1

    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "-"],
        stdout=subprocess.PIPE,
    )
    words: list[dict] = []

    def collect(res: str) -> None:
        for w in json.loads(res).get("result", []):
            words.append({"text": w["word"], "start": round(w["start"], 3), "end": round(w["end"], 3)})

    read = 0
    if on_progress:
        on_progress(0.0, "Transcribing speech…")
    while chunk := proc.stdout.read(8000):
        read += len(chunk)
        if rec.AcceptWaveform(chunk):
            collect(rec.Result())
            if on_progress:
                on_progress(min(0.99, read / total_bytes), "Transcribing speech…")
    collect(rec.FinalResult())
    proc.wait()

    return {"language": "uk", "duration": duration, "words": words}
