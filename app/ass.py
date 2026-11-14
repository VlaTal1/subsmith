"""Generates ASS subtitles from captions laid out by the browser.

Each caption carries `place` — absolutely placed words in video pixels, computed by
static/js/layout.js. This module only draws them: one event per word (plus a blurred halo
under it and its effects), using the same timing curves as static/js/overlay.js.

caption = {"start", "end", "words": [...], "place": {"words": [...], "entrance", "until"}}
"""

from __future__ import annotations

from pathlib import Path

from .anim import anim_state, segment_times
from .particles import BARS, PARTICLES, particle_events
from .anim import mulberry32

DEFAULT_STYLE = {"v": 2, "look": "editorial"}

# Word entrance — same curves as ENTRANCE in static/js/overlay.js
ENTRANCE = {
    "none": {"fade": 0, "rise": 0, "pop": 0},
    "fade": {"fade": 0.2, "rise": 0, "pop": 0},
    "rise": {"fade": 0.2, "rise": 0.25, "pop": 0},
    "pop": {"fade": 0, "rise": 0, "pop": 0.12},
}


def ass_color(hex_color: str, opacity: float = 1.0) -> str:
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = h[0:2], h[2:4], h[4:6]
    alpha = round((1 - max(0.0, min(1.0, opacity))) * 255)
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def ass_inline_color(hex_color: str) -> str:
    return "&H" + ass_color(hex_color)[4:] + "&"


def alpha_hex(opacity: float) -> str:
    return f"{round((1 - max(0.0, min(1.0, opacity))) * 255):02X}"


FONTS_DIR = Path(__file__).resolve().parent.parent / "fonts"
_METRICS: dict[str, tuple[float, float]] = {}


def font_metrics(name: str) -> tuple[float, float]:
    """Ascender and descender as fractions of the font size: libass scales the font so that winAscent+winDescent = size."""
    if not _METRICS:
        from fontTools.ttLib import TTFont

        for f in FONTS_DIR.glob("*.ttf"):
            t = TTFont(f, lazy=True)
            os2 = t["OS/2"]
            total = os2.usWinAscent + os2.usWinDescent
            _METRICS[t["name"].getDebugName(1)] = (os2.usWinAscent / total, os2.usWinDescent / total)
    return _METRICS.get(name, (0.8, 0.2))


