"""Speech recognition with word-level timestamps via faster-whisper."""

from __future__ import annotations

import math
import os
import re
import subprocess
import threading
from typing import Callable

import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.vad import VadOptions

MODELS = ["tiny", "base", "small", "medium", "large-v3-turbo"]

# Speech detection: a low threshold and generous padding, so quiet or noisy speech isn't cut out
# as "silence" (the default threshold drops whole phrases under background noise).
VAD = dict(threshold=0.25, min_silence_duration_ms=500, speech_pad_ms=300)

# If the chosen language is this unlikely while another one is clearly spoken, the choice is wrong:
# forcing Ukrainian on Russian speech (or vice versa) makes Whisper invent text.
WRONG_LANGUAGE = 0.02
CLEAR_LANGUAGE = 0.5

# Phrases Whisper makes up on noise, music or silence (they come from subtitles of its training videos)
HALLUCINATIONS = re.compile(
    r"^(дякую за перегляд|дякую|спасибо за просмотр|спасибо|продолжение следует|thanks for watching|thank you"
    r"|субтитры (сделал|создавал|подготовил).*|редактор субтитров.*|корректор.*|субтитрування.*)[.!…\s]*$",
    re.IGNORECASE,
)

_models: dict[str, WhisperModel] = {}
_lock = threading.Lock()


def get_model(name: str) -> WhisperModel:
    if name not in MODELS:
        raise ValueError(f"Unknown model: {name}")
    with _lock:
        if name not in _models:
            # all cores: the library default uses only a few, ~1.6x slower on CPU
            _models[name] = WhisperModel(name, device="auto", compute_type="int8", cpu_threads=os.cpu_count() or 4)
        return _models[name]


def load_audio(path: str, sr: int = 16000) -> np.ndarray:
    """Decodes audio via ffmpeg to mono float32 at 16 kHz (the format Whisper expects).

    The audio is deliberately left unprocessed: denoising and loudness normalization made
    recognition worse in tests (Whisper is trained on noisy audio and copes better on its own).
    """
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(out, np.float32)


def check_language(model: WhisperModel, audio: np.ndarray, language: str | None) -> tuple[str | None, str | None]:
    """Language to transcribe with, and a note for the user if the requested one was overridden."""
    detected, prob, all_probs = model.detect_language(
        audio, vad_filter=True, vad_parameters=VadOptions(**VAD),
        language_detection_segments=max(1, min(4, math.ceil(len(audio) / 16000 / 30))),  # one per 30 s of audio
    )
    if not language:
        return None, None  # Whisper detects it again while transcribing
    probs = dict(all_probs)
    if probs.get(language, 0.0) < WRONG_LANGUAGE and detected != language and prob >= CLEAR_LANGUAGE:
        return detected, detected
    return language, None


def transcribe(
    path: str,
    model_name: str = "large-v3-turbo",
    language: str | None = None,
    prompt: str | None = None,
    on_progress: Callable[[float, str], None] | None = None,
) -> dict:
    if on_progress:
        on_progress(0.0, "Loading model…")
    model = get_model(model_name)
    audio = load_audio(path)
    if on_progress:
        on_progress(0.01, "Detecting language…")
    language, switched_to = check_language(model, audio, language or None)
    if on_progress:
        on_progress(0.02, "Transcribing speech…")

    segments, info = model.transcribe(
        audio,
        language=language,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters=VAD,
        # each segment is decoded on its own, so one misheard phrase can't derail the rest
        condition_on_previous_text=False,
        initial_prompt=(prompt or None) and prompt[:800],
        beam_size=5,
    )
    duration = info.duration or 1.0
    words = []
    for seg in segments:
        if HALLUCINATIONS.match(seg.text.strip()) and (seg.no_speech_prob > 0.3 or seg.avg_logprob < -0.8):
            continue
        for w in seg.words or []:
            text = w.word.strip()
            if text:
                words.append({"text": text, "start": round(w.start, 3), "end": round(w.end, 3)})
        if on_progress:
            on_progress(min(0.99, seg.end / duration), "Transcribing speech…")

    return {"language": info.language, "duration": duration, "words": words, "switchedTo": switched_to}
