"""Анимации второго шрифта: состояние слова во времени и события ASS для анимированной копии.

Та же математика — в static/js/overlay.js (animState). Менять синхронно.
"""

from __future__ import annotations

import colorsys
import math

ANIMS = ("pulse", "float", "swing", "shake", "flicker", "rainbow", "bounce", "glowpulse")
# Пошаговые анимации: значение меняется скачком раз в шаг (секунд при скорости 5)
STEP = {"shake": 0.07, "flicker": 0.06}
FADE = 0.18  # плавное появление слова, с


def mulberry32(seed: int):
    state = seed & 0xFFFFFFFF

    def imul(a: int, b: int) -> int:
        return (a * b) & 0xFFFFFFFF

    def rnd() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = imul(state ^ (state >> 15), 1 | state)
        t = ((t + imul(t ^ (t >> 7), 61 | t)) & 0xFFFFFFFF) ^ t
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return rnd


def hsl_hex(h: float, s: float, l: float) -> str:
    r, g, b = colorsys.hls_to_rgb(h / 360, l, s)
    return "#{:02X}{:02X}{:02X}".format(round(r * 255), round(g * 255), round(b * 255))


def lerp_keys(keys: list[tuple[float, float]], u: float) -> float:
    if u <= keys[0][0]:
        return keys[0][1]
    for (u0, v0), (u1, v1) in zip(keys, keys[1:]):
        if u <= u1:
            return v0 + (v1 - v0) * (u - u0) / (u1 - u0)
    return keys[-1][1]


def anim_state(anim: dict, tau: float, seed: int) -> dict:
    """Состояние слова через tau секунд после появления.

    dx, dy — сдвиг в долях высоты слова; scale; rot — градусы; alpha 0..1;
    color — цвет текста или None; glow — множитель свечения или None.
    """
    a = float(anim.get("strength", 5)) / 5
    sp = float(anim.get("speed", 5)) / 5
    t = tau * sp
    st = {"dx": 0.0, "dy": 0.0, "scale": 1.0, "rot": 0.0, "alpha": 1.0, "color": None, "glow": None}
    kind = anim.get("type")
    if kind == "pulse":
        st["scale"] = 1 + 0.08 * a * (0.5 - 0.5 * math.cos(2 * math.pi * t / 1.0))
    elif kind == "float":
        st["dy"] = -0.06 * a * math.sin(2 * math.pi * t / 1.4)
    elif kind == "swing":
        st["rot"] = 6 * a * math.sin(2 * math.pi * t / 1.2)
    elif kind == "shake":
        rnd = mulberry32(seed + math.floor(t / STEP["shake"]) * 2654435761)
        st["dx"] = 0.03 * a * (rnd() * 2 - 1)
        st["dy"] = 0.03 * a * (rnd() * 2 - 1)
    elif kind == "flicker":
        rnd = mulberry32(seed + math.floor(t / STEP["flicker"]) * 2654435761)
        st["alpha"] = 0.25 if rnd() < 0.05 * a + 0.03 else 1.0
    elif kind == "rainbow":
        st["color"] = hsl_hex((t / 3.0 * 360) % 360, 0.9, 0.65)
    elif kind == "bounce":
        st["scale"] = lerp_keys([(0, 0.3), (0.12, 1 + 0.25 * a), (0.3, 1 - 0.06 * a), (0.42, 1.0)], t)
    elif kind == "glowpulse":
        st["glow"] = 0.35 + 0.65 * (0.5 - 0.5 * math.cos(2 * math.pi * t / 1.2))
    fade = 0.0 if tau < 0 else min(1.0, tau / FADE)
    st["alpha"] *= fade
    return st


def segment_times(anim: dict, appear: float, end: float) -> list[float]:
    """Границы отрезков (кратны 1/100 с — точность времени в ASS)."""
    kind = anim.get("type")
    sp = float(anim.get("speed", 5)) / 5
    if kind in STEP:
        step = STEP[kind] / sp
        times, n = [], 0
        while appear + n * step < end:
            times.append(round((appear + n * step) * 100) / 100)
            n += 1
        times.append(round(end * 100) / 100)
    else:
        times = [round(x / 100, 2) for x in range(round(appear * 100), round(end * 100), 5)]
        times.append(round(end * 100) / 100)
    out = []
    for x in times:  # убрать повторы после округления
        if not out or x > out[-1]:
            out.append(x)
    return out
