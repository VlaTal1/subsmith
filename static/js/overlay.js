// Живой предпросмотр субтитров поверх видео. Повторяет логику app/ass.py,
// чтобы в браузере было видно то же, что получится после экспорта.

export const DEFAULT_STYLE = {
  preset: "highlight",
  font: "Montserrat",
  fontSize: 6.5,
  uppercase: true,
  color: "#FFFFFF",
  highlightColor: "#FFE600",
  outlineColor: "#000000",
  outline: 6,
  shadow: 0,
  boxColor: "#000000",
  boxOpacity: 0.6,
  position: 22,
  maxWidth: 84,
  animation: "pop",
  wordScale: 1.12,
  x: 50,
  lineSpacing: 1,
  reveal: false,
  combo: "elegant",
  comboDef: null,
};

export const PRESETS = [
  { id: "highlight", name: "Подсветка слова", sample: "Цвет активного слова",
    style: { preset: "highlight", uppercase: true, highlightColor: "#FFE600", wordScale: 1.12, animation: "pop", outline: 6 } },
  { id: "wordbox", name: "Плашка на слове", sample: "Фон под активным словом",
    style: { preset: "wordbox", uppercase: true, highlightColor: "#8B5CF6", wordScale: 1.0, animation: "pop" } },
  { id: "karaoke", name: "Караоке", sample: "Плавная заливка",
    style: { preset: "karaoke", uppercase: true, highlightColor: "#22D3EE", animation: "none", outline: 6 } },
  { id: "pop", name: "По одному слову", sample: "Крупно, по слову",
    style: { preset: "pop", uppercase: true, animation: "pop", outline: 8 } },
  { id: "classic", name: "Классика", sample: "Белый с обводкой",
    style: { preset: "classic", uppercase: false, outline: 5, animation: "none" } },
  { id: "box", name: "На подложке", sample: "Текст на плашке",
    style: { preset: "box", uppercase: false, boxColor: "#000000", boxOpacity: 0.65, animation: "fade" } },
];

export function contrastText(hex) {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#000000" : "#FFFFFF";
}

