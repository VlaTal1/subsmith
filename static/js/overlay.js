// Live subtitle preview over the video, drawn in an SVG whose viewBox is the video's
// pixel grid. Word placements come from layout.js; timing and effects mirror app/ass.py
// (entrance, active word, halo, marker/particles/sparkles, word animations).

import { layoutCaption, visibleRanges } from "./layout.js";

const SVG = "http://www.w3.org/2000/svg";
// Gaussian sigma for an ASS \blur of 1 (calibrated against libass renders)
export const BLUR_SIGMA = 0.85;

const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};
const clamp01 = (v) => Math.max(0, Math.min(1, v));

export function findCaption(captions, t) {
  // captions are sorted by time — binary search
  let lo = 0, hi = captions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = captions[mid];
    if (t < c.start) hi = mid - 1;
    else if (t >= c.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

// Word entrance: same curves as _entrance() in app/ass.py
export const ENTRANCE = {
  none: { fade: 0, rise: 0, pop: 0 },
  fade: { fade: 0.2, rise: 0, pop: 0 },
  rise: { fade: 0.2, rise: 0.25, pop: 0 },
  pop: { fade: 0, rise: 0, pop: 0.12 },
};

export class SubtitleOverlay {
  constructor(layer) {
    this.layer = layer;
    this.svg = el("svg", { class: "sub-svg", preserveAspectRatio: "none" });
    this.defs = el("defs", {}, this.svg);
    this.root = el("g", {}, this.svg);
    layer.appendChild(this.svg);
    this.fonts = {};
    this.blocks = new Map(); // caption index → rendered block
    this.selected = -1;
    this.filters = new Map();
  }

  setFonts(list) {
    for (const f of list) this.fonts[f.name] = f;
  }

  configure({ style, width, height }) {
    this.style = style;
    this.W = width;
    this.H = height;
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.clear();
  }

  // The selected caption shows its frame and resize handle
  setSelected(i) {
    this.selected = i;
    for (const [k, b] of this.blocks) b.g.classList.toggle("selected", k === i);
  }

  clear() {
    for (const b of this.blocks.values()) b.g.remove();
    this.blocks.clear();
    this.ranges = null;
  }

  // Layout of caption i, as the export computes it
  layout(captions, i) {
    return layoutCaption(captions[i], { style: this.style, W: this.W, H: this.H, fonts: this.fonts, index: i });
  }

  update(captions, t) {
    if (!this.style) return;
    if (!this.ranges || this.ranges.length !== captions.length || this.rangesFor !== captions) {
      this.ranges = visibleRanges(captions, this.style);
      this.rangesFor = captions;
    }
    const visible = new Set();
    this.ranges.forEach(([a, b], i) => { if (t >= a && t < b) visible.add(i); });
    for (const [i, b] of this.blocks) {
      const cap = captions[i];
      if (!visible.has(i) || !cap || b.key !== blockKey(cap)) { b.g.remove(); this.blocks.delete(i); }
    }
    for (const i of visible) {
      let b = this.blocks.get(i);
      if (!b) {
        const lay = this.layout(captions, i);
        if (!lay) continue;
        b = this.renderBlock(captions[i], i, lay);
        this.blocks.set(i, b);
      }
      this.animate(b, t);
    }
  }

  blurFilter(sigma) {
    const key = sigma.toFixed(1);
    if (!this.filters.has(key)) {
      const id = `blur-${this.filters.size}`;
      const f = el("filter", { id, x: "-50%", y: "-50%", width: "200%", height: "200%" }, this.defs);
      el("feGaussianBlur", { stdDeviation: key }, f);
      this.filters.set(key, id);
    }
    return `url(#${this.filters.get(key)})`;
  }

  renderBlock(cap, i, lay) {
    const g = el("g", { class: "sub-block", "data-i": i }, this.root);
    el("rect", { class: "sub-hit", x: lay.box.x, y: lay.box.y, width: lay.box.w, height: lay.box.h }, g);
    g.classList.toggle("own-pos", !!cap.pos || !!cap.scale);
    g.classList.toggle("selected", i === this.selected);
    const under = el("g", {}, g); // markers sit under the text
    const words = el("g", {}, g);
    const over = el("g", {}, g); // particles and sparkles on top
    const k = this.H / 1080;
    const items = lay.words.map((w, n) => {
      const font = this.fonts[w.font] || { asc: 0.8, desc: 0.2 };
      const wg = el("g", {}, words);
      const textAttrs = {
        x: w.cx, y: w.y, "text-anchor": "middle", "font-family": `"sub-${w.font}"`, "font-size": w.em,
        style: w.spacing ? `letter-spacing:${w.spacing}px` : "",
      };
      if (w.halo) {
        const h = el("text", { ...textAttrs, fill: w.halo.color, stroke: w.halo.color, "stroke-width": 2 * w.halo.width,
          "stroke-linejoin": "round", opacity: w.halo.alpha }, wg);
        if (w.halo.blur > 0) h.setAttribute("filter", this.blurFilter(w.halo.blur * BLUR_SIGMA));
        h.textContent = w.text;
      }
      const t = el("text", { ...textAttrs, fill: w.color }, wg);
      if (w.outline) {
        t.setAttribute("stroke", w.outline.color);
        t.setAttribute("stroke-width", 2 * w.outline.width);
        t.setAttribute("stroke-linejoin", "round");
        t.setAttribute("paint-order", "stroke");
      }
      t.textContent = w.text;
      const next = lay.words[n + 1];
      const item = {
        w, wg, text: t, appear: w.appear, until: next ? next.appear : cap.end,
        // pop scales from the bottom-center of the libass line box (\an2), animations turn around its center (\an5)
        origin: [w.cx, w.y + font.desc * w.fs], center: [w.cx, w.y + ((font.desc - font.asc) / 2) * w.fs],
        seed: Math.floor(cap.start * 1000 + 0.5) * 31 + w.j + 17, fx: [],
      };
      const fx = w.fx;
      if (fx && BARS.includes(fx.type)) item.fx.push(this.addBar(under, w, k));
      if (fx?.type === "sparkle") item.fx.push(...this.addSparkles(over, cap, w));
      if (fx && PARTICLES.includes(fx.type)) item.fx.push(...this.addParticles(over, cap, w, k));
      return item;
    });
    // resize handle on the bottom-right corner, drawn above the words
    // fingers need a bigger target than a mouse pointer
    const touch = matchMedia("(hover: none)").matches;
    el("circle", { class: "sub-resize", cx: lay.box.x + lay.box.w, cy: lay.box.y + lay.box.h, r: this.H * (touch ? 0.03 : 0.016) }, g);
    return { g, key: blockKey(cap), lay, items, end: cap.end, entrance: ENTRANCE[lay.entrance] || ENTRANCE.none };
  }

  animate(b, t) {
    for (const it of b.items) {
      const e = it.w.anim ? ENTRANCE.none : b.entrance; // animated words fade in by themselves
      const dt = t - it.appear;
      const shown = dt >= 0;
      let alpha = shown ? (e.fade ? clamp01(dt / e.fade) : 1) : 0;
      const tf = [];
      if (shown && e.rise) tf.push(`translate(0 ${(0.3 * it.w.em * (1 - clamp01(dt / e.rise))).toFixed(2)})`);
      if (shown && e.pop) {
        const s = 0.7 + 0.3 * clamp01(dt / e.pop);
        tf.push(scaleAt(it.origin, s));
      }
      if (it.w.anim && shown) {
        const st = animState(it.w.anim, dt, it.seed);
        const [cx, cy] = it.center;
        const h = it.w.box[3];
        tf.push(`translate(${st.dx * h} ${st.dy * h}) rotate(${st.rot} ${cx} ${cy}) ${scaleAt([cx, cy], st.scale)}`);
        alpha *= st.alpha;
        if (st.color) it.text.setAttribute("fill", st.color);
      }
      it.wg.setAttribute("transform", tf.join(" "));
      it.wg.setAttribute("opacity", (alpha * it.w.opacity).toFixed(3));
      if (it.w.active) {
        const on = t >= it.appear && t < it.until;
        it.text.setAttribute("fill", on ? it.w.active : it.w.color);
      }
      for (const f of it.fx) f(t);
    }
  }

  addBar(parent, word, k) {
    const [x, y, w, h] = word.box;
    const fx = word.fx;
    const st = fx.strength ?? 5;
    const marker = fx.type === "marker";
    const bw = w * (marker ? 1.04 : 1.02), bh = h * (marker ? 0.42 : 0.04 + 0.006 * st), yc = marker ? 0.72 : 0.97;
    const r = el("rect", { x: x - (bw - w) / 2, y: y + yc * h - bh / 2, width: bw, height: bh, fill: fx.color,
      filter: this.blurFilter(0.6 * k * BLUR_SIGMA) }, parent);
    const alpha = marker ? 0.25 + 0.05 * st : 1;
    const x0 = x - (bw - w) / 2;
    return (t) => {
      const p = clamp01((t - word.appear) / 0.25);
      r.setAttribute("opacity", t < word.appear ? 0 : alpha);
      r.setAttribute("transform", `translate(${x0} 0) scale(${Math.max(p, 1e-4)} 1) translate(${-x0} 0)`);
    };
  }

  addSparkles(parent, cap, word) {
    const [x, y, w, h] = word.box;
    const { fx, appear } = word;
    return sparkleStars(cap.start, word.j, fx.strength ?? 5).map((st) => {
      const r = (st.size * h) / 2;
      const p = el("path", { d: starPath(r), fill: fx.color || "#FFFFFF", opacity: 0 }, parent);
      const cx = x + st.x * w, cy = y + st.y * h;
      const start = appear + st.delay;
      return (t) => {
        let v = 0;
        if (t >= start && t < cap.end) {
          const d = st.period * 0.6;
          const phase = (t - start) % st.period;
          if (phase < d) { const q = phase / d; v = q < 0.5 ? q * 2 : (1 - q) * 2; }
        }
        p.setAttribute("opacity", v);
        p.setAttribute("transform", `translate(${cx} ${cy}) rotate(${st.rot}) scale(${0.3 + 0.7 * v})`);
      };
    });
  }

  addParticles(parent, cap, word, k) {
    const [bx, by, w, h] = word.box;
    const { fx, appear } = word;
    const seed = Math.floor(cap.start * 1000 + 0.5) * 31 + word.j + 101;
    const slots = particleSlots(fx.type, seed, fx.strength ?? 5);
    return slots.map((slot, i) => {
      const pg = el("g", {}, parent); // blur lives on an untransformed group, so its radius is in video px
      const p = el("path", { opacity: 0 }, pg);
      const cache = {};
      let shape = null;
      return (t) => {
        const start = appear + slot.delay;
        const n = Math.floor((t - start) / slot.period);
        const t0 = start + n * slot.period;
        let visible = n >= 0 && t0 < cap.end - 0.02 && t < cap.end && !(fx.type === "burst" && n > 0);
        let c = null;
        if (visible) {
          c = cache[n] || (cache[n] = particleCycle(fx.type, seed, i, n, slots.length));
          if (t - t0 > c.L) visible = false;
        }
        if (!visible) { p.setAttribute("opacity", 0); return; }
        const u = (t - t0) / c.L;
        const r = (c.size * h) / 2;
        const color = c.color || fx.color;
        if (shape !== c.shape) { p.setAttribute("d", shapePath(SHAPES[c.shape])); shape = c.shape; }
        if (c.ring) {
          p.setAttribute("fill", "none");
          p.setAttribute("stroke", color);
          p.setAttribute("stroke-width", (2 * Math.max(1, r * 0.18)) / r);
        } else {
          p.setAttribute("fill", color);
          p.setAttribute("stroke", "none");
        }
        const x = bx + (c.x0 + (c.x1 - c.x0) * u) * w;
        const y = by + (c.y0 + (c.y1 - c.y0) * u) * h;
        const sc = lerp3(c.scale, u) * r, rot = c.rot0 + (c.rot1 - c.rot0) * u;
        p.setAttribute("transform", `translate(${x} ${y}) rotate(${rot}) scale(${sc})`);
        p.setAttribute("opacity", lerp3(c.alpha, u));
        if (!pg.hasAttribute("filter") && c.blur) pg.setAttribute("filter", this.blurFilter(c.blur * k * BLUR_SIGMA));
      };
    });
  }
}

function blockKey(cap) {
  return JSON.stringify([cap.start, cap.end, cap.pos, cap.scale, cap.words.map((w) => [w.text, w.start, w.em, w.br])]);
}

function scaleAt([x, y], s) {
  return `translate(${x} ${y}) scale(${s}) translate(${-x} ${-y})`;
}

function starPath(r) {
  return shapePath(SHAPES.star.map(([x, y]) => [x * r, y * r]));
}

function shapePath(pts) {
  return "M" + pts.map(([x, y]) => `${x} ${y}`).join(" L") + " Z";
}

// ------------------------------------------------------------------ effects math (same as app/anim.py, app/particles.py)

export function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sparkleStars(start, j, strength) {
  const rnd = mulberry32(Math.floor(start * 1000 + 0.5) * 31 + j);
  const stars = [];
  for (let n = 0; n < 2 + Math.floor(strength + 0.5); n++) {
    stars.push({
      x: -0.15 + rnd() * 1.3,
      y: -0.25 + rnd() * 1.5,
      size: 0.22 + rnd() * 0.25,
      rot: rnd() * 40 - 20,
      delay: rnd() * 0.9,
      period: 0.8 + rnd() * 0.7,
    });
  }
  return stars;
}

const ANIM_STEP = { shake: 0.07, flicker: 0.06 };

function hslHex(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return "#" + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}

function lerpKeys(keys, u) {
  if (u <= keys[0][0]) return keys[0][1];
  for (let i = 0; i + 1 < keys.length; i++) {
    const [u0, v0] = keys[i], [u1, v1] = keys[i + 1];
    if (u <= u1) return v0 + ((v1 - v0) * (u - u0)) / (u1 - u0);
  }
  return keys[keys.length - 1][1];
}

export function animState(anim, tau, seed) {
  const a = (anim.strength ?? 5) / 5;
  const sp = (anim.speed ?? 5) / 5;
  const t = tau * sp;
  const st = { dx: 0, dy: 0, scale: 1, rot: 0, alpha: 1, color: null, glow: null };
  switch (anim.type) {
    case "pulse": st.scale = 1 + 0.08 * a * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 1.0)); break;
    case "float": st.dy = -0.06 * a * Math.sin((2 * Math.PI * t) / 1.4); break;
    case "swing": st.rot = 6 * a * Math.sin((2 * Math.PI * t) / 1.2); break;
    case "shake": {
      const rnd = mulberry32(seed + Math.floor(t / ANIM_STEP.shake) * 2654435761);
      st.dx = 0.03 * a * (rnd() * 2 - 1);
      st.dy = 0.03 * a * (rnd() * 2 - 1);
      break;
    }
    case "flicker": {
      const rnd = mulberry32(seed + Math.floor(t / ANIM_STEP.flicker) * 2654435761);
      st.alpha = rnd() < 0.05 * a + 0.03 ? 0.25 : 1;
      break;
    }
    case "rainbow": st.color = hslHex(((t / 3.0) * 360) % 360, 0.9, 0.65); break;
    case "bounce": st.scale = lerpKeys([[0, 0.3], [0.12, 1 + 0.25 * a], [0.3, 1 - 0.06 * a], [0.42, 1]], t); break;
    case "glowpulse": st.glow = 0.35 + 0.65 * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 1.2)); break;
  }
  st.alpha *= tau < 0 ? 0 : Math.min(1, tau / 0.18);
  return st;
}

