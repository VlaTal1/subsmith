"""Particle effects around a word (hearts, confetti, sparks, …) and marker/underline.

The word position and box come from the preview; random parameters come from mulberry32
with the same seed as in static/js/overlay.js (particleSlots/particleCycle). Keep them in sync:
the order of rnd() calls matters.
"""

from __future__ import annotations

import math

from .anim import mulberry32

PARTICLES = ("hearts", "confetti", "fireflies", "bubbles", "snow", "burst")
BARS = ("marker", "underline")
CONFETTI = ["#FF3EA5", "#FFE45C", "#22D3EE", "#A3E635", "#A78BFA", "#FB923C"]
WIPE = 0.25  # marker/underline is drawn in over 0.25 s


def _polygon(points):
    """Polygon centered on its bounding box and fitted into [-1, 1]."""
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    k = max(max(xs) - min(xs), max(ys) - min(ys)) / 2
    return [(round((x - cx) / k, 4), round((y - cy) / k, 4)) for x, y in points]


SHAPES = {
    "star": [(0, -1), (0.2, -0.2), (1, 0), (0.2, 0.2), (0, 1), (-0.2, 0.2), (-1, 0), (-0.2, -0.2)],
    "dot": _polygon([(math.cos(i * math.pi / 8), math.sin(i * math.pi / 8)) for i in range(16)]),
    "heart": _polygon([
        (16 * math.sin(t) ** 3, -(13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)))
        for t in (i * 2 * math.pi / 28 for i in range(28))
    ]),
    "rect": [(-1, -0.5), (1, -0.5), (1, 0.5), (-1, 0.5)],
    "ray": [(-1, -0.09), (1, -0.09), (1, 0.09), (-1, 0.09)],
}


def particle_slots(kind: str, seed: int, strength: float) -> list[dict]:
    rnd = mulberry32(seed)
    if kind == "burst":
        n = 8 + int(strength + 0.5)
        return [{"delay": 0.0, "period": 1e9} for _ in range(n)]
    n = 2 + int(strength * 0.8 + 0.5)
    delay_k, base, extra = {
        "hearts": (1.2, 1.3, 0.8), "confetti": (0.6, 1.0, 0.6), "fireflies": (1.5, 1.6, 1.0),
        "bubbles": (1.2, 1.4, 0.8), "snow": (1.5, 1.6, 1.2),
    }[kind]
    out = []
    for _ in range(n):
        d = rnd() * delay_k
        out.append({"delay": d, "period": base + rnd() * extra})
    return out


def particle_cycle(kind: str, seed: int, i: int, n: int, count: int) -> dict:
    """Parameters of the i-th particle in the n-th cycle. x, y — fractions of the word box; size — fraction of the word height."""
    rnd = mulberry32(seed + i * 7919 + n * 104729)
    p = {"shape": "dot", "color": None, "rot0": 0.0, "rot1": 0.0, "alpha": (0, 1, 0), "scale": (1, 1, 1), "blur": 0.5, "ring": False}
    if kind == "hearts":
        p.update(L=1.2 + rnd() * 0.4, x0=0.1 + rnd() * 0.8, y0=0.9 + rnd() * 0.2)
        p.update(x1=p["x0"] + (rnd() - 0.5) * 0.4, y1=p["y0"] - (0.9 + rnd() * 0.6), size=0.28 + rnd() * 0.18)
        p["rot0"] = (rnd() - 0.5) * 30
        p["rot1"] = p["rot0"] + (rnd() - 0.5) * 30
        p.update(shape="heart", scale=(0.5, 1, 0.8))
    elif kind == "confetti":
        p.update(L=1.0 + rnd() * 0.4, x0=-0.1 + rnd() * 1.2, y0=-0.5 - rnd() * 0.3)
        p.update(x1=p["x0"] + (rnd() - 0.5) * 0.5, y1=1.3 + rnd() * 0.4, size=0.12 + rnd() * 0.08)
        p["rot0"] = rnd() * 360
        p["rot1"] = p["rot0"] + 180 + rnd() * 360
        p.update(shape="rect", color=CONFETTI[int(rnd() * 6)], alpha=(1, 1, 0), blur=0.0)
    elif kind == "fireflies":
        p.update(L=1.4 + rnd() * 0.6, x0=-0.1 + rnd() * 1.2, y0=-0.2 + rnd() * 1.4)
        p.update(x1=p["x0"] + (rnd() - 0.5) * 0.5, y1=p["y0"] + (rnd() - 0.5) * 0.5 - 0.15, size=0.07 + rnd() * 0.06)
        p.update(scale=(0.6, 1.2, 0.6), blur=3.0)
    elif kind == "bubbles":
        p.update(L=1.3 + rnd() * 0.5, x0=rnd(), y0=1.0 + rnd() * 0.2)
        p.update(x1=p["x0"] + (rnd() - 0.5) * 0.3, y1=-0.4 - rnd() * 0.5, size=0.12 + rnd() * 0.14)
        p.update(alpha=(0, 0.9, 0), scale=(0.5, 1, 1.1), ring=True, blur=0.4)
    elif kind == "snow":
        p.update(L=1.6 + rnd() * 0.8, x0=-0.2 + rnd() * 1.4, y0=-0.6 - rnd() * 0.2)
        p.update(x1=p["x0"] + (rnd() - 0.5) * 0.4, y1=1.4 + rnd() * 0.3, size=0.06 + rnd() * 0.06, blur=1.0)
    elif kind == "burst":
        ang = i / count * 360 + (rnd() - 0.5) * 12
        c, s = math.cos(math.radians(ang)), math.sin(math.radians(ang))
        p.update(L=0.45, x0=0.5 + c * 0.55, y0=0.5 + s * 0.75, x1=0.5 + c * 0.8, y1=0.5 + s * 1.3)
        p.update(size=0.35 + rnd() * 0.15, rot0=ang, rot1=ang, shape="ray", alpha=(1, 0.8, 0), scale=(1, 1, 0.6), blur=0.6)
    return p


