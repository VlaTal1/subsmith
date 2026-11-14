// Layout engine: turns a caption + look into absolutely placed words in video pixels.
//
// The browser is the single source of layout truth. The preview draws these placements
// in an SVG with the video's own coordinate system, and the server (app/ass.py) puts every
// word at the same coordinates in the ASS file — so preview and export match by design.

import { getLook, pickAccent } from "./looks.js";

const INDENT_EM = 5;

export const DEFAULT_STYLE = {
  v: 2,
  look: "editorial",
  size: 1, // multiplier on the look's base size
  colors: null, // { main, accent } — manual override
  autoColor: true, // accent picked from the video palette
  scene: null, // { hue, sat, lum } — video palette, see analyzeVideo()
  offset: { x: 0, y: 0 }, // all captions moved by dragging, % of the frame
  entrance: null, // null — the look's own
};

export function normalizeStyle(style) {
  if (!style || style.v !== 2) return { ...DEFAULT_STYLE };
  return { ...DEFAULT_STYLE, ...style, offset: { ...DEFAULT_STYLE.offset, ...(style.offset || {}) } };
}

// ------------------------------------------------------------------ text analysis

let STOP = new Set(), ATTACH = new Set();
export function setStopwords(data) {
  STOP = new Set(data.stop);
  ATTACH = new Set(data.attach);
}

const letters = (t) => (t.toLowerCase().match(/\p{L}/gu) || []).join("");
export const isStopword = (t) => STOP.has(letters(t));

// Accent words: those marked manually, otherwise the longest non-stopword
export function emphasisIndices(words) {
  const marked = words.map((w, i) => (w.em ? i : -1)).filter((i) => i >= 0);
  if (marked.length) return new Set(marked);
  const lengths = words.map((w) => letters(w.text).length);
  let cand = words.map((_, i) => i).filter((i) => !isStopword(words[i].text));
  if (!cand.length) cand = words.map((_, i) => i);
  let best = cand[0];
  for (const i of cand) if (lengths[i] > lengths[best]) best = i;
  return new Set([best]);
}

function* combinations(from, to, k, start = from, acc = []) {
  if (k === 0) { yield acc; return; }
  for (let i = start; i < to; i++) yield* combinations(from, to, k - 1, i + 1, [...acc, i]);
}

// Where to start lines: try every split and pick the most natural one. Breaking at a pause
// or after punctuation is good; a preposition at a line end or a lone stopword is bad;
// lines should be about equally long.
export function autoLineStarts(words, maxLines) {
  const n = words.length;
  if (n <= 1 || maxLines <= 1) return [0];
  const stop = words.map((w) => isStopword(w.text));
  const attach = words.map((w) => ATTACH.has(letters(w.text)));
  const chars = words.map((w) => w.text.length);
  let bestCost = null, best = [0];
  const full = Math.min(maxLines, n);
  for (let lines = 1; lines <= full; lines++) {
    for (const cuts of combinations(1, n, lines - 1)) {
      const starts = [0, ...cuts];
      let cost = (full - lines) * 3.0;
      for (const b of cuts) {
        const prev = words[b - 1], cur = words[b];
        if (attach[b - 1]) cost += 5.0;
        if (",.!?…:;—–".includes(prev.text.trimEnd().slice(-1))) cost -= 2.0;
        cost -= Math.min(Math.max(0, cur.start - prev.end), 1.0) * 4.0;
      }
      const bounds = [...starts, n];
      const lens = starts.map((a, li) => chars.slice(a, bounds[li + 1]).reduce((x, y) => x + y, 0) + (bounds[li + 1] - a - 1));
      const mean = lens.reduce((x, y) => x + y, 0) / lens.length;
      starts.forEach((a, li) => {
        if (bounds[li + 1] - a === 1 && stop[a]) cost += 6.0;
        cost += ((lens[li] - mean) / mean) ** 2 * 2.0;
      });
      if (bestCost === null || cost < bestCost - 1e-9) { bestCost = cost; best = starts; }
    }
  }
  return best;
}

export function applyCase(text, kase) {
  if (kase === "upper") return text.toUpperCase();
  if (kase === "lower") return text.toLowerCase();
  return text;
}

