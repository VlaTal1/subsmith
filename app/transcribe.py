"""Распознавание речи с пословными таймкодами через faster-whisper."""

from __future__ import annotations

import subprocess
import threading
from typing import Callable

import numpy as np
from faster_whisper import WhisperModel

MODELS = ["tiny", "base", "small", "medium", "large-v3-turbo"]

_models: dict[str, WhisperModel] = {}
_lock = threading.Lock()


def get_model(name: str) -> WhisperModel:
    if name not in MODELS:
        raise ValueError(f"Неизвестная модель: {name}")
    with _lock:
        if name not in _models:
            _models[name] = WhisperModel(name, device="auto", compute_type="int8")
        return _models[name]


def load_audio(path: str, sr: int = 16000) -> np.ndarray:
    """Декодирует звук через ffmpeg в моно float32 16 кГц (формат, который ждёт Whisper)."""
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(out, np.float32)


def transcribe(
    path: str,
    model_name: str = "small",
    language: str | None = None,
    prompt: str | None = None,
    on_progress: Callable[[float, str], None] | None = None,
) -> dict:
    if on_progress:
        on_progress(0.0, "Загрузка модели…")
    model = get_model(model_name)
    if on_progress:
        on_progress(0.01, "Распознавание речи…")

    segments, info = model.transcribe(
        load_audio(path),
        language=language or None,
        word_timestamps=True,
        vad_filter=True,
        initial_prompt=(prompt or None) and prompt[:800],
        beam_size=5,
    )
    duration = info.duration or 1.0
    words = []
    for seg in segments:
        for w in seg.words or []:
            text = w.word.strip()
            if text:
                words.append({"text": text, "start": round(w.start, 3), "end": round(w.end, 3)})
        if on_progress:
            on_progress(min(0.99, seg.end / duration), "Распознавание речи…")

    return {"language": info.language, "duration": duration, "words": words}