export const PARTICLES = ["hearts", "confetti", "fireflies", "bubbles", "snow", "burst"];
export const BARS = ["marker", "underline"];
const CONFETTI = ["#FF3EA5", "#FFE45C", "#22D3EE", "#A3E635", "#A78BFA", "#FB923C"];

function polygon(points) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  const k = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2;
  return points.map(([x, y]) => [Math.round(((x - cx) / k) * 1e4) / 1e4, Math.round(((y - cy) / k) * 1e4) / 1e4]);
}

const SHAPES = {
  star: [[0, -1], [0.2, -0.2], [1, 0], [0.2, 0.2], [0, 1], [-0.2, 0.2], [-1, 0], [-0.2, -0.2]],
  dot: polygon(Array.from({ length: 16 }, (_, i) => [Math.cos((i * Math.PI) / 8), Math.sin((i * Math.PI) / 8)])),
  heart: polygon(Array.from({ length: 28 }, (_, i) => {
    const t = (i * 2 * Math.PI) / 28;
    return [16 * Math.sin(t) ** 3, -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))];
  })),
  rect: [[-1, -0.5], [1, -0.5], [1, 0.5], [-1, 0.5]],
  ray: [[-1, -0.09], [1, -0.09], [1, 0.09], [-1, 0.09]],
};

