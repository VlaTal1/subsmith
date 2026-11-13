// Subtitle operations: splitting words into captions, text editing, export.
// caption = { start, end, words: [{ text, start, end }] }

const r3 = (x) => Math.round(x * 1000) / 1000;

export function flattenWords(captions) {
  return captions.flatMap((c) => c.words.map((w) => ({ ...w })));
}

export function chunkWords(words, { maxWords = 4, maxChars = 22, maxGap = 0.7 } = {}) {
  const caps = [];
  let cur = [];
  const len = (ws) => ws.reduce((n, w) => n + w.text.length, 0) + Math.max(0, ws.length - 1);
  const flush = () => {
    if (cur.length) caps.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
    cur = [];
  };
  for (const w of words) {
    if (cur.length) {
      const last = cur[cur.length - 1];
      const sentenceEnd = /[.!?…]["»”)]*$/.test(last.text);
      const clauseEnd = /[,;:—–-]$/.test(last.text) && cur.length >= Math.ceil(maxWords / 2);
      if (
        cur.length >= maxWords ||
        len(cur) + 1 + w.text.length > maxChars ||
        w.start - last.end > maxGap ||
        sentenceEnd ||
        clauseEnd
      ) flush();
    }
    cur.push(w);
  }
  flush();
  // Keep the caption on screen a bit past its last word, but not past the next caption's start
  for (let i = 0; i < caps.length; i++) {
    const next = caps[i + 1];
    const hold = Math.min(caps[i].end + 0.4, next ? next.start : Infinity);
    caps[i].end = r3(Math.max(caps[i].end, hold));
  }
  return caps;
}

export function captionText(cap) {
  return cap.words.map((w) => w.text).join(" ");
}

// New caption text: if the word count matches, keep word timestamps;
// otherwise distribute time proportionally to word length.
export function retimeText(cap, text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return { ...cap, words: [] };
  if (tokens.length === cap.words.length) {
    return { ...cap, words: cap.words.map((w, i) => ({ ...w, text: tokens[i] })) };
  }
  const total = tokens.reduce((n, t) => n + t.length + 1, 0);
  const dur = cap.end - cap.start;
  let t = cap.start;
  const words = tokens.map((tok) => {
    const d = (dur * (tok.length + 1)) / total;
    const w = { text: tok, start: r3(t), end: r3(t + d * 0.92) };
    t += d;
    return w;
  });
  return { ...cap, words };
}

// New caption bounds: word timings are stretched proportionally
export function retimeRange(cap, start, end) {
  const os = cap.start, od = cap.end - cap.start || 1;
  const map = (x) => r3(start + ((x - os) / od) * (end - start));
  return { ...cap, start: r3(start), end: r3(end), words: cap.words.map((w) => ({ ...w, start: map(w.start), end: map(w.end) })) };
}

export function splitCaption(cap, wordIndex) {
  if (wordIndex <= 0 || wordIndex >= cap.words.length) return [cap];
  const a = cap.words.slice(0, wordIndex), b = cap.words.slice(wordIndex);
  const mid = b[0].start;
  return [
    { ...cap, start: cap.start, end: r3(Math.max(a[a.length - 1].end, Math.min(mid, cap.end))), words: a },
    { ...cap, start: mid, end: cap.end, words: b },
  ];
}

// Merge adjacent captions. keep — whose properties (own position etc.) are kept: "a" or "b"
export function mergeCaptions(a, b, keep = "a") {
  return { ...(keep === "a" ? a : b), start: a.start, end: b.end, words: [...a.words, ...b.words] };
}

export function shiftAll(captions, dt) {
  return captions.map((c) => ({
    ...c,
    start: r3(Math.max(0, c.start + dt)),
    end: r3(Math.max(0.05, c.end + dt)),
    words: c.words.map((w) => ({ ...w, start: r3(Math.max(0, w.start + dt)), end: r3(Math.max(0, w.end + dt)) })),
  }));
}

function stamp(t, sep) {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms % 1000, 3)}`;
}

export function toSRT(captions, upper) {
  return captions
    .map((c, i) => {
      const t = captionText(c);
      return `${i + 1}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${upper ? t.toUpperCase() : t}\n`;
    })
    .join("\n");
}

export function toVTT(captions, upper) {
  return (
    "WEBVTT\n\n" +
    captions
      .map((c) => {
        const t = captionText(c);
        return `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${upper ? t.toUpperCase() : t}\n`;
      })
      .join("\n")
  );
}

export function toTXT(captions) {
  return captions.map(captionText).join(" ").replace(/\s+([,.!?…:;])/g, "$1");
}

export function fmtTime(t, precise = true) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60), s = t - m * 60;
  return precise ? `${m}:${s.toFixed(1).padStart(4, "0")}` : `${m}:${String(Math.floor(s)).padStart(2, "0")}`;
}

export function parseTime(str) {
  const m = String(str).trim().match(/^(?:(\d+):)?(\d+(?:[.,]\d+)?)$/);
  if (!m) return NaN;
  return (m[1] ? +m[1] * 60 : 0) + parseFloat(m[2].replace(",", "."));
}
