"""Generates ASS subtitles from a list of captions and style settings.

caption = {"start": float, "end": float, "words": [{"text": str, "start": float, "end": float}, ...]}
"""

from __future__ import annotations

import itertools
import json
from pathlib import Path

from .anim import anim_state, mulberry32, segment_times
from .particles import BARS, PARTICLES, particle_events

DEFAULT_STYLE = {
    "preset": "highlight",  # classic | box | highlight | wordbox | karaoke | pop | combo
    "font": "Montserrat",
    "fontSize": 6.5,  # % of video height
    "uppercase": True,
    "color": "#FFFFFF",
    "highlightColor": "#FFE600",
    "outlineColor": "#000000",
    "outline": 6,  # px at 1080 height
    "shadow": 0,  # px at 1080 height
    "boxColor": "#000000",
    "boxOpacity": 0.6,
    "position": 22,  # bottom offset, % of height
    "maxWidth": 84,  # text block width, % of width
    "x": 50,  # horizontal block center, % of width
    "lineSpacing": 1.0,  # line spacing, 1 = font default
    "animation": "pop",  # none | pop | fade
    "wordScale": 1.12,  # active word scale-up
    "reveal": False,  # words appear as they are spoken
    "combo": "elegant",  # template for preset == "combo" (static/combos.json or a custom-… one)
    "comboDef": None,  # copy of the custom template — in case it gets deleted from the library
}


def merge_style(style: dict | None) -> dict:
    s = dict(DEFAULT_STYLE)
    if style:
        s.update({k: v for k, v in style.items() if k in DEFAULT_STYLE and v is not None})
    return s


def ass_color(hex_color: str, opacity: float = 1.0) -> str:
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = h[0:2], h[2:4], h[4:6]
    alpha = round((1 - max(0.0, min(1.0, opacity))) * 255)
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def ass_inline_color(hex_color: str) -> str:
    return "&H" + ass_color(hex_color)[4:] + "&"


def contrast_text(hex_color: str) -> str:
    """Black or white text — whichever reads better on the given background color."""
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return "#000000" if 0.299 * r + 0.587 * g + 0.114 * b > 150 else "#FFFFFF"


def block_margins(x: float, y: float, max_width: float, width: int, height: int) -> tuple[int, int, int]:
    """Text block margins: horizontal center at x% of width, block bottom at y% of height from the bottom.

    Near the frame edge the block narrows (text wraps) so it stays inside the frame.
    The same formula lives in static/js/overlay.js (blockBox).
    """
    x = max(0.0, min(100.0, float(x)))
    half = min(float(max_width) / 2, x, 100 - x)
    return round(width * (x - half) / 100), round(width * (100 - x - half) / 100), round(height * float(y) / 100)


# ---------------------------------------------------------------- second-font effects
# Same logic in static/js/overlay.js (fxTextShadow, sparkleStars) — keep them in sync.


def fx_tags(fx: dict | None, k: float):
    """Styling tags for a word with an effect, plus target outline/shadow alphas for the fade-in."""
    if not fx or fx.get("type") in (None, "none", "sparkle"):
        return None
    c = ass_inline_color(fx.get("color") or "#FFFFFF")
    st = float(fx.get("strength", 5))
    if fx["type"] == "glow":
        r = (4 + st * 3) * k
        return f"\\bord{r * 0.5:.1f}\\blur{r * 0.6:.1f}\\3c{c}\\3a&H40&\\shad0", "40", "FF"
    if fx["type"] == "shadow":
        d = st * 1.5 * k
        return f"\\bord0\\blur0\\shad{d:.1f}\\4c{c}\\4a&H00&", "FF", "00"
    if fx["type"] == "outline":
        t = st * 1.0 * k
        return f"\\bord{t:.1f}\\blur0.6\\3c{c}\\3a&H00&\\shad0", "00", "FF"
    return None


def animated(role: dict) -> bool:
    return (role.get("anim") or {}).get("type") not in (None, "", "none")


def _alpha(base_hex: str, f: float) -> str:
    base = int(base_hex, 16)
    return f"{round(255 - (255 - base) * max(0.0, min(1.0, f))):02X}"


