// Subtitle looks: typographic templates that mix plain and fancy fonts.
//
// A look has roles (how a kind of word is set), variants (how a caption is split into
// lines and which role each line uses) and placement (where blocks go on the frame).
// The layout engine (layout.js) picks a variant per caption from its text — length,
// accent word, punctuation — so captions within one video vary but stay in one style.
//
// Units: role.size is in em relative to the look's base size (base = % of video height);
// lead is the line step in em of the next line; indent shifts a line, 0.2 = one base em.
// sample: the card's phrase — "|" starts a line, "*" marks an accent word.

const HALO = { color: "#000000", width: 0.06, blur: 0.22, alpha: 0.45 };

export const LOOKS = [
  {
    id: "editorial",
    name: "Editorial",
    sample: "а як|ви думаєте|нормальна ціна",
    base: 5.2,
    palette: { main: "#FFFFFF", accent: "#FFE45C" },
    accents: ["#FFE45C", "#FFB8CF", "#8FF0DC", "#FFC48A", "#C9B8FF"],
    entrance: "rise",
    halo: HALO,
    roles: {
      head: { font: "Montserrat Black", size: 1.5, case: "upper", color: "main", spacing: -0.01 },
      body: { font: "Montserrat SemiBold", size: 0.72, case: "lower", color: "main" },
      script: { font: "Playfair Display Bold Italic", size: 1.12, case: "lower", color: "accent" },
    },
    variants: [
      { id: "solo", max: 1, split: "inline", base: "head", accent: "head", scale: 1.25 },
      { id: "duo", max: 3, split: "accent", lines: [
        { role: "head", align: "left" },
        { role: "script", align: "left", indent: 0.18, lead: 0.95 },
        { role: "body", align: "left", indent: 0.1, lead: 1.05 },
      ] },
      { id: "stack", min: 4, split: "stack", lines: [
        { role: "head", align: "left" },
        { role: "body", align: "left", indent: 0.14, lead: 1.15 },
        { role: "script", align: "left", indent: 0.3, lead: 1.0 },
      ], drop: [1] },
    ],
    place: { slots: [{ x: 50, y: 20, align: "center" }] },
  },
  {
    id: "couture",
    name: "Couture",
    sample: "фарб *вжити зараз",
    base: 4.4,
    palette: { main: "#FFE9A8", accent: "#FF7EB6" },
    accents: ["#FF7EB6", "#FF9E7A", "#B9A5FF", "#7FE3FF", "#FFE9A8"],
    entrance: "fade",
    halo: { ...HALO, alpha: 0.35 },
    roles: {
      base: { font: "Prata", size: 1, case: "lower", color: "main" },
      accent: { font: "Great Vibes", size: 2.4, case: "lower", color: "accent", gap: -0.06, shift: 0.12 },
    },
    variants: [
      { id: "solo", max: 1, split: "inline", base: "accent", accent: "accent", scale: 0.85 },
      { id: "inline", split: "inline", base: "base", accent: "accent", lead: 1.25 },
    ],
    place: { slots: [{ x: 50, y: 24, align: "center" }] },
  },
  {
    id: "diary",
    name: "Diary",
    sample: "Осінь в голову *вдарила",
    base: 4.0,
    palette: { main: "#F6E7B4", accent: "#F6E7B4" },
    accents: ["#F6E7B4", "#FFD3DC", "#D7F2C4", "#CFE3FF"],
    entrance: "fade",
    hold: true,
    halo: { ...HALO, alpha: 0.4 },
    roles: {
      base: { font: "Prata", size: 1, color: "main" },
      lift: { font: "Prata", size: 1.18, color: "main" },
      soft: { font: "Playfair Display Italic", size: 1.12, color: "accent", opacity: 0.82 },
    },
    variants: [
      { id: "solo", max: 1, split: "inline", base: "soft", accent: "soft", scale: 1.3 },
      { id: "fall", split: "accent", lines: [
        { role: "base", align: "left" },
        { role: "soft", align: "left", indent: 0.32, lead: 0.92 },
        { role: "lift", align: "left", indent: 0.12, lead: 1.05 },
      ] },
    ],
    place: { maxWidth: 43, slots: [{ x: 5, y: 36, align: "left" }, { x: 95, y: 44, align: "right" }] },
  },
  {
    id: "punch",
    name: "Punch",
    sample: "це просто *бомба",
    base: 5.4,
    palette: { main: "#FFFFFF", accent: "#FFE600" },
    accents: ["#FFE600", "#B6FF3B", "#FF4FA3", "#3BE8FF", "#FF8A1F"],
    entrance: "pop",
    outline: { color: "#000000", width: 0.07 },
    halo: { color: "#000000", width: 0.1, blur: 0.2, alpha: 0.5 },
    roles: {
      base: { font: "Dela Gothic One", size: 1, case: "upper", color: "main", active: "accent" },
      accent: { font: "Dela Gothic One", size: 1.22, case: "upper", color: "accent", active: "accent" },
    },
    variants: [
      { id: "solo", max: 2, split: "inline", base: "accent", accent: "accent", scale: 1.25 },
      { id: "inline", split: "inline", base: "base", accent: "accent", lead: 1.05 },
    ],
    place: { slots: [{ x: 50, y: 26, align: "center" }] },
  },
  {
    id: "neon",
    name: "Neon note",
    sample: "це було *неймовірно",
    base: 4.6,
    palette: { main: "#FFFFFF", accent: "#FF5FB8" },
    accents: ["#FF5FB8", "#4FE3FF", "#B98CFF", "#FFD24F", "#7CFF9B"],
    entrance: "rise",
    halo: HALO,
    roles: {
      label: { font: "Montserrat ExtraBold", size: 0.8, case: "upper", color: "main", spacing: 0.06 },
      script: { font: "Pacifico", size: 1.55, color: "accent", fx: { type: "glow", strength: 4 } },
    },
    variants: [
      { id: "solo", max: 1, split: "inline", base: "script", accent: "script", scale: 1.15 },
      { id: "note", split: "accent", lines: [
        { role: "label", align: "center" },
        { role: "script", align: "center", lead: 0.9 },
        { role: "label", align: "center", lead: 1.0 },
      ] },
    ],
    place: { slots: [{ x: 50, y: 22, align: "center" }] },
  },
  {
    id: "bloom",
    name: "Bloom",
    sample: "моя *маленька радість",
    base: 4.8,
    palette: { main: "#FFFFFF", accent: "#FFC2D4" },
    accents: ["#FFC2D4", "#FFE7A3", "#C8F0FF", "#E4D2FF"],
    entrance: "fade",
    halo: { ...HALO, alpha: 0.4 },
    roles: {
      head: { font: "Yeseva One", size: 1.3, color: "main" },
      body: { font: "Kurale", size: 0.82, color: "accent" },
      star: { font: "Yeseva One", size: 1.45, color: "accent", fx: { type: "sparkle", color: "#FFFFFF", strength: 3 } },
    },
    variants: [
      { id: "solo", max: 1, split: "inline", base: "star", accent: "star", scale: 1.15 },
      { id: "pair", max: 3, split: "accent", lines: [
        { role: "body", align: "center" },
        { role: "star", align: "center", lead: 1.0 },
        { role: "body", align: "center", lead: 1.1 },
      ] },
      { id: "stack", min: 4, split: "stack", lines: [
        { role: "head", align: "center" },
        { role: "body", align: "center", lead: 1.2 },
      ] },
    ],
    place: { slots: [{ x: 50, y: 22, align: "center" }] },
  },
  {
    id: "sketch",
    name: "Sketch",
    sample: "я *обожнюю осінь",
    base: 5.6,
    palette: { main: "#FFFFFF", accent: "#FFF04D" },
    accents: ["#FFF04D", "#9DFF8A", "#FF9BD0", "#7FDBFF"],
    entrance: "pop",
    halo: { ...HALO, alpha: 0.5 },
    roles: {
      base: { font: "Amatic SC Bold", size: 1.15, case: "upper", color: "main", spacing: 0.02 },
      accent: { font: "Caveat", size: 1.05, color: "#1A1A1A", fx: { type: "marker", strength: 10 }, halo: false },
    },
    variants: [
      { id: "solo", max: 1, split: "inline", base: "accent", accent: "accent", scale: 1.3 },
      { id: "inline", split: "inline", base: "base", accent: "accent", lead: 1.0 },
    ],
    place: { slots: [{ x: 50, y: 24, align: "center" }] },
  },
  {
    id: "vogue",
    name: "Vogue",
    sample: "як тобі *така *ідея",
    base: 4.8,
    palette: { main: "#FFFFFF", accent: "#FFFFFF" },
    accents: ["#FFFFFF", "#FFE2B8", "#FFD0DA", "#D6E8FF"],
    entrance: "rise",
    halo: HALO,
    roles: {
      label: { font: "Unbounded", size: 0.5, case: "upper", color: "main", spacing: 0.16 },
      big: { font: "Cormorant Italic", size: 1.7, case: "lower", color: "accent" },
    },
    variants: [
      { id: "solo", max: 1, split: "inline", base: "big", accent: "big", scale: 1.1 },
      { id: "cover", split: "accent", lines: [
        { role: "label", align: "center" },
        { role: "big", align: "center", lead: 0.95 },
        { role: "label", align: "center", lead: 0.75 },
      ] },
    ],
    place: { slots: [{ x: 50, y: 20, align: "center" }] },
  },
  {
    id: "clean",
    name: "Clean",
    sample: "просто і чисто",
    base: 4.6,
    palette: { main: "#FFFFFF", accent: "#7CFF6B" },
    accents: ["#7CFF6B", "#FFE600", "#4FD1FF", "#FF7AC6", "#FFA24F"],
    entrance: "pop",
    halo: { ...HALO, alpha: 0.55 },
    roles: {
      base: { font: "Montserrat ExtraBold", size: 1, color: "main", active: "accent" },
    },
    variants: [
      { id: "inline", split: "inline", base: "base", accent: "base", lead: 1.1 },
    ],
    place: { slots: [{ x: 50, y: 22, align: "center" }] },
  },
];