// ------------------------------------------------------------------ measuring

const canvas = document.createElement("canvas");
const mctx = canvas.getContext("2d");
const widthCache = new Map();

function measure(text, font, em, spacing) {
  const key = `${font}|${em.toFixed(2)}|${spacing.toFixed(2)}|${text}`;
  let w = widthCache.get(key);
  if (w === undefined) {
    mctx.font = `${em}px "sub-${font}"`;
    mctx.letterSpacing = `${spacing}px`;
    w = mctx.measureText(text).width;
    if (widthCache.size > 5000) widthCache.clear();
    widthCache.set(key, w);
  }
  return w;
}

// ------------------------------------------------------------------ style resolution

export function resolveColors(look, style) {
  const main = style.colors?.main || look.palette.main;
  const accent = style.colors?.accent || (style.autoColor && style.scene ? pickAccent(look, style.scene) : look.palette.accent);
  return { main, accent };
}

function colorOf(key, colors) {
  if (!key || key === "main") return colors.main;
  if (key === "accent") return colors.accent;
  return key;
}

function chooseVariant(look, n, index) {
  const fits = look.variants.filter((v) => (v.min ?? 1) <= n && n <= (v.max ?? Infinity));
  if (!fits.length) return look.variants[look.variants.length - 1];
  return fits[index % fits.length];
}

// Lines of the caption: [{ words: [indexes], spec: { role, align, indent, lead } }]
function splitLines(variant, words, roleOf) {
  const n = words.length;
  const idx = (a, z) => Array.from({ length: z - a }, (_, i) => a + i);
  const manual = words.map((w, i) => (i > 0 && w.br ? i : -1)).filter((i) => i > 0);

  if (variant.split === "stack") {
    let specs = variant.lines.slice();
    const k = manual.length ? manual.length + 1 : Math.min(specs.length, n);
    for (const d of variant.drop || []) if (specs.length > k) specs.splice(d, 1);
    specs = specs.slice(0, Math.max(k, 1));
    const starts = manual.length ? [0, ...manual] : autoLineStarts(words, specs.length);
    const bounds = [...starts, n];
    return starts.map((a, li) => ({ words: idx(a, bounds[li + 1]), spec: specs[li % specs.length] }));
  }

  if (variant.split === "accent") {
    const em = [...emphasisIndices(words)].sort((a, b) => a - b);
    const a0 = em[0], a1 = em[em.length - 1];
    const [sBefore, sAccent, sAfter] = variant.lines;
    const out = [];
    const before = idx(0, a0);
    if (before.length > 3) {
      const st = autoLineStarts(before.map((i) => words[i]), 2);
      out.push({ words: before.slice(0, st[1] ?? before.length), spec: sBefore });
      if (st[1]) out.push({ words: before.slice(st[1]), spec: { ...sBefore, indent: (sBefore.indent || 0) + 0.08, lead: 1.0 } });
    } else if (before.length) out.push({ words: before, spec: sBefore });
    out.push({ words: idx(a0, a1 + 1), spec: out.length ? sAccent : { ...sAccent, lead: 1 } });
    const after = idx(a1 + 1, n);
    if (after.length) out.push({ words: after, spec: sAfter || sBefore });
    return out;
  }

  // inline: one line of base words with accent words in their own role; wraps if too long
  const starts = manual.length ? [0, ...manual] : [0];
  const bounds = [...starts, n];
  const spec = { role: variant.base, align: "center", lead: variant.lead ?? 1.1 };
  return starts.map((a, li) => ({ words: idx(a, bounds[li + 1]), spec, inline: !manual.length }));
}

// ------------------------------------------------------------------ main entry