const SLOT_TIMING = {
  hearts: [1.2, 1.3, 0.8], confetti: [0.6, 1.0, 0.6], fireflies: [1.5, 1.6, 1.0], bubbles: [1.2, 1.4, 0.8], snow: [1.5, 1.6, 1.2],
};

export function particleSlots(kind, seed, strength) {
  const rnd = mulberry32(seed);
  if (kind === "burst") return Array.from({ length: 8 + Math.floor(strength + 0.5) }, () => ({ delay: 0, period: 1e9 }));
  const n = 2 + Math.floor(strength * 0.8 + 0.5);
  const [dk, base, extra] = SLOT_TIMING[kind];
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = rnd() * dk;
    out.push({ delay: d, period: base + rnd() * extra });
  }
  return out;
}

export function particleCycle(kind, seed, i, n, count) {
  const rnd = mulberry32(seed + i * 7919 + n * 104729);
  const p = { shape: "dot", color: null, rot0: 0, rot1: 0, alpha: [0, 1, 0], scale: [1, 1, 1], blur: 0.5, ring: false };
  if (kind === "hearts") {
    p.L = 1.2 + rnd() * 0.4; p.x0 = 0.1 + rnd() * 0.8; p.y0 = 0.9 + rnd() * 0.2;
    p.x1 = p.x0 + (rnd() - 0.5) * 0.4; p.y1 = p.y0 - (0.9 + rnd() * 0.6); p.size = 0.28 + rnd() * 0.18;
    p.rot0 = (rnd() - 0.5) * 30;
    p.rot1 = p.rot0 + (rnd() - 0.5) * 30;
    p.shape = "heart"; p.scale = [0.5, 1, 0.8];
  } else if (kind === "confetti") {
    p.L = 1.0 + rnd() * 0.4; p.x0 = -0.1 + rnd() * 1.2; p.y0 = -0.5 - rnd() * 0.3;
    p.x1 = p.x0 + (rnd() - 0.5) * 0.5; p.y1 = 1.3 + rnd() * 0.4; p.size = 0.12 + rnd() * 0.08;
    p.rot0 = rnd() * 360;
    p.rot1 = p.rot0 + 180 + rnd() * 360;
    p.shape = "rect"; p.color = CONFETTI[Math.floor(rnd() * 6)]; p.alpha = [1, 1, 0]; p.blur = 0;
  } else if (kind === "fireflies") {
    p.L = 1.4 + rnd() * 0.6; p.x0 = -0.1 + rnd() * 1.2; p.y0 = -0.2 + rnd() * 1.4;
    p.x1 = p.x0 + (rnd() - 0.5) * 0.5; p.y1 = p.y0 + (rnd() - 0.5) * 0.5 - 0.15; p.size = 0.07 + rnd() * 0.06;
    p.scale = [0.6, 1.2, 0.6]; p.blur = 3;
  } else if (kind === "bubbles") {
    p.L = 1.3 + rnd() * 0.5; p.x0 = rnd(); p.y0 = 1.0 + rnd() * 0.2;
    p.x1 = p.x0 + (rnd() - 0.5) * 0.3; p.y1 = -0.4 - rnd() * 0.5; p.size = 0.12 + rnd() * 0.14;
    p.alpha = [0, 0.9, 0]; p.scale = [0.5, 1, 1.1]; p.ring = true; p.blur = 0.4;
  } else if (kind === "snow") {
    p.L = 1.6 + rnd() * 0.8; p.x0 = -0.2 + rnd() * 1.4; p.y0 = -0.6 - rnd() * 0.2;
    p.x1 = p.x0 + (rnd() - 0.5) * 0.4; p.y1 = 1.4 + rnd() * 0.3; p.size = 0.06 + rnd() * 0.06; p.blur = 1;
  } else if (kind === "burst") {
    const ang = (i / count) * 360 + (rnd() - 0.5) * 12;
    const c = Math.cos((ang * Math.PI) / 180), s = Math.sin((ang * Math.PI) / 180);
    p.L = 0.45; p.x0 = 0.5 + c * 0.55; p.y0 = 0.5 + s * 0.75; p.x1 = 0.5 + c * 0.8; p.y1 = 0.5 + s * 1.3;
    p.size = 0.35 + rnd() * 0.15; p.rot0 = p.rot1 = ang; p.shape = "ray"; p.alpha = [1, 0.8, 0]; p.scale = [1, 1, 0.6]; p.blur = 0.6;
  }
  return p;
}

function lerp3([a, b, c], u) {
  return u < 0.5 ? a + (b - a) * (u / 0.5) : b + (c - b) * ((u - 0.5) / 0.5);
}