def ass_time(t: float) -> str:
    t = max(0.0, t)
    cs = int(round(t * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def escape(text: str) -> str:
    return (
        text.replace("\\", "＼")
        .replace("{", "(")
        .replace("}", ")")
        .replace("\r", "")
        .replace("\n", " ")
    )


def _f(v) -> float:
    return float(v or 0)


# ---------------------------------------------------------------- effects around a word


def sparkle_stars(start: float, j: int, strength: float) -> list[dict]:
    rnd = mulberry32(int(start * 1000 + 0.5) * 31 + j)
    stars = []
    for _ in range(2 + int(strength + 0.5)):  # not round(): in Python 4.5 → 4, but in JS → 5
        stars.append({
            "x": -0.15 + rnd() * 1.3,  # star center: fraction of word width
            "y": -0.25 + rnd() * 1.5,  # fraction of word height
            "size": 0.22 + rnd() * 0.25,  # span: fraction of word height
            "rot": rnd() * 40 - 20,
            "delay": rnd() * 0.9,
            "period": 0.8 + rnd() * 0.7,
        })
    return stars


def sparkle_events(cap_start: float, j: int, box: list, appear: float, end: float, fx: dict, k: float) -> list[str]:
    """Twinkling stars around a word. box — the word's [x, y, w, h] in video pixels."""
    x0, y0, w, h = (float(v) for v in box)
    color = ass_inline_color(fx.get("color") or "#FFFFFF")
    out = []
    for star in sparkle_stars(cap_start, j, float(fx.get("strength", 5))):
        cx, cy, r = x0 + star["x"] * w, y0 + star["y"] * h, star["size"] * h / 2
        pts = [(0, -r), (0.2 * r, -0.2 * r), (r, 0), (0.2 * r, 0.2 * r), (0, r), (-0.2 * r, 0.2 * r), (-r, 0), (-0.2 * r, -0.2 * r)]
        draw = "m {:.1f} {:.1f} l ".format(*pts[0]) + " ".join(f"{px:.1f} {py:.1f}" for px, py in pts[1:])
        d = star["period"] * 0.6  # visible part of the cycle: flash and fade
        t = appear + star["delay"]
        while t < end - 0.02:
            te = min(t + d, end)
            ms = round(d * 1000)
            tags = (
                f"\\an5\\pos({cx:.1f},{cy:.1f})\\frz{star['rot']:.1f}\\bord0\\shad0\\blur{0.6 * k:.1f}\\c{color}"
                f"\\fscx30\\fscy30\\alpha&HFF&\\t(0,{ms // 2},\\fscx100\\fscy100\\alpha&H00&)"
                f"\\t({ms // 2},{ms},\\fscx30\\fscy30\\alpha&HFF&)\\p1"
            )
            out.append(f"Dialogue: 20,{ass_time(t)},{ass_time(te)},Default,,0,0,0,,{{{tags}}}{draw}")
            t += star["period"]
    return out


def anim_events(word: dict, appear: float, end: float, look: str, seed: int, layer: int, glow_color: str, k: float) -> list[str]:
    """An animated word: drawn centered on its box, transformed over time like animState() in overlay.js."""
    anim = word["anim"]
    h = float(word["box"][3])
    asc, desc = font_metrics(word["font"])
    # \an5 anchors the center of the libass line box; overlay.js rotates/scales around the same point
    px, py = _f(word["cx"]), _f(word["y"]) + (desc - asc) / 2 * _f(word["fs"])
    stepwise = anim["type"] in ("shake", "flicker")
    glow_c = ass_inline_color(glow_color)
    glow_r = 0.12 * _f(word["em"])

    def state_tags(st: dict) -> str:
        out = f"\\fscx{st['scale'] * 100:.1f}\\fscy{st['scale'] * 100:.1f}\\frz{-st['rot']:.2f}\\alpha&H{alpha_hex(st['alpha'])}&"
        if st["color"]:
            out += f"\\c{ass_inline_color(st['color'])}"
        if st["glow"] is not None:
            out += f"\\bord{glow_r * 0.5 * st['glow']:.1f}\\blur{glow_r * st['glow']:.1f}\\3c{glow_c}"
        return out

    def center(st: dict) -> tuple[float, float]:
        return px + st["dx"] * h, py + st["dy"] * h

    times = segment_times(anim, appear, end)
    segs = []
    for t_a, t_b in zip(times, times[1:]):
        if stepwise:
            st = anim_state(anim, (t_a + t_b) / 2 - appear, seed)
            segs.append([t_a, t_b, st, st])
        else:
            segs.append([t_a, t_b, anim_state(anim, t_a - appear, seed), anim_state(anim, t_b - appear, seed)])
    merged = []  # consecutive static segments — merged into one event
    for seg in segs:
        if merged and seg[2] == seg[3] == merged[-1][2] == merged[-1][3]:
            merged[-1][1] = seg[1]
        else:
            merged.append(seg)
    out = []
    for t_a, t_b, s0, s1 in merged:
        (cx0, cy0), (cx1, cy1) = center(s0), center(s1)
        place = f"\\pos({cx0:.1f},{cy0:.1f})" if (cx0, cy0) == (cx1, cy1) else f"\\move({cx0:.1f},{cy0:.1f},{cx1:.1f},{cy1:.1f})"
        tags = f"\\an5{place}{look}{state_tags(s0)}" + (f"\\t({state_tags(s1)})" if s0 != s1 else "")
        out.append(f"Dialogue: {layer},{ass_time(t_a)},{ass_time(t_b)},Default,,0,0,0,,{{{tags}}}{escape(word['text'])}")
    return out


# ---------------------------------------------------------------- captions


def _entrance(kind: str, cx: float, by: float, em: float) -> tuple[str, str]:
    """Position + entrance tags for a word anchored bottom-center (\\an2) at (cx, by)."""
    e = ENTRANCE.get(kind) or ENTRANCE["none"]
    tags = ""
    if e["rise"]:
        d = 0.3 * em
        place = f"\\move({cx:.1f},{by + d:.1f},{cx:.1f},{by:.1f},0,{round(e['rise'] * 1000)})"
    else:
        place = f"\\pos({cx:.1f},{by:.1f})"
    if e["fade"]:
        tags += f"\\fad({round(e['fade'] * 1000)},0)"
    if e["pop"]:
        tags += f"\\fscx70\\fscy70\\t(0,{round(e['pop'] * 1000)},\\fscx100\\fscy100)"
    return place, tags


def caption_events(cap: dict, k: float) -> list[str]:
    place = cap.get("place") or {}
    words = place.get("words") or []
    if not words:
        return []
    c_start, c_end = _f(cap["start"]), _f(cap["end"])
    until = max(c_end, _f(place.get("until")) or c_end)
    entrance = place.get("entrance") or "none"
    out: list[str] = []

    for n, w in enumerate(words):
        appear = max(c_start, min(_f(w.get("appear")) or c_start, until - 0.05))
        if until - appear < 0.01:
            continue
        nxt = words[n + 1] if n + 1 < len(words) else None
        em, fs = _f(w["em"]), _f(w["fs"])
        cx, y = _f(w["cx"]), _f(w["y"])
        by = y + font_metrics(w["font"])[1] * fs  # \an2 anchors the bottom of the libass line box
        opacity = _f(w.get("opacity", 1)) or 1.0
        font = f"\\fn{w['font']}\\fs{fs:.1f}\\fsp{_f(w.get('spacing')):.1f}"
        text = escape(w["text"])
        t0, t1 = ass_time(appear), ass_time(until)
        halo, outline = w.get("halo"), w.get("outline")
        seed = int(c_start * 1000 + 0.5) * 31 + int(w["j"]) + 17

        halo_look = None
        if halo:
            ha = alpha_hex(_f(halo["alpha"]) * opacity)
            halo_look = (f"{font}\\1c{ass_inline_color(halo['color'])}\\1a&HFF&\\3c{ass_inline_color(halo['color'])}"
                         f"\\3a&H{ha}&\\bord{_f(halo['width']):.1f}\\blur{_f(halo['blur']):.1f}\\shad0")
        main_look = f"{font}\\c{ass_inline_color(w['color'])}\\1a&H{alpha_hex(opacity)}&\\shad0"
        if outline:
            main_look += f"\\bord{_f(outline['width']):.1f}\\3c{ass_inline_color(outline['color'])}\\3a&H{alpha_hex(opacity)}&\\blur0"
        else:
            main_look += "\\bord0"

        if w.get("anim"):
            glow = (w.get("fx") or {}).get("color") or w["color"]
            if halo_look:
                out.extend(anim_events(w, appear, until, halo_look, seed, 14, glow, k))
            out.extend(anim_events(w, appear, until, main_look, seed, 15, glow, k))
        else:
            pos, ent = _entrance(entrance, cx, by, em)
            if halo_look:
                out.append(f"Dialogue: 1,{t0},{t1},Default,,0,0,0,,{{\\an2{pos}{ent}{halo_look}}}{text}")
            active = ""
            if w.get("active") and w["active"] != w["color"]:
                off = (_f(nxt["appear"]) if nxt else c_end) - appear
                active = f"\\c{ass_inline_color(w['active'])}"
                if off * 1000 < (until - appear) * 1000 - 5:
                    ms = round(off * 1000)
                    active += f"\\t({ms},{ms},\\c{ass_inline_color(w['color'])})"
            out.append(f"Dialogue: 2,{t0},{t1},Default,,0,0,0,,{{\\an2{pos}{ent}{main_look}{active}}}{text}")

        fx = w.get("fx") or {}
        box = w.get("box")
        if fx and box:
            if fx.get("type") == "sparkle":
                out.extend(sparkle_events(c_start, int(w["j"]), box, appear, c_end, fx, k))
            elif fx.get("type") in BARS:
                out.extend(particle_events(cap, int(w["j"]), box, appear, until, fx, k, fx.get("color") or w["color"], ass_inline_color, ass_time))
            elif fx.get("type") in PARTICLES:
                out.extend(particle_events(cap, int(w["j"]), box, appear, c_end, fx, k, fx.get("color") or w["color"], ass_inline_color, ass_time))
    return out


def build_ass(captions: list[dict], style: dict | None, width: int, height: int) -> str:
    k = height / 1080
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Montserrat,{round(height * 0.05)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines: list[str] = []
    for cap in captions:
        lines.extend(caption_events(cap, k))
    return header + "\n".join(lines) + "\n"