def lerp3(keys, u: float) -> float:
    """Value from three keys (start, middle, end of the particle's life) — linear, like \\t in ASS."""
    a, b, c = keys
    return a + (b - a) * (u / 0.5) if u < 0.5 else b + (c - b) * ((u - 0.5) / 0.5)


def particle_events(cap: dict, j: int, box: list, appear: float, end: float, fx: dict, k: float,
                    default_color: str, color_fn, time_fn) -> list[str]:
    x0b, y0b, w, h = (float(v) for v in box)
    kind = fx["type"]
    strength = float(fx.get("strength", 5))
    color = fx.get("color") or default_color
    out = []

    if kind in BARS:
        if kind == "marker":
            bw, bh, yc, alpha = w * 1.04, h * 0.42, 0.72, 0.25 + 0.05 * strength
        else:
            bw, bh, yc, alpha = w * 1.02, h * (0.04 + 0.006 * strength), 0.97, 1.0
        a_hex = f"{round((1 - alpha) * 255):02X}"
        draw = f"m 0 {-bh / 2:.1f} l {bw:.1f} {-bh / 2:.1f} {bw:.1f} {bh / 2:.1f} 0 {bh / 2:.1f}"
        tags = (f"\\an4\\pos({x0b - (bw - w) / 2:.1f},{y0b + yc * h:.1f})\\bord0\\shad0\\blur{0.6 * k:.1f}"
                f"\\c{color_fn(color)}\\1a&H{a_hex}&\\fscx0\\t(0,{round(WIPE * 1000)},\\fscx100)\\p1")
        out.append(f"Dialogue: -1,{time_fn(appear)},{time_fn(end)},Default,,0,0,0,,{{{tags}}}{draw}")
        return out

    seed = int(float(cap["start"]) * 1000 + 0.5) * 31 + j + 101
    slots = particle_slots(kind, seed, strength)
    for i, slot in enumerate(slots):
        n = 0
        while True:
            t0 = appear + slot["delay"] + n * slot["period"]
            if t0 >= end - 0.02 or (kind == "burst" and n > 0):
                break
            p = particle_cycle(kind, seed, i, n, len(slots))
            L = p["L"]
            t1 = min(t0 + L, end)
            r = p["size"] * h / 2
            pts = [(x * r, y * r) for x, y in SHAPES[p["shape"]]]
            draw = "m {:.1f} {:.1f} l ".format(*pts[0]) + " ".join(f"{x:.1f} {y:.1f}" for x, y in pts[1:])
            cx0, cy0 = x0b + p["x0"] * w, y0b + p["y0"] * h
            cx1, cy1 = x0b + p["x1"] * w, y0b + p["y1"] * h
            c = color_fn(p["color"] or color)
            a = [f"{round((1 - v) * 255):02X}" for v in p["alpha"]]
            sc = [f"{v * 100:.0f}" for v in p["scale"]]
            half, full = round(L * 500), round(L * 1000)
            if p["ring"]:
                look = f"\\1a&HFF&\\bord{max(1.0, r * 0.18):.1f}\\3c{c}"
                al = lambda x: f"\\3a&H{x}&"
            else:
                look = f"\\bord0\\c{c}"
                al = lambda x: f"\\1a&H{x}&"
            # \move spans the particle's whole life — if the caption end cuts it short, shorten the path
            u_end = (t1 - t0) / L
            ex, ey = cx0 + (cx1 - cx0) * u_end, cy0 + (cy1 - cy0) * u_end
            tags = (
                f"\\an5\\move({cx0:.1f},{cy0:.1f},{ex:.1f},{ey:.1f})\\shad0\\blur{p['blur'] * k:.1f}{look}"
                f"\\frz{-p['rot0']:.1f}\\fscx{sc[0]}\\fscy{sc[0]}{al(a[0])}"
                f"\\t(0,{half},\\fscx{sc[1]}\\fscy{sc[1]}{al(a[1])})\\t({half},{full},\\fscx{sc[2]}\\fscy{sc[2]}{al(a[2])})"
                f"\\t(0,{full},\\frz{-p['rot1']:.1f})\\p1"
            )
            out.append(f"Dialogue: 18,{time_fn(t0)},{time_fn(t1)},Default,,0,0,0,,{{{tags}}}{draw}")
            n += 1
    return out