// fonts: { [name]: { cssScale, asc, desc } } from /api/fonts
// Returns { words: [...], box: {x, y, w, h}, entrance, hold } in video pixels.
export function layoutCaption(cap, { style, W, H, fonts, index = 0 }) {
  const look = getLook(style.look);
  const colors = resolveColors(look, style);
  const words = cap.words.filter((w) => w.text.trim());
  const n = words.length;
  if (!n) return null;
  const variant = chooseVariant(look, n, index);
  const em = new Set(variant.split === "inline" && variant.base === variant.accent ? [] : emphasisIndices(words));
  const lastChar = words[n - 1].text.trim().slice(-1);
  const punch = lastChar === "!" || lastChar === "?" ? 1.08 : 1;
  const baseEm = (H * look.base * style.size * (cap.scale || 1)) / 100 * (variant.scale || 1);
  const scene = style.scene;
  const haloBoost = scene && scene.lum > 0.55 ? 1.35 : 1;

  const roleFor = (i, line) => {
    if (variant.split === "inline") return look.roles[em.has(i) ? variant.accent : variant.base];
    return look.roles[line.spec.role];
  };

  // available width: slot-aware, so blocks pinned to a side don't run off the frame
  const slot = look.place.slots[index % look.place.slots.length];
  const anchor = cap.pos ? { x: cap.pos.x, y: cap.pos.y, align: slot.align } : {
    x: slot.x + (style.offset?.x || 0), y: slot.y + (style.offset?.y || 0), align: slot.align,
  };
  const margin = W * 0.04;
  const ax = (anchor.x / 100) * W;
  const sideRoom = anchor.align === "left" ? W - ax - margin : anchor.align === "right" ? ax - margin : 2 * Math.min(ax - margin, W - ax - margin);
  const avail = Math.max(W * 0.25, Math.min(sideRoom, (W * (look.place.maxWidth ?? 88)) / 100));

  const build = (lines, scale) => {
    // words of each line: measure with their roles
    const built = lines.map((line) => {
      const items = line.words.map((i) => {
        const role = roleFor(i, line);
        const wEm = baseEm * scale * role.size * (em.has(i) && role !== look.roles[variant.base] ? punch : 1);
        const text = applyCase(words[i].text.trim(), role.case);
        const spacing = (role.spacing || 0) * wEm;
        return { i, role, em: wEm, text, spacing, w: measure(text, role.font, wEm, spacing) };
      });
      let x = 0;
      items.forEach((it, k) => {
        if (k) {
          const prev = items[k - 1];
          const space = (measure(" ", prev.role.font, prev.em, 0) + measure(" ", it.role.font, it.em, 0)) / 2;
          // tracked (letter-spaced) words need a wider word space too
          x += space + (prev.spacing + it.spacing) / 2 + (prev.role.gap || 0) * prev.em + (it.role.gap || 0) * it.em;
        }
        it.dx = x;
        x += it.w;
      });
        const maxEm = Math.max(...items.map((it) => it.em));
      const indent = (line.spec.indent || 0) * INDENT_EM * baseEm * scale;
      return { items, width: x, maxEm, spec: line.spec, indent };
    });
    const blockW = Math.max(...built.map((l) => l.width + l.indent));
    return { built, blockW };
  };

  let lines = splitLines(variant, words, roleFor);
  let scale = 1;
  let res = build(lines, scale);
  // too wide: wrap the widest multi-word line first, shrink only when wrapping can't help
  for (let guard = 0; res.blockW > avail && guard < 4; guard++) {
    // only the line that sets the width is worth wrapping; never leave a word alone for width's sake
    const k = res.built.reduce((best, l, q) => (l.width + l.indent > res.built[best].width + res.built[best].indent ? q : best), 0);
    if (lines[k].words.length < 3 || lines.length >= 4) break;
    const line = lines[k];
    const st = autoLineStarts(line.words.map((i) => words[i]), 2);
    const cut = st[1] ?? Math.ceil(line.words.length / 2);
    const spec2 = line.inline ? line.spec : { ...line.spec, indent: (line.spec.indent || 0) + 0.08, lead: 1.0 };
    lines = [...lines.slice(0, k), { ...line, words: line.words.slice(0, cut) },
      { ...line, words: line.words.slice(cut), spec: spec2 }, ...lines.slice(k + 1)];
    res = build(lines, scale);
  }
  if (res.blockW > avail) {
    scale = avail / res.blockW;
    res = build(lines, scale);
  }
  const { built, blockW } = res;

  // vertical rhythm: the next baseline is the previous line's descent plus `lead` cap-heights below
  let y = 0;
  built.forEach((l, k) => {
    if (k) y += 0.24 * built[k - 1].maxEm + (l.spec.lead ?? 1) * 0.8 * l.maxEm;
    l.baseline = y;
  });
  const top = -0.82 * built[0].maxEm;
  const bottom = y + 0.26 * built[built.length - 1].maxEm;
  const blockH = bottom - top;

  // block position: bottom edge at anchor.y% from the frame bottom
  let left = anchor.align === "left" ? ax : anchor.align === "right" ? ax - blockW : ax - blockW / 2;
  left = Math.max(margin * 0.5, Math.min(W - margin * 0.5 - blockW, left));
  let blockBottom = H * (1 - anchor.y / 100);
  blockBottom = Math.max(blockH + H * 0.02, Math.min(H - H * 0.02, blockBottom));
  const originY = blockBottom - bottom;

  const out = [];
  for (const l of built) {
    const indent = l.indent;
    const align = l.spec.align || "center";
    const lx = align === "left" ? indent : align === "right" ? blockW - l.width - indent : (blockW - l.width) / 2 + indent;
    for (const it of l.items) {
      const role = it.role;
      const font = fonts[role.font] || { cssScale: 0.7, asc: 0.8, desc: 0.2 };
      const x = left + lx + it.dx;
      const base = originY + l.baseline + (role.shift || 0) * it.em;
      const halo = role.halo === false || !look.halo ? null : {
        color: look.halo.color,
        width: look.halo.width * it.em,
        blur: look.halo.blur * it.em,
        alpha: Math.min(0.85, look.halo.alpha * haloBoost),
      };
      let fx = role.fx ? { ...role.fx, color: role.fx.color || colors.accent } : null;
      let haloOut = halo;
      if (fx?.type === "glow") {
        // glow = a colored halo
        const st = fx.strength ?? 5;
        haloOut = { color: fx.color, width: 0.02 * it.em, blur: (0.14 + 0.025 * st) * it.em, alpha: 0.6 };
        fx = null;
      }
      out.push({
        j: it.i,
        text: it.text,
        font: role.font,
        em: r1(it.em),
        fs: r1(it.em / font.cssScale), // libass size: winAscent + winDescent
        x: r1(x),
        cx: r1(x + it.w / 2),
        y: r1(base), // baseline
        w: r1(it.w),
        spacing: r1(it.spacing),
        color: colorOf(role.color, colors),
        active: role.active ? colorOf(role.active, colors) : null,
        opacity: role.opacity ?? 1,
        halo: haloOut && { ...haloOut, width: r1(haloOut.width), blur: r1(haloOut.blur) },
        outline: look.outline && role.outline !== false ? { color: look.outline.color, width: r1(look.outline.width * it.em) } : null,
        fx,
        anim: role.anim || null,
        appear: it.i === 0 ? cap.start : Math.min(Math.max(words[it.i].start, cap.start), cap.end - 0.05),
        box: [r1(x), r1(base - 0.8 * it.em), r1(it.w), r1(it.em)],
      });
    }
  }
  out.sort((a, b) => a.j - b.j);
  return {
    words: out,
    box: { x: r1(left), y: r1(originY + top), w: r1(blockW), h: r1(blockH) },
    entrance: style.entrance || look.entrance,
    hold: !!look.hold,
  };
}

const r1 = (v) => Math.round(v * 10) / 10;
// line indent unit: `indent: 0.2` shifts a line by one base em

// When each caption is on screen. Looks with `hold` keep a caption until the next one ends,
// so two captions share the frame (placed on alternate sides).
export function visibleRanges(captions, style) {
  const look = getLook(style.look);
  return captions.map((c, i) => {
    let end = c.end;
    if (look.hold && captions[i + 1]) end = Math.max(c.end, captions[i + 1].end);
    return [c.start, end];
  });
}

// Layout of every caption, for the export
export function layoutAll(captions, opts) {
  const ranges = visibleRanges(captions, opts.style);
  return captions.map((cap, i) => {
    const lay = layoutCaption(cap, { ...opts, index: i });
    return lay ? { ...cap, place: { ...lay, until: ranges[i][1] } } : cap;
  });
}