def anim_events(cap: dict, j: int, box: list, appear: float, end: float, copy: tuple, s: dict, k: float) -> list[str]:
    """Animated copy of a word drawn over its place in the line (the word itself is hidden in the line
    so scaling and rotation don't shift its neighbours). box — [x, y, w, h] from the preview."""
    base_tags, text, a1, t3, t4, role = copy
    anim = role["anim"]
    seed = int(float(cap["start"]) * 1000 + 0.5) * 31 + j + 17
    x0, y0, w, h = (float(v) for v in box)
    fx = role.get("fx") or {}
    glow_c = ass_inline_color(fx.get("color") or s["highlightColor"])
    glow_r = (4 + float(fx.get("strength", 5) if fx.get("type") == "glow" else 5) * 3) * k
    stepwise = anim["type"] in ("shake", "flicker")

    def look(st: dict) -> str:
        out = (
            f"\\fscx{st['scale'] * 100:.1f}\\fscy{st['scale'] * 100:.1f}\\frz{-st['rot']:.2f}"
            f"\\1a&H{_alpha(a1, st['alpha'])}&\\3a&H{_alpha(t3, st['alpha'])}&\\4a&H{_alpha(t4, st['alpha'])}&"
        )
        if st["color"]:
            out += f"\\c{ass_inline_color(st['color'])}"
        if st["glow"] is not None:
            g = st["glow"]
            out += f"\\bord{glow_r * 0.5 * g:.1f}\\blur{glow_r * 0.6 * g:.1f}\\3c{glow_c}"
            out += f"\\3a&H{_alpha('40', st['alpha'])}&"
        return out

    def center(st: dict) -> tuple[float, float]:
        return x0 + w / 2 + st["dx"] * h, y0 + h / 2 + st["dy"] * h

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
        tags = f"\\an5{place}{base_tags}{look(s0)}" + (f"\\t({look(s1)})" if s0 != s1 else "")
        out.append(f"Dialogue: 15,{ass_time(t_a)},{ass_time(t_b)},Default,,0,0,0,,{{{tags}}}{text}")
    return out


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


def sparkle_events(cap: dict, j: int, box: list, appear: float, end: float, fx: dict, k: float) -> list[str]:
    """Twinkling stars around a word. box — the word's [x, y, w, h] in video pixels (from the preview)."""
    x0, y0, w, h = (float(v) for v in box)
    color = ass_inline_color(fx.get("color") or "#FFFFFF")
    out = []
    for star in sparkle_stars(float(cap["start"]), j, float(fx.get("strength", 5))):
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
        .replace("\n", "\\N")
    )


def _word_text(w: dict, s: dict) -> str:
    t = w["text"].strip()
    return escape(t.upper() if s["uppercase"] else t)


def _intro(s: dict) -> str:
    if s["animation"] == "pop":
        return r"{\fscx70\fscy70\t(0,110,\fscx100\fscy100)}"
    if s["animation"] == "fade":
        return r"{\fad(150,0)}"
    return ""


