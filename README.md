# subsmith

> Forge your subtitles.

A self-hosted web app for automatic video subtitles, in the spirit of Captions-style mobile apps:

- **Speech recognition** — Whisper (faster-whisper) with word-level timestamps and automatic language detection (en, uk, ru and more), plus Vosk for Ukrainian.
- **Editor** — edit text, split and merge captions, drag caption boundaries on the timeline, find and replace, shift all timings, undo (Ctrl+Z).
- **Styles** — active word highlight, word box, karaoke, one word at a time, classic, boxed; font-mix combo styles with effects (glow, sparkles, hearts, confetti…) and animations; Cyrillic-ready fonts, colors, outline, shadow, position. The browser preview matches the final video.
- **Export** — MP4 with burned-in subtitles (ffmpeg + libass), plus SRT / VTT / ASS / TXT.
- **Teleprompter** — scrolling script, adjustable speed, mirror mode, camera recording in 9:16 or 16:9. The recording goes straight into the editor, and the script is used as a recognition hint.

## Getting started

Requires Python 3.10+ and ffmpeg (built with libass and libx264).

```bash
uv venv --python 3.12 .venv            # or: python3 -m venv .venv
uv pip install --python .venv -r requirements.txt
./run.sh                                # http://localhost:8000
```

The speech model is downloaded on first use (Whisper small ≈ 500 MB, Vosk Ukrainian ≈ 370 MB). On CPU, the "balanced" model transcribes one minute of video in roughly one minute; an NVIDIA GPU is used automatically when available.

The teleprompter camera only works on `localhost` or over HTTPS (a browser restriction). To use it from a phone on the same network, run `./run.sh --https` — it generates a self-signed certificate and serves on port 8443.

## Project layout

- `app/server.py` — API (projects, background transcription and render jobs), frontend serving.
- `app/transcribe.py`, `app/vosk_stt.py` — speech recognition (Whisper, Vosk).
- `app/ass.py` — ASS subtitle generation for every style; `app/anim.py`, `app/particles.py` — animations and particle effects.
- `static/` — build-free frontend: `js/overlay.js` (live preview), `js/captions.js` (caption logic), `js/app.js` (editor), `js/teleprompter.js`.
- `fonts/` — fonts shared by the preview and the renderer.
- `data/projects/<id>/` — source video, `project.json`, rendered output.