export const DEFAULT_LOOK = "editorial";

export function getLook(id) {
  return LOOKS.find((l) => l.id === id) || LOOKS.find((l) => l.id === DEFAULT_LOOK);
}

// ------------------------------------------------------------------ colors from the video

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

function rgbHsl([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

// Pick the accent that stands out from the video: far from its dominant hue, bright enough.
// scene = { hue, sat, lum } from analyzeVideo().
export function pickAccent(look, scene) {
  if (!scene) return look.palette.accent;
  let best = look.accents[0], bestScore = -Infinity;
  look.accents.forEach((c, i) => {
    const [h, s, l] = rgbHsl(hexRgb(c));
    const dh = Math.min(Math.abs(h - scene.hue), 360 - Math.abs(h - scene.hue)) / 180; // 0..1
    const hueScore = s < 0.15 ? 0.35 : dh * Math.min(1, scene.sat * 2.5) + (1 - Math.min(1, scene.sat * 2.5)) * 0.5;
    const score = hueScore + (l - scene.lum) * 0.4 - i * 0.04; // earlier = the look's own favourite
    if (score > bestScore) { bestScore = score; best = c; }
  });
  return best;
}

// Dominant hue, saturation and brightness of the video, from a few sampled frames
export async function analyzeVideo(src, duration) {
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.crossOrigin = "anonymous";
  v.src = src;
  await new Promise((ok, fail) => { v.onloadeddata = ok; v.onerror = fail; });
  const c = document.createElement("canvas");
  c.width = 48; c.height = 48;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  let sx = 0, sy = 0, wsum = 0, lsum = 0, n = 0, ssum = 0;
  const dur = duration || v.duration || 1;
  for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    v.currentTime = dur * f;
    await new Promise((ok) => (v.onseeked = ok));
    ctx.drawImage(v, 0, 0, 48, 48);
    const px = ctx.getImageData(0, 0, 48, 48).data;
    for (let i = 0; i < px.length; i += 4) {
      const [h, s, l] = rgbHsl([px[i] / 255, px[i + 1] / 255, px[i + 2] / 255]);
      const w = s * (1 - Math.abs(l - 0.5) * 2); // vivid mid-tones decide the hue
      sx += Math.cos((h * Math.PI) / 180) * w;
      sy += Math.sin((h * Math.PI) / 180) * w;
      wsum += w; ssum += s; lsum += l; n++;
    }
  }
  v.removeAttribute("src");
  v.load();
  const hue = ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360;
  return {
    hue: Math.round(hue),
    sat: +Math.min(1, Math.hypot(sx, sy) / Math.max(wsum, 1e-6) * (ssum / n) * 2).toFixed(3),
    lum: +(lsum / n).toFixed(3),
  };
}
