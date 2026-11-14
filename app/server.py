"""HTTP API and frontend serving."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
import traceback
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fontTools.ttLib import TTFont
from pydantic import BaseModel

from . import transcribe as stt
from .ass import DEFAULT_STYLE, build_ass

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "projects"
FONTS = ROOT / "fonts"
STATIC = ROOT / "static"
DATA.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="subsmith")

# ---------------------------------------------------------------- projects


def project_dir(pid: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{12}", pid):
        raise HTTPException(404, "Project not found")
    d = DATA / pid
    if not (d / "project.json").exists():
        raise HTTPException(404, "Project not found")
    return d


def load_project(pid: str) -> dict:
    return json.loads((project_dir(pid) / "project.json").read_text("utf-8"))


def save_project(p: dict) -> None:
    p["updated"] = time.time()
    path = DATA / p["id"] / "project.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(p, ensure_ascii=False), "utf-8")
    tmp.replace(path)


def probe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    info = json.loads(out)
    video = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    if not video:
        raise HTTPException(400, "The file has no video track")
    w, h = int(video["width"]), int(video["height"])
    rotation = 0
    for sd in video.get("side_data_list", []):
        if "rotation" in sd:
            rotation = int(sd["rotation"])
    rotation = int(video.get("tags", {}).get("rotate", rotation))
    if abs(rotation) % 180 == 90:
        w, h = h, w
    duration = float(info["format"].get("duration") or video.get("duration") or 0)
    has_audio = any(s["codec_type"] == "audio" for s in info["streams"])
    return {"width": w, "height": h, "duration": duration, "hasAudio": has_audio}


@app.get("/api/projects")
def list_projects():
    items = []
    for d in DATA.iterdir():
        f = d / "project.json"
        if f.exists():
            p = json.loads(f.read_text("utf-8"))
            items.append({k: p.get(k) for k in ("id", "name", "created", "updated", "duration", "width", "height")}
                         | {"hasOutput": (d / "output.mp4").exists(), "captions": len(p.get("captions") or [])})
    items.sort(key=lambda p: p.get("updated") or 0, reverse=True)
    return items


@app.post("/api/projects")
def create_project(file: UploadFile = File(...), name: str = Form("")):
    pid = uuid.uuid4().hex[:12]
    d = DATA / pid
    d.mkdir(parents=True)
    ext = (Path(file.filename or "video.mp4").suffix or ".mp4").lower()
    raw = d / f"upload{ext}"
    with raw.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    try:
        src = d / "source.mp4"
        if ext in (".mp4", ".mov", ".m4v") and probe(raw)["duration"] > 0:
            raw.rename(src)
        else:
            # webm/mkv (e.g. a teleprompter recording) — re-encode so that seeking works correctly
            subprocess.run(
                ["ffmpeg", "-y", "-v", "error", "-i", str(raw), "-c:v", "libx264", "-preset", "veryfast",
                 "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
                 str(src)],
                check=True, capture_output=True,
            )
            raw.unlink()
        meta = probe(src)
    except subprocess.CalledProcessError as e:
        shutil.rmtree(d, ignore_errors=True)
        raise HTTPException(400, "Could not read the video: " + (e.stderr or b"").decode(errors="ignore")[-300:])
    except Exception:
        shutil.rmtree(d, ignore_errors=True)
        raise
    p = {
        "id": pid,
        "name": name or Path(file.filename or "Video").stem,
        "created": time.time(),
        **meta,
        "language": None,
        "words": [],
        "captions": [],
        "style": DEFAULT_STYLE,
        "chunk": {"maxWords": 4, "maxChars": 22},
    }
    save_project(p)
    return p


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    p = load_project(pid)
    p["hasOutput"] = (DATA / pid / "output.mp4").exists()
    return p


class ProjectUpdate(BaseModel):
    name: str | None = None
    captions: list | None = None
    style: dict | None = None
    chunk: dict | None = None


@app.put("/api/projects/{pid}")
def update_project(pid: str, upd: ProjectUpdate):
    p = load_project(pid)
    for k, v in upd.model_dump(exclude_none=True).items():
        p[k] = v
    save_project(p)
    return {"ok": True}


@app.delete("/api/projects/{pid}")
def delete_project(pid: str):
    shutil.rmtree(project_dir(pid))
    return {"ok": True}


@app.get("/api/projects/{pid}/video")
def get_video(pid: str):
    return FileResponse(project_dir(pid) / "source.mp4", media_type="video/mp4")


@app.get("/api/projects/{pid}/output")
def get_output(pid: str):
    d = project_dir(pid)
    out = d / "output.mp4"
    if not out.exists():
        raise HTTPException(404, "The video has not been exported yet")
    name = load_project(pid)["name"]
    return FileResponse(out, media_type="video/mp4", filename=f"{name}_subtitles.mp4")


class RenderRequest(BaseModel):
    captions: list
    style: dict


@app.post("/api/projects/{pid}/ass")
def get_ass(pid: str, req: RenderRequest):
    p = load_project(pid)
    return PlainTextResponse(build_ass(req.captions, req.style, p["width"], p["height"]))


def _font_info(path: Path) -> dict:
    font = TTFont(path)
    os2 = font["OS/2"]
    total = os2.usWinAscent + os2.usWinDescent
    # libass scales the font so that winAscent+winDescent == size; in CSS the size is the em
    return {
        "name": font["name"].getDebugName(1),
        "file": path.name,
        "cssScale": font["head"].unitsPerEm / total,
        "asc": os2.usWinAscent / total,
        "desc": os2.usWinDescent / total,
    }


FONT_LIST = [_font_info(f) for f in sorted(FONTS.glob("*.ttf"))]


@app.get("/api/fonts")
def list_fonts():
    return FONT_LIST


# ---------------------------------------------------------------- background jobs

jobs: dict[str, dict] = {}


def start_job(kind: str, pid: str, fn) -> str:
    jid = uuid.uuid4().hex[:12]
    job = {"id": jid, "kind": kind, "project": pid, "status": "running", "progress": 0.0, "message": "", "error": None}
    jobs[jid] = job

    def progress(value: float, message: str = ""):
        job["progress"] = round(value, 4)
        if message:
            job["message"] = message

    def run():
        try:
            job["result"] = fn(progress)
            job["progress"] = 1.0
            job["status"] = "done"
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            job["status"] = "error"
            job["error"] = str(e)

    threading.Thread(target=run, daemon=True).start()
    return jid


@app.get("/api/jobs/{jid}")
def get_job(jid: str):
    if jid not in jobs:
        raise HTTPException(404, "Job not found")
    return jobs[jid]


class TranscribeRequest(BaseModel):
    engine: str = "whisper"  # whisper | vosk
    model: str = "small"
    language: str | None = None
    prompt: str | None = None


@app.post("/api/projects/{pid}/transcribe")
def start_transcribe(pid: str, req: TranscribeRequest):
    p = load_project(pid)
    if not p.get("hasAudio", True):
        raise HTTPException(400, "The video has no audio track")
    src = str(project_dir(pid) / "source.mp4")

    def work(progress):
        if req.engine == "vosk":
            from . import vosk_stt

            res = vosk_stt.transcribe(src, req.model, progress)
        else:
            res = stt.transcribe(src, req.model, req.language, req.prompt, progress)
        p2 = load_project(pid)
        p2["words"] = res["words"]
        p2["language"] = res["language"]
        save_project(p2)
        return res

    return {"job": start_job("transcribe", pid, work)}


@app.post("/api/projects/{pid}/render")
def start_render(pid: str, req: RenderRequest):
    p = load_project(pid)
    d = project_dir(pid)
    # "place" is the layout from the preview for this render; not saved to the project
    p["captions"] = [{k: v for k, v in c.items() if k != "place"} for c in req.captions]
    p["style"] = req.style
    save_project(p)

    def work(progress):
        progress(0.0, "Preparing…")
        (d / "subs.ass").write_text(build_ass(req.captions, req.style, p["width"], p["height"]), "utf-8")
        fonts_rel = os.path.relpath(FONTS, d)
        tmp = d / "output.tmp.mp4"
        cmd = [
            "ffmpeg", "-y", "-v", "error", "-nostats", "-progress", "pipe:1",
            "-i", "source.mp4",
            "-vf", f"ass=subs.ass:fontsdir={fonts_rel}",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
            tmp.name,
        ]
        proc = subprocess.Popen(cmd, cwd=d, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        duration = p["duration"] or 1
        for line in proc.stdout:
            if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
                try:
                    progress(min(0.99, int(line.split("=")[1]) / 1e6 / duration), "Rendering video…")
                except ValueError:
                    pass
        err = proc.stderr.read()
        if proc.wait() != 0:
            raise RuntimeError("ffmpeg error: " + err[-500:])
        tmp.replace(d / "output.mp4")
        return {"url": f"/api/projects/{pid}/output"}

    return {"job": start_job("render", pid, work)}


# ---------------------------------------------------------------- static files

app.mount("/fonts", StaticFiles(directory=FONTS), name="fonts")
app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