def build_ass(captions: list[dict], style: dict | None, width: int, height: int) -> str:
    s = merge_style(style)
    k = height / 1080
    preset = s["preset"]
    font_size = round(height * float(s["fontSize"]) / 100 * (1.6 if preset == "pop" else 1.0))
    outline = round(float(s["outline"]) * k, 1)
    shadow = round(float(s["shadow"]) * k, 1)
    margin_l, margin_r, margin_v = block_margins(s["x"], s["position"], s["maxWidth"], width, height)

    primary = ass_color(s["color"])
    secondary = ass_color(s["color"])
    outline_c = ass_color(s["outlineColor"])
    back_c = ass_color(s["outlineColor"], 0.5)
    border_style = 1

    if preset == "box":
        border_style = 4  # libass: one solid box per line in BackColour
        outline_c = ass_color("#000000", 0.0)
        back_c = ass_color(s["boxColor"], float(s["boxOpacity"]))
        outline = round(font_size * 0.22, 1)
        shadow = 0
    elif preset == "wordbox":
        border_style = 3
        outline_c = ass_color(s["highlightColor"], 0.0)  # box hidden, shown on the active word
        back_c = ass_color("#000000", 0.0)
        outline = round(font_size * 0.16, 1)
        shadow = 0
    elif preset == "combo":
        s["font"] = get_combo(s["combo"], s.get("comboDef"))["roles"][0]["font"]
    elif preset == "karaoke":
        primary = ass_color(s["highlightColor"])  # filled part
        secondary = ass_color(s["color"])  # not yet sung part

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{s["font"]},{font_size},{primary},{secondary},{outline_c},{back_c},0,0,0,0,100,100,0,0,{border_style},{outline},{shadow},2,{margin_l},{margin_r},{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines: list[str] = []

    event_margins = "0,0,0"  # 0 — use the style margins; otherwise this caption's own position

    def add(start: float, end: float, text: str, layer: int = 0) -> None:
        if end - start < 0.01:
            return
        lines.append(f"Dialogue: {layer},{ass_time(start)},{ass_time(end)},Default,,{event_margins},,{text}")

    hl = ass_inline_color(s["highlightColor"])
    on_box = ass_inline_color(contrast_text(s["highlightColor"]))
    scale = round(float(s["wordScale"]) * 100)
    reveal = bool(s["reveal"]) or preset == "combo"
    a3, a4 = outline_c[2:4], back_c[2:4]  # outline and shadow alpha from the style
    combo = get_combo(s["combo"], s.get("comboDef")) if preset == "combo" else None
    spacing = float(s["lineSpacing"])
    # ASS has no line-spacing tag, so with spacing ≠ 100% every line is a separate event
    # at its own height. The preview tells us where lines break (cap["lines"]); it wraps
    # exactly like libass. The box and one-word styles have no line spacing.
    line_mode = abs(spacing - 1) > 1e-3 and preset not in ("box", "pop")

    def alpha_tags(j: int, i: int, t1: str = "00", t3: str = a3, t4: str = a4) -> str:
        """Hide a word not yet spoken, or fade in one just spoken."""
        if not reveal or j < i:
            return ""
        if preset == "box":  # for the box style, BackColour alpha is the box's own transparency
            hide, show = r"\1a&HFF&", rf"\1a&H{t1}&"
        else:
            hide, show = r"\1a&HFF&\3a&HFF&\4a&HFF&", rf"\1a&H{t1}&\3a&H{t3}&\4a&H{t4}&"
        if j > i:
            return hide
        return hide + rf"\t(0,180,{show})"

    def emit(start, end, prefix, frags, metrics, hard, starts, cap_margins, line_first=None):
        """Emit a caption from the words in frags (with tags).

        metrics[j] — (font, size) of the word, hard[j] — the word starts a line (combo),
        starts — line starts from the preview, line_first[j] — the word variant used when it
        starts a separate line event (needed for karaoke).
        """
        n = len(frags)
        if not line_mode or starts is None:
            text = "".join((("\\N" if hard[j] else " ") if j else "") + f for j, f in enumerate(frags))
            add(start, end, prefix + text)
            return
        nonlocal event_margins
        bounds = sorted({0, *(b for b in starts if 0 < b < n), *(j for j in range(n) if hard[j])}) + [n]
        rows = list(zip(bounds, bounds[1:]))
        asc = [max(sz * font_metrics(fn)[0] for fn, sz in metrics[a:z]) for a, z in rows]
        desc = [max(sz * font_metrics(fn)[1] for fn, sz in metrics[a:z]) for a, z in rows]
        ml, mr, mv = cap_margins
        # Bottom to top: the next line's baseline is higher by the natural step
        # plus (spacing−1)·mean of the two line heights — same as CSS line-height in the preview
        base = [0.0] * len(rows)
        base[-1] = height - mv - desc[-1]
        for q in range(len(rows) - 2, -1, -1):
            h_q, h_n = asc[q] + desc[q], asc[q + 1] + desc[q + 1]
            base[q] = base[q + 1] - (desc[q] + asc[q + 1]) - (spacing - 1) * (h_q + h_n) / 2
        for q, (a, z) in enumerate(rows):
            parts = [(line_first[a] if line_first else frags[a])] + frags[a + 1:z]
            event_margins = f"{max(1, ml)},{max(1, mr)},{max(1, round(height - base[q] - desc[q]))}"
            # Each line gets its own layer: libass pushes apart overlapping events on the same layer
            # (and with tight spacing the lines overlap on purpose)
            add(start, end, prefix + " ".join(parts), layer=q)

    def starts_for(cap: dict, i: int):
        ln = cap.get("lines")
        if not ln:
            return None
        if isinstance(ln[0], list):
            return ln[min(i, len(ln) - 1)]
        return ln

    base_font = (s["font"], font_size)

    for cap in captions:
        words = [w for w in cap.get("words", []) if w.get("text", "").strip()]
        if not words:
            continue
        c_start, c_end = float(cap["start"]), float(cap["end"])
        texts = [_word_text(w, s) for w in words]
        n = len(words)
        pos = cap.get("pos")
        if pos:
            # In Dialogue a margin of 0 means "use the style", so the minimum is 1
            cap_m = block_margins(pos["x"], pos["y"], s["maxWidth"], width, height)
            event_margins = f"{max(1, cap_m[0])},{max(1, cap_m[1])},{max(1, cap_m[2])}"
        else:
            cap_m = (margin_l, margin_r, margin_v)
            event_margins = "0,0,0"
        flat = [False] * n
        same = [base_font] * n

        def spans():
            """Time intervals during which the i-th word is active."""
            for i, w in enumerate(words):
                ws = c_start if i == 0 else float(w["start"])
                we = float(words[i + 1]["start"]) if i + 1 < len(words) else c_end
                yield i, ws, we

        if preset == "karaoke":
            k_start, k_dur, prev = [], [], c_start
            for i, w in enumerate(words):
                ws = max(float(w["start"]), prev)
                nxt = float(words[i + 1]["start"]) if i + 1 < n else max(float(w["end"]), ws)
                dur = max(1, round((nxt - ws) * 100))
                k_start.append(round((ws - c_start) * 100))
                k_dur.append(dur)
                prev = ws + dur / 100
            frags, firsts = [], []
            for i in range(n):
                gap = k_start[i] - (k_start[i - 1] + k_dur[i - 1] if i else 0)
                word = f"{{\\kf{k_dur[i]}}}{texts[i]}"
                frags.append((f"{{\\k{gap}}}" if gap > 0 else "") + word)
                firsts.append((f"{{\\k{k_start[i]}}}" if k_start[i] > 0 else "") + word)
            emit(c_start, c_end, _intro(s), frags, same, flat, starts_for(cap, n - 1), cap_m, firsts)

        elif preset == "pop":
            for i, ws, we in spans():
                add(ws, we, r"{\fscx70\fscy70\t(0,90,\fscx100\fscy100)}" + texts[i])

        elif preset == "combo":
            layout = combo_layout(combo, words)
            glow_c = ass_inline_color(s["outlineColor"])
            glow = round(float(s["outline"]) * k, 1)
            hard = [br for _, br in layout]
            metrics = [(role["font"], font_size * float(role.get("size", 1))) for role, _ in layout]
            copies = {}
            for i, ws, we in spans():
                frags = []
                for j, w in enumerate(words):
                    role = layout[j][0]
                    size = round(font_size * float(role.get("size", 1)), 1)
                    color = s["highlightColor"] if role.get("color") == "accent" else role.get("color") or s["color"]
                    if color == "main":
                        color = s["color"]
                    a1 = f"{round((1 - float(role.get('opacity', 1))) * 255):02X}"
                    text = escape(apply_case(w["text"].strip(), role.get("case"), s["uppercase"]))
                    look, t3, t4 = fx_tags(role.get("fx"), k) or (
                        f"\\bord{glow}\\blur{glow}\\3c{glow_c}\\3a&H99&\\shad0", "99", "FF")
                    base_tags = (
                        f"\\fn{role['font']}\\fs{size}\\fsp{round(float(role.get('spacing', 0)) * size, 1)}"
                        f"\\c{ass_inline_color(color)}\\1a&H{a1}&{look}"
                    )
                    if animated(role):
                        tags = base_tags + r"\1a&HFF&\3a&HFF&\4a&HFF&"
                        copies[j] = (base_tags, text, a1, t3, t4, role)
                    else:
                        tags = base_tags + alpha_tags(j, i, a1, t3, t4)
                    frags.append(f"{{{tags}}}{text}")
                emit(ws, we, _intro(s) if i == 0 else "", frags, metrics, hard, starts_for(cap, i), cap_m)
            for j, (role, _) in enumerate(layout):
                fx = role.get("fx") or {}
                box = (cap.get("fx") or {}).get(str(j))
                if fx.get("type") == "sparkle" and box:
                    appear = c_start if j == 0 else float(words[j]["start"])
                    lines.extend(sparkle_events(cap, j, box, appear, c_end, fx, k))
                if fx.get("type") in PARTICLES + BARS and box:
                    appear = c_start if j == 0 else float(words[j]["start"])
                    lines.extend(particle_events(cap, j, box, appear, c_end, fx, k, s["highlightColor"], ass_inline_color, ass_time))
                if j in copies and box:
                    appear = c_start if j == 0 else float(words[j]["start"])
                    lines.extend(anim_events(cap, j, box, appear, c_end, copies[j], s, k))

        elif preset in ("classic", "box") and not reveal:
            emit(c_start, c_end, _intro(s), texts, same, flat, starts_for(cap, n - 1), cap_m)

        else:  # highlight | wordbox | classic/box with word reveal — one event per word
            for i, ws, we in spans():
                frags = []
                for j, t in enumerate(texts):
                    tags = ""
                    if j == i and preset == "wordbox":
                        tags = f"\\3a&H00&\\c{on_box}\\fscx{scale}\\fscy{scale}" + alpha_tags(j, i, t3="00")
                    elif j == i and preset == "highlight":
                        tags = f"\\c{hl}\\fscx{scale}\\fscy{scale}" + alpha_tags(j, i)
                    else:
                        tags = alpha_tags(j, i)
                    frags.append(f"{{{tags}}}{t}{{\\r}}" if tags else t)
                emit(ws, we, _intro(s) if i == 0 else "", frags, same, flat, starts_for(cap, i), cap_m)

    return header + "\n".join(lines) + "\n"


# ---------------------------------------------------------------- combo styles

COMBOS_FILE = Path(__file__).resolve().parent.parent / "static" / "combos.json"


CUSTOM_COMBOS_FILE = Path(__file__).resolve().parent.parent / "data" / "custom_combos.json"


def load_custom_combos() -> list[dict]:
    if CUSTOM_COMBOS_FILE.exists():
        return json.loads(CUSTOM_COMBOS_FILE.read_text("utf-8"))
    return []


def get_combo(combo_id: str, fallback: dict | None = None) -> dict:
    combos = json.loads(COMBOS_FILE.read_text("utf-8"))
    found = next((c for c in combos + load_custom_combos() if c["id"] == combo_id), None)
    return found or fallback or combos[0]


def apply_case(text: str, case: str | None, uppercase: bool) -> str:
    if case == "upper" or (case is None and uppercase):
        return text.upper()
    if case == "lower":
        return text.lower()
    return text


_WORDS = json.loads((COMBOS_FILE.parent / "stopwords.json").read_text("utf-8"))
STOPWORDS, ATTACH = frozenset(_WORDS["stop"]), frozenset(_WORDS["attach"])


def _letters(text: str) -> str:
    return "".join(ch for ch in text.lower() if ch.isalpha())


def is_stopword(text: str) -> bool:
    return _letters(text) in STOPWORDS


def emphasis_indices(words: list[dict]) -> set[int]:
    """Accent words: those marked manually, otherwise the longest non-stopword."""
    marked = {i for i, w in enumerate(words) if w.get("em")}
    if marked:
        return marked
    lengths = [len(_letters(w["text"])) for w in words]
    candidates = [i for i, w in enumerate(words) if not is_stopword(w["text"])] or list(range(len(words)))
    best = candidates[0]
    for i in candidates:
        if lengths[i] > lengths[best]:
            best = i
    return {best}


def auto_line_starts(words: list[dict], max_lines: int) -> list[int]:
    """Where to start lines: try every split and pick the most natural one.

    Breaking at a pause in speech or after punctuation is good; leaving a preposition or
    conjunction at the end of a line, or a lone stopword on a line, is bad; lines should
    be roughly equal in length. The logic is mirrored 1:1 in static/js/overlay.js.
    """
    n = len(words)
    if n <= 1 or max_lines <= 1:
        return [0]
    stop = [is_stopword(w["text"]) for w in words]
    attach = [_letters(w["text"]) in ATTACH for w in words]
    chars = [len(w["text"]) for w in words]
    best_cost, best = None, [0]
    for lines in range(1, min(max_lines, n) + 1):
        for cuts in itertools.combinations(range(1, n), lines - 1):
            starts = [0, *cuts]
            cost = (min(max_lines, n) - lines) * 3.0
            for b in cuts:
                prev, cur = words[b - 1], words[b]
                if attach[b - 1]:
                    cost += 5.0
                if prev["text"].rstrip()[-1:] in ",.!?…:;—–":
                    cost -= 2.0
                gap = max(0.0, float(cur["start"]) - float(prev["end"]))
                cost -= min(gap, 1.0) * 4.0
            bounds = [*starts, n]
            lens = [sum(chars[a:z]) + (z - a - 1) for a, z in zip(bounds, bounds[1:])]
            mean = sum(lens) / len(lens)
            for (a, z), ln in zip(zip(bounds, bounds[1:]), lens):
                if z - a == 1 and stop[a]:
                    cost += 6.0
                cost += ((ln - mean) / mean) ** 2 * 2.0
            if best_cost is None or cost < best_cost - 1e-9:
                best_cost, best = cost, starts
    return best


def combo_layout(combo: dict, words: list[dict]) -> list[tuple[dict, bool]]:
    """For each word: (styling role, whether it starts a new line)."""
    roles = combo["roles"]
    n = len(words)
    if combo["layout"] == "accent":
        em = emphasis_indices(words)
        return [(roles[1] if i in em else roles[0], False) for i in range(n)]
    # stack: each line in its own font; manual breaks (br) override automatic ones
    manual = [i for i in range(1, n) if words[i].get("br")]
    starts = [0, *manual] if manual else auto_line_starts(words, len(roles))
    out, line = [], -1
    for i in range(n):
        if i in starts:
            line += 1
        out.append((roles[line % len(roles)], i in starts and i > 0))
    return out