export function hexToRgba(hex, a) {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${a})`;
}

// Обводка через кольцо text-shadow — одинаково выглядит во всех браузерах.
function outlineShadow(px, color, shadowPx, shadowColor) {
  const parts = [];
  if (px > 0.2) {
    const steps = Math.max(12, Math.ceil(px * 6));
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      parts.push(`${(Math.cos(a) * px).toFixed(2)}px ${(Math.sin(a) * px).toFixed(2)}px 0 ${color}`);
    }
  }
  if (shadowPx > 0.2) parts.push(`${shadowPx}px ${shadowPx}px ${Math.max(px, 1)}px ${shadowColor}`);
  return parts.join(",") || "none";
}

export function findCaption(captions, t) {
  // captions отсортированы по времени — бинарный поиск
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

function activeWord(cap, t) {
  const ws = cap.words;
  for (let i = ws.length - 1; i >= 0; i--) if (i === 0 || t >= ws[i].start) return i;
  return 0;
}

export class SubtitleOverlay {
  constructor(layer) {
    this.layer = layer;
    this.block = document.createElement("div");
    this.block.className = "sub-block";
    this.layer.appendChild(this.block);
    this.key = null;
    this.fonts = {};
  }

  setFonts(list) {
    for (const f of list) this.fonts[f.name] = f;
  }

  // Положение блока: у подписи может быть своя позиция (cap.pos), иначе — из стиля
  place(cap) {
    const s = this.style;
    const pos = cap.pos || { x: s.x, y: s.position };
    const box = blockBox(pos.x, pos.y, s.maxWidth);
    const b = this.block;
    b.style.left = `${box.left}%`;
    b.style.right = `${box.right}%`;
    b.style.bottom = `${box.bottom}%`;
    b.classList.toggle("own-pos", !!cap.pos);
  }

  setCombos(list) {
    this.combos = list;
  }

  configure({ style, width, height, displayHeight }) {
    this.style = { ...DEFAULT_STYLE, ...style };
    this.w = width;
    this.h = height;
    this.scale = displayHeight / height;
    this.key = null;
  }

  update(captions, t) {
    if (!this.style) return;
    const s = this.style;
    const idx = findCaption(captions, t);
    if (idx < 0) {
      if (this.key !== "none") this.block.innerHTML = "";
      this.key = "none";
      return;
    }
    const cap = captions[idx];
    if (!cap.words.length) return;
    const wi = activeWord(cap, t);
    const perWord = s.reveal || (s.preset !== "classic" && s.preset !== "box");
    const key = `${idx}:${perWord ? wi : 0}:${cap.words.map((w) => w.text).join(" ")}`;
    if (key !== this.key) {
      const newCaption = !this.key || this.key.split(":")[0] !== String(idx);
      this.render(cap, wi, newCaption);
      this.key = key;
    }
    if (s.preset === "karaoke") this.updateKaraoke(cap, t);
    if (this.stars?.length) this.updateStars(t);
    if (this.anims?.length) this.updateAnims(t);
    if (this.particles?.length) this.updateParticles(t);
    for (const b of this.bars || []) {
      b.el.style.opacity = t < b.appear ? 0 : b.alpha;
      b.el.style.transform = `scaleX(${Math.max(0, Math.min(1, (t - b.appear) / 0.25))})`;
    }
    // Появление слов (0,18 с) — по времени видео, а не по часам браузера: на паузе кадр как в рендере
    for (const f of this.fades || []) {
      f.span.style.opacity = t < f.appear ? 0 : Math.min(1, (t - f.appear) / 0.18) * f.opacity;
    }
  }

  updateAnims(t) {
    const s = this.style;
    for (const a of this.anims) {
      const st = animState(a.anim, t - a.appear, a.seed);
      const h = a.h || 0;
      a.span.style.transform = `translate(${st.dx * h}px, ${st.dy * h}px) rotate(${st.rot}deg) scale(${st.scale})`;
      a.span.style.opacity = st.alpha * a.opacity;
      if (st.color) a.span.style.color = st.color;
      if (st.glow !== null) {
        const fx = a.role.fx || {};
        const glow = { type: "glow", color: fx.color || s.highlightColor, strength: fx.type === "glow" ? fx.strength ?? 5 : 5 };
        a.span.style.textShadow = fxTextShadow(glow, a.unit * st.glow);
      }
    }
  }

  // Звёзды-блёстки вокруг слов; положение — доли рамки слова (как в app/ass.py)
  placeSparkles(cap, list) {
    const layerRect = this.layer.getBoundingClientRect();
    const blockRect = this.block.getBoundingClientRect();
    const range = document.createRange();
    for (const [j, span, role] of list) {
      const fx = role.fx || {};
      range.selectNodeContents(span);
      const r = range.getBoundingClientRect();
      this.lastFxBoxes[j] = [r.left - layerRect.left, r.top - layerRect.top, r.width, r.height];
      const an = this.anims.find((a) => a.span === span);
      if (an) an.h = r.height;
      const appear = j === 0 ? cap.start : cap.words[j].start;
      const bx = r.left - blockRect.left, by = r.top - blockRect.top;
      if (PARTICLES.includes(fx.type)) this.addParticles(cap, j, fx, appear, bx, by, r.width, r.height);
      if (BARS.includes(fx.type)) this.addBar(fx, appear, bx, by, r.width, r.height);
      if (fx.type !== "sparkle") continue;
      for (const st of sparkleStars(cap.start, j, fx.strength ?? 5)) {
        const el = document.createElement("div");
        el.className = "fx-star";
        const size = st.size * r.height;
        el.style.width = el.style.height = `${size}px`;
        el.style.left = `${r.left - blockRect.left + st.x * r.width}px`;
        el.style.top = `${r.top - blockRect.top + st.y * r.height}px`;
        el.style.background = fx.color || "#FFFFFF";
        el.style.opacity = 0;
        this.block.appendChild(el);
        this.stars.push({ el, rot: st.rot, start: appear + st.delay, period: st.period, end: cap.end });
      }
    }
  }

  addParticles(cap, j, fx, appear, bx, by, w, h) {
    const seed = Math.floor(cap.start * 1000 + 0.5) * 31 + j + 101;
    const slots = particleSlots(fx.type, seed, fx.strength ?? 5);
    const unit = (this.h / 1080) * this.scale;
    slots.forEach((slot, i) => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "-1 -1 2 2");
      svg.setAttribute("class", "fx-particle");
      svg.style.overflow = "visible";
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      svg.appendChild(path);
      svg.style.opacity = 0;
      this.block.appendChild(svg);
      this.particles.push({ svg, path, kind: fx.type, color: fx.color, seed, i, count: slots.length, slot,
        appear, end: cap.end, bx, by, w, h, unit, cache: {} });
    });
  }

  addBar(fx, appear, bx, by, w, h) {
    const st = fx.strength ?? 5;
    const marker = fx.type === "marker";
    const bw = w * (marker ? 1.04 : 1.02), bh = h * (marker ? 0.42 : 0.04 + 0.006 * st), yc = marker ? 0.72 : 0.97;
    const el = document.createElement("div");
    el.className = "fx-bar";
    Object.assign(el.style, {
      left: `${bx - (bw - w) / 2}px`, top: `${by + yc * h - bh / 2}px`, width: `${bw}px`, height: `${bh}px`,
      background: fx.color || this.style.highlightColor, filter: `blur(${0.6 * (this.h / 1080) * this.scale}px)`, opacity: 0,
    });
    this.block.appendChild(el);
    this.bars.push({ el, appear, alpha: marker ? 0.25 + 0.05 * st : 1 });
  }

  updateParticles(t) {
    for (const p of this.particles) {
      const start = p.appear + p.slot.delay;
      const n = Math.floor((t - start) / p.slot.period);
      const t0 = start + n * p.slot.period;
      let visible = n >= 0 && t0 < p.end - 0.02 && t < p.end && !(p.kind === "burst" && n > 0);
      let c = null;
      if (visible) {
        c = p.cache[n] || (p.cache[n] = particleCycle(p.kind, p.seed, p.i, n, p.count));
        if (t - t0 > c.L) visible = false;
      }
      if (!visible) { p.svg.style.opacity = 0; continue; }
      const u = (t - t0) / c.L;
      const r = (c.size * p.h) / 2;
      const color = c.color || p.color || this.style.highlightColor;
      if (p.shape !== c.shape) {
        p.path.setAttribute("d", "M" + SHAPES[c.shape].map(([x, y]) => `${x} ${y}`).join(" L") + " Z");
        p.shape = c.shape;
      }
      if (c.ring) {
        p.path.setAttribute("fill", "none");
        p.path.setAttribute("stroke", color);
        p.path.setAttribute("stroke-width", String(Math.max(1, r * 0.18) / r * 2));
      } else {
        p.path.setAttribute("fill", color);
        p.path.setAttribute("stroke", "none");
      }
      const x = p.bx + (c.x0 + (c.x1 - c.x0) * u) * p.w;
      const y = p.by + (c.y0 + (c.y1 - c.y0) * u) * p.h;
      const sc = lerp3(c.scale, u), rot = c.rot0 + (c.rot1 - c.rot0) * u;
      Object.assign(p.svg.style, {
        width: `${2 * r}px`, height: `${2 * r}px`, left: `${x}px`, top: `${y}px`,
        opacity: lerp3(c.alpha, u), filter: c.blur ? `blur(${c.blur * p.unit}px)` : "",
        transform: `translate(-50%, -50%) rotate(${rot}deg) scale(${sc})`,
      });
    }
  }

  updateStars(t) {
    for (const st of this.stars) {
      let v = 0;
      if (t >= st.start && t < st.end) {
        const d = st.period * 0.6;
        const phase = (t - st.start) % st.period;
        if (phase < d) {
          const p = phase / d;
          v = p < 0.5 ? p * 2 : (1 - p) * 2; // вспыхнуть и погаснуть
        }
      }
      st.el.style.opacity = v;
      st.el.style.transform = `translate(-50%, -50%) rotate(${st.rot}deg) scale(${0.3 + 0.7 * v})`;
    }
  }

  render(cap, wi, newCaption) {
    const s = this.style;
    this.stars = [];
    this.anims = [];
    this.fades = [];
    this.particles = [];
    this.bars = [];
    this.lastFxBoxes = {};
    if (s.preset === "combo") return this.renderCombo(cap, wi, newCaption);
    const k = this.h / 1080;
    const sc = this.scale;
    const fontInfo = this.fonts[s.font] || { cssScale: 1 };
    const assSize = this.h * (s.fontSize / 100) * (s.preset === "pop" ? 1.6 : 1);
    const px = assSize * sc;
    let outline = s.outline * k * sc;
    let shadow = s.shadow * k * sc;

    const b = this.block;
    this.place(cap);

    const text = document.createElement("div");
    text.className = "sub-text";
    text.style.fontFamily = `"sub-${s.font}", sans-serif`;
    text.style.fontSize = `${px * fontInfo.cssScale}px`;
    // Интервал: line-height ×f, а половинный интерлиньяж под последней строкой убираем —
    // в рендере низ последней строки стоит ровно на отступе
    const f = s.preset === "box" || s.preset === "pop" ? 1 : s.lineSpacing ?? 1;
    text.style.lineHeight = `${px * f}px`;
    text.style.marginBottom = `${(-(f - 1) * px) / 2}px`;
    text.style.color = s.color;

    if (s.preset === "box") {
      outline = 0;
      shadow = 0;
      const pad = assSize * 0.22 * sc;
      text.style.background = hexToRgba(s.boxColor, s.boxOpacity);
      text.style.padding = `${pad}px ${pad}px`;
    }
    if (s.preset === "wordbox") {
      outline = 0;
      shadow = 0;
    }
    text.style.textShadow = outlineShadow(outline, s.outlineColor, shadow, hexToRgba(s.outlineColor, 0.5));

    const words = s.preset === "pop" ? [cap.words[wi]] : cap.words;
    const startIdx = s.preset === "pop" ? wi : 0;
    words.forEach((w, j) => {
      const i = startIdx + j;
      const span = document.createElement("span");
      span.className = "w";
      span.dataset.wi = i;
      span.textContent = s.uppercase ? w.text.toUpperCase() : w.text;
      if (i === wi && (s.preset === "highlight" || s.preset === "wordbox")) {
        span.style.fontSize = `${s.wordScale}em`;
        if (s.preset === "highlight") span.style.color = s.highlightColor;
        else {
          const pad = assSize * 0.16 * sc;
          span.style.background = s.highlightColor;
          span.style.color = contrastText(s.highlightColor);
          span.style.padding = `${pad * 0.4}px ${pad}px`;
          span.style.margin = `0 ${-pad}px`;
          span.style.borderRadius = `${pad * 0.5}px`;
        }
      }
      if (s.reveal && s.preset !== "pop" && s.preset !== "karaoke") {
        this.fades.push({ span, appear: i === 0 ? cap.start : w.start, opacity: 1 });
      }
      if (s.preset === "karaoke") {
        // Сверху — копия слова цветом заливки, открываемая слева направо
        span.dataset.i = i;
        span.classList.add("k");
        const fill = document.createElement("span");
        fill.className = "k-fill";
        fill.textContent = span.textContent;
        fill.style.color = s.highlightColor;
        fill.style.clipPath = "inset(-50% 100% -50% -10%)";
        span.prepend(fill);
      }
      text.appendChild(span);
      if (j < words.length - 1) text.appendChild(document.createTextNode(" "));
    });

    b.replaceChildren(text);
    this.wrapLines(text);

    const anim = s.preset === "pop" ? "pop" : newCaption ? s.animation : "none";
    if (anim === "pop") text.classList.add("anim-pop");
    else if (anim === "fade") text.classList.add("anim-fade");
  }

  // Комбинированные стили: строки/слова разными шрифтами, слова появляются по мере речи
  renderCombo(cap, wi, newCaption) {
    const s = this.style;
    const sc = this.scale;
    const k = this.h / 1080;
    const combo = (this.combos || []).find((c) => c.id === s.combo) || s.comboDef || (this.combos || [])[0];
    if (!combo) return;
    const assSize = this.h * (s.fontSize / 100);
    const b = this.block;
    this.place(cap);

    const glow = s.outline * k * sc;
    const text = document.createElement("div");
    text.className = "sub-text combo";
    text.style.textShadow = glow > 0.2 ? `0 0 ${glow * 2}px ${hexToRgba(s.outlineColor, 0.6)}` : "none";

    const layout = comboLayout(combo, cap.words);
    let line = null;
    let lastLineSize = 0;
    const sparkle = [];
    cap.words.forEach((w, j) => {
      const [role, newLine] = layout[j];
      if (!line || newLine) {
        line = document.createElement("div");
        line.className = "sub-line";
        text.appendChild(line);
      }
      const size = assSize * (role.size ?? 1) * sc;
      const info = this.fonts[role.font] || { cssScale: 1 };
      const span = document.createElement("span");
      span.className = "w";
      span.dataset.wi = j;
      const sameLine = j + 1 < cap.words.length && !layout[j + 1][1];
      span.textContent = applyCase(w.text, role.case, s.uppercase);
      span.style.fontFamily = `"sub-${role.font}", serif`;
      span.style.fontSize = `${size * info.cssScale}px`;
      span.style.lineHeight = `${size * (s.lineSpacing ?? 1)}px`;
      lastLineSize = newLine || j === 0 ? size : Math.max(lastLineSize, size);
      span.style.letterSpacing = role.spacing ? `${role.spacing * size}px` : "";
      span.style.color = role.color === "accent" ? s.highlightColor : role.color && role.color !== "main" ? role.color : s.color;
      const fxShadow = fxTextShadow(role.fx, k * sc);
      if (fxShadow) span.style.textShadow = fxShadow;
      const anim = role.anim?.type && role.anim.type !== "none" ? role.anim : null;
      if (BOX_FX.has(role.fx?.type) || anim) sparkle.push([j, span, role]);
      if (anim) {
        // анимированное слово двигается трансформацией, не задевая раскладку строки
        span.style.display = "inline-block";
        span.style.transformOrigin = "50% 50%";
        this.anims.push({
          span, anim, role,
          appear: j === 0 ? cap.start : cap.words[j].start,
          seed: Math.floor(cap.start * 1000 + 0.5) * 31 + j + 17,
          unit: k * sc,
          opacity: role.opacity ?? 1,
        });
      }
      span.style.opacity = j > wi ? 0 : role.opacity ?? 1;
      if (!(role.anim?.type && role.anim.type !== "none")) {
        this.fades.push({ span, appear: j === 0 ? cap.start : w.start, opacity: role.opacity ?? 1 });
      }
      line.appendChild(span);
      if (sameLine) {
        const sp = span.cloneNode(false);
        sp.className = "sp";
        sp.textContent = " ";
        line.appendChild(sp);
      }
    });

    text.style.marginBottom = `${(-((s.lineSpacing ?? 1) - 1) * lastLineSize) / 2}px`;
    b.replaceChildren(text);
    this.wrapLines(text);
    this.placeSparkles(cap, sparkle);
    if (newCaption && s.animation === "pop") text.classList.add("anim-pop");
    else if (newCaption && s.animation === "fade") text.classList.add("anim-fade");
  }

  // Перенос строк точно как в libass (wrap_lines_smart): сначала жадно, затем
  // перенос сдвигается на слово назад, пока это уменьшает разницу длин соседних строк.
  wrapLines(text) {
    const maxW = this.block.clientWidth;
    const segments = text.classList.contains("combo") ? [...text.querySelectorAll(".sub-line")] : [text];
    const range = document.createRange();
    const width = (node) => {
      range.selectNodeContents(node);
      return range.getBoundingClientRect().width;
    };
    const starts = new Set();
    for (const seg of segments) {
      const words = [...seg.children].filter((el) => el.classList.contains("w"));
      if (words[0]) starts.add(+words[0].dataset.wi);
      if (words.length < 2) continue;
      const gapNodes = words.map((w) => w.nextSibling);
      const ws = words.map(width);
      const gs = gapNodes.map((g) => (g ? width(g) : 0));
      for (const start of libassWrap(ws, gs, maxW)) {
        if (start === 0) continue;
        const gap = gapNodes[start - 1];
        if (gap) gap.remove(); // пробел в конце строки libass отбрасывает
        seg.insertBefore(document.createElement("br"), words[start]);
        starts.add(+words[start].dataset.wi);
      }
    }
    this.lastStarts = [...starts].sort((a, b) => a - b);
  }

  // Где начинаются строки подписи в состоянии «активно слово wi» — для экспорта с интервалом
  layoutStarts(cap, wi) {
    this.render(cap, wi, false);
    return this.lastStarts;
  }

  updateKaraoke(cap, t) {
    this.block.querySelectorAll(".w").forEach((span) => {
      const i = +span.dataset.i;
      const w = cap.words[i];
      const next = cap.words[i + 1];
      const end = next ? next.start : Math.max(w.end, w.start + 0.01);
      const p = Math.max(0, Math.min(1, (t - w.start) / (end - w.start)));
      span.firstElementChild.style.clipPath = `inset(-50% ${(1 - p) * 100}% -50% -10%)`;
    });
  }
}

// ---- раскладка комбинированных стилей (та же логика, что в app/ass.py)

export function applyCase(text, kase, uppercase) {
  if (kase === "upper" || (!kase && uppercase)) return text.toUpperCase();
  if (kase === "lower") return text.toLowerCase();
  return text;
}

let STOP = new Set(), ATTACH = new Set();
export function setStopwords(data) {
  STOP = new Set(data.stop);
  ATTACH = new Set(data.attach);
}

const letters = (t) => (t.toLowerCase().match(/\p{L}/gu) || []).join("");
export const isStopword = (t) => STOP.has(letters(t));

// Слова-акценты: отмеченные вручную, иначе самое длинное не служебное слово
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

// Где начинать строки — та же оценка, что auto_line_starts в app/ass.py
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
        const gap = Math.max(0.0, cur.start - prev.end);
        cost -= Math.min(gap, 1.0) * 4.0;
      }
      const bounds = [...starts, n];
      const lens = [];
      for (let li = 0; li < starts.length; li++) {
        const a = bounds[li], z = bounds[li + 1];
        lens.push(chars.slice(a, z).reduce((x, y) => x + y, 0) + (z - a - 1));
      }
      const mean = lens.reduce((x, y) => x + y, 0) / lens.length;
      for (let li = 0; li < starts.length; li++) {
        const a = bounds[li], z = bounds[li + 1];
        if (z - a === 1 && stop[a]) cost += 6.0;
        cost += ((lens[li] - mean) / mean) ** 2 * 2.0;
      }
      if (bestCost === null || cost < bestCost - 1e-9) { bestCost = cost; best = starts; }
    }
  }
  return best;
}

export function lineStarts(combo, words) {
  const manual = words.map((w, i) => (i > 0 && w.br ? i : -1)).filter((i) => i > 0);
  return manual.length ? [0, ...manual] : autoLineStarts(words, combo.roles.length);
}

// Для каждого слова: [роль-оформление, начинается ли с него новая строка, номер роли]
export function comboLayout(combo, words) {
  const roles = combo.roles;
  if (combo.layout === "accent") {
    const em = emphasisIndices(words);
    return words.map((_, i) => (em.has(i) ? [roles[1], false, 1] : [roles[0], false, 0]));
  }
  const starts = new Set(lineStarts(combo, words));
  let line = -1;
  return words.map((_, i) => {
    if (starts.has(i)) line++;
    return [roles[line % roles.length], starts.has(i) && i > 0, line % roles.length];
  });
}

// Блок текста: центр по горизонтали в x%, низ в y% от низа; у края кадра сужается
// (та же формула, что block_margins в app/ass.py)
export function blockBox(x, y, maxWidth) {
  x = Math.max(0, Math.min(100, x));
  const half = Math.min(maxWidth / 2, x, 100 - x);
  return { left: x - half, right: 100 - x - half, bottom: y };
}

// Номера слов, с которых начинаются строки. ws — ширины слов, gs — ширины пробелов после них.
export function libassWrap(ws, gs, maxW) {
  const n = ws.length;
  const W = (a, z) => {
    let w = 0;
    for (let i = a; i < z; i++) w += ws[i] + (i < z - 1 ? gs[i] : 0);
    return w;
  };
  const L = [0];
  let a = 0;
  for (let i = 1; i < n; i++) {
    if (W(a, i + 1) >= maxW) { L.push(i); a = i; }
  }
  L.push(n);
  for (let changed = true; changed; ) {
    changed = false;
    for (let k = 1; k < L.length - 1; k++) {
      const s1 = L[k - 1], s2 = L[k], s3 = L[k + 1], w = s2 - 1;
      if (w === s1) continue; // в первой строке одно слово — двигать нечего
      const d = Math.abs(W(s1, s2) - W(s2, s3));
      const dNew = Math.abs(W(s1, w) - W(w, s3));
      if (dNew < d) { L[k] = w; changed = true; }
    }
  }
  return L.slice(0, -1);
}

// ---- эффекты второго шрифта (та же логика, что fx_tags / sparkle_* в app/ass.py)

export function fxTextShadow(fx, unit) {
  if (!fx || !fx.type || fx.type === "none" || fx.type === "sparkle") return "";
  const c = fx.color || "#FFFFFF";
  const st = fx.strength ?? 5;
  if (fx.type === "glow") {
    // В рендере: контур толщиной r/2 цветом эффекта (75%), размытый на 0.6r — повторяем
    // кольцом размытых теней вокруг буквы
    const r = (4 + st * 3) * unit;
    const ring = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ring.push(`${(Math.cos(a) * r * 0.5).toFixed(2)}px ${(Math.sin(a) * r * 0.5).toFixed(2)}px ${r * 0.9}px ${hexToRgba(c, 0.55)}`);
    }
    return `0 0 ${r * 0.3}px ${hexToRgba(c, 0.9)}, ${ring.join(", ")}`;
  }
  if (fx.type === "shadow") {
    const d = st * 1.5 * unit;
    return `${d}px ${d}px 0 ${c}`;
  }
  if (fx.type === "outline") return outlineShadow(st * 1.0 * unit, c, 0, c);
  return "";
}

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

// ---- анимации второго шрифта (та же математика, что app/anim.py)

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

// ---- частицы вокруг слова (та же логика, что app/particles.py; порядок вызовов rnd() важен)

export const PARTICLES = ["hearts", "confetti", "fireflies", "bubbles", "snow", "burst"];
export const BARS = ["marker", "underline"];
const BOX_FX = new Set(["sparkle", ...PARTICLES, ...BARS]);
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
