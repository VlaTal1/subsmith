import { SubtitleOverlay, findCaption } from "./overlay.js";
import { DEFAULT_STYLE, emphasisIndices, layoutAll, layoutCaption, normalizeStyle, resolveColors, setStopwords } from "./layout.js";
import { LOOKS, analyzeVideo, getLook } from "./looks.js";
import {
  captionText, chunkWords, flattenWords, fmtTime, mergeCaptions, parseTime,
  retimeRange, retimeText, shiftAll, splitCaption, toSRT, toTXT, toVTT,
} from "./captions.js";
import { hydrateIcons, icon, setIcon } from "./icons.js";

hydrateIcons();

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ------------------------------------------------------------------ common

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  const type = res.headers.get("content-type") || "";
  return type.includes("json") ? res.json() : res.text();
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 2500);
}

function download(name, text, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function pollJob(jobId, box) {
  box.hidden = false;
  const bar = $(".progress > div", box);
  const msg = $(".job-msg", box);
  for (;;) {
    const job = await api(`/api/jobs/${jobId}`);
    bar.style.width = `${Math.round(job.progress * 100)}%`;
    msg.textContent = `${job.message || ""} ${Math.round(job.progress * 100)}%`;
    if (job.status === "done") { box.hidden = true; return job.result; }
    if (job.status === "error") { box.hidden = true; throw new Error(job.error); }
    await new Promise((r) => setTimeout(r, 700));
  }
}

let fonts = [];
let fontMap = {};
async function loadFonts() {
  fonts = await api("/api/fonts");
  await Promise.all(
    fonts.map(async (f) => {
      const face = new FontFace(`sub-${f.name}`, `url(/fonts/${f.file})`);
      document.fonts.add(await face.load());
    }),
  );
}

// ------------------------------------------------------------------ routing

function route() {
  const m = location.hash.match(/^#\/p\/([a-f0-9]{12})/);
  $("#view-home").hidden = !!m;
  $("#view-editor").hidden = !m;
  if (m) openEditor(m[1]);
  else { closeEditor(); showHome(); }
}
window.addEventListener("hashchange", route);

// ------------------------------------------------------------------ home

async function showHome() {
  const list = await api("/api/projects");
  const box = $("#projects");
  box.innerHTML = "";
  $("#projects-empty").hidden = list.length > 0;
  for (const p of list) {
    const card = document.createElement("a");
    card.className = "project";
    card.href = `#/p/${p.id}`;
    card.innerHTML = `
      <div class="thumb" style="aspect-ratio:${p.width}/${p.height}">
        <video src="/api/projects/${p.id}/video#t=0.5" preload="metadata" muted></video>
      </div>
      <div class="p-info">
        <div class="p-name"></div>
        <div class="small muted">${fmtTime(p.duration, false)} · ${p.width}×${p.height}${p.hasOutput ? " · ✓ exported" : ""}</div>
      </div>
      <button class="p-del btn ghost icon small" title="Delete">${icon("x")}</button>`;
    $(".p-name", card).textContent = p.name;
    $(".p-del", card).onclick = async (e) => {
      e.preventDefault();
      if (!confirm(`Delete project "${p.name}"?`)) return;
      await api(`/api/projects/${p.id}`, { method: "DELETE" });
      showHome();
    };
    box.appendChild(card);
  }
}

function uploadFile(file) {
  const bar = $("#upload-progress");
  bar.hidden = false;
  const xhr = new XMLHttpRequest();
  const fd = new FormData();
  fd.append("file", file);
  xhr.open("POST", "/api/projects");
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) $("div", bar).style.width = `${(e.loaded / e.total) * 95}%`;
  };
  xhr.onload = () => {
    bar.hidden = true;
    if (xhr.status !== 200) {
      let msg = xhr.statusText;
      try { msg = JSON.parse(xhr.responseText).detail; } catch {}
      return toast(msg, true);
    }
    location.hash = `#/p/${JSON.parse(xhr.responseText).id}?auto=1`;
  };
  xhr.onerror = () => { bar.hidden = true; toast("Upload failed", true); };
  xhr.send(fd);
}

$("#file-input").onchange = (e) => e.target.files[0] && uploadFile(e.target.files[0]);
const dz = $("#dropzone");
dz.ondragover = (e) => { e.preventDefault(); dz.classList.add("over"); };
dz.ondragleave = () => dz.classList.remove("over");
dz.ondrop = (e) => {
  e.preventDefault();
  dz.classList.remove("over");
  const f = e.dataTransfer.files[0];
  if (f) uploadFile(f);
};

// ------------------------------------------------------------------ editor: state

const video = $("#video");
const overlay = new SubtitleOverlay($("#sub-layer"));
const ed = {
  project: null,
  captions: [],
  style: { ...DEFAULT_STYLE },
  selected: -1,
  past: [],
  future: [],
  saveTimer: null,
  pxPerSec: 90,
};

async function openEditor(id) {
  if (ed.project?.id === id) return;
  const p = await api(`/api/projects/${id}`);
  ed.project = p;
  ed.captions = p.captions || [];
  ed.style = normalizeStyle(p.style);
  ed.selected = -1;
  ed.past = [];
  ed.future = [];
  $("#project-name").value = p.name;
  $("#chunk-words").value = p.chunk?.maxWords ?? 4;
  $("#chunk-chars").value = p.chunk?.maxChars ?? 22;
  $("#save-status").textContent = "";
  $("#render-result").hidden = !p.hasOutput;
  if (p.hasOutput) showResult();
  video.src = `/api/projects/${id}/video`;
  const prompt = sessionStorage.getItem(`prompt:${id}`);
  if (prompt) $("#stt-prompt").value = prompt;
  switchTab("text");
  syncStyleControls();
  renderLooks();
  renderAll();
  if (ed.style.autoColor && !ed.style.scene) matchVideoColors(false);

  const auto = location.hash.includes("auto=1");
  history.replaceState(null, "", `#/p/${id}`);
  if (auto && !ed.captions.length && p.hasAudio !== false) startTranscribe();
}

function closeEditor() {
  if (!ed.project) return;
  flushSave();
  video.pause();
  video.removeAttribute("src");
  video.load();
  ed.project = null;
}

function commit(newCaptions, { keepFuture = false } = {}) {
  ed.past.push(JSON.stringify(ed.captions));
  if (ed.past.length > 100) ed.past.shift();
  if (!keepFuture) ed.future = [];
  ed.captions = newCaptions.sort((a, b) => a.start - b.start);
  renderAll();
  scheduleSave();
}

function undo() {
  if (!ed.past.length) return;
  ed.future.push(JSON.stringify(ed.captions));
  ed.captions = JSON.parse(ed.past.pop());
  renderAll();
  scheduleSave();
}

function redo() {
  if (!ed.future.length) return;
  ed.past.push(JSON.stringify(ed.captions));
  ed.captions = JSON.parse(ed.future.pop());
  renderAll();
  scheduleSave();
}

function scheduleSave() {
  $("#save-status").textContent = "Unsaved";
  clearTimeout(ed.saveTimer);
  ed.saveTimer = setTimeout(flushSave, 800);
}

async function flushSave() {
  if (!ed.project || !ed.saveTimer) return;
  clearTimeout(ed.saveTimer);
  ed.saveTimer = null;
  try {
    await api(`/api/projects/${ed.project.id}`, {
      method: "PUT",
      body: {
        name: $("#project-name").value.trim() || "Untitled",
        captions: ed.captions,
        style: ed.style,
        chunk: chunkOpts(),
      },
    });
    $("#save-status").textContent = "Saved";
  } catch (e) {
    $("#save-status").textContent = "Save failed";
  }
}
window.addEventListener("beforeunload", flushSave);

function chunkOpts() {
  return { maxWords: +$("#chunk-words").value || 4, maxChars: +$("#chunk-chars").value || 22 };
}

function renderAll() {
  const has = ed.captions.length > 0;
  $("#stt-card").hidden = has;
  $("#text-tools").hidden = !has;
  renderCaptionList();
  renderTimeline();
  updateOverlay(true);
  $("#btn-undo").disabled = !ed.past.length;
  $("#btn-redo").disabled = !ed.future.length;
}

// ------------------------------------------------------------------ player and preview

function layoutFrame() {
  const p = ed.project;
  if (!p) return;
  const box = $("#frame-box");
  const cs = getComputedStyle(box);
  const bw = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const bh = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const ar = p.width / p.height;
  let w = bw, h = bw / ar;
  if (h > bh) { h = bh; w = bh * ar; }
  const frame = $("#frame");
  frame.style.width = `${w}px`;
  frame.style.height = `${h}px`;
  updateOverlay(true);
}
new ResizeObserver(layoutFrame).observe($("#frame-box"));

function updateOverlay(force = false) {
  if (!ed.project) return;
  if (force) overlay.configure({ style: ed.style, width: ed.project.width, height: ed.project.height });
  overlay.update(ed.captions, video.currentTime);
}

let lastActive = -2;
function tick() {
  if (ed.project) {
    const t = video.currentTime;
    updateOverlay();
    $("#time").textContent = `${fmtTime(t)} / ${fmtTime(video.duration || ed.project.duration)}`;
    $("#tl-head").style.transform = `translateX(${t * ed.pxPerSec}px)`;
    const idx = findCaption(ed.captions, t);
    if (idx !== lastActive) {
      $$(".cap.playing").forEach((el) => el.classList.remove("playing"));
      $$(".tl-cap.playing").forEach((el) => el.classList.remove("playing"));
      if (idx >= 0) {
        const row = $(`.cap[data-i="${idx}"]`);
        row?.classList.add("playing");
        $(`.tl-cap[data-i="${idx}"]`)?.classList.add("playing");
        if (!video.paused && row && !row.contains(document.activeElement)) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
      lastActive = idx;
    }
    if (!video.paused) {
      const tl = $("#timeline");
      const x = t * ed.pxPerSec;
      if (x < tl.scrollLeft || x > tl.scrollLeft + tl.clientWidth - 40) tl.scrollLeft = x - 60;
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function togglePlay() {
  if (video.paused) video.play(); else video.pause();
}
video.onplay = video.onpause = () => {
  setIcon($("#btn-play"), video.paused ? "play" : "pause");
  $("#big-play").hidden = !video.paused;
};
video.onloadedmetadata = layoutFrame;
$("#btn-play").onclick = togglePlay;

// Preview size on phones: large by default, compact via the button or while editing text
let compactPinned = localStorage.getItem("compact-preview") === "1";
function setCompact(on) {
  $("#view-editor").classList.toggle("compact", on);
  setIcon($("#btn-size"), on ? "maximize" : "minimize");
  setTimeout(layoutFrame, 220); // after the height animation
}
setCompact(compactPinned);
$("#btn-size").onclick = () => {
  compactPinned = !$("#view-editor").classList.contains("compact");
  localStorage.setItem("compact-preview", compactPinned ? "1" : "0");
  setCompact(compactPinned);
};
const isTextField = (el) => el.matches?.(".side textarea, .side input:not([type=range]):not([type=checkbox]):not([type=color])");
$(".side").addEventListener("focusin", (e) => isTextField(e.target) && setCompact(true));
$(".side").addEventListener("focusout", (e) => isTextField(e.target) && setTimeout(() => {
  if (!isTextField(document.activeElement)) setCompact(compactPinned);
}, 100));
$("#frame").onclick = togglePlay;

function seek(t) {
  video.currentTime = Math.max(0, Math.min(t, video.duration || ed.project.duration));
}

// ------------------------------------------------------------------ dragging text over the video

let moveOne = localStorage.getItem("move-one") === "1";
function syncMoveMode() {
  setIcon($("#btn-move-mode"), "move", moveOne ? "This caption" : "All captions");
  $("#btn-move-mode").classList.toggle("on", moveOne);
}
syncMoveMode();
$("#btn-move-mode").onclick = () => {
  moveOne = !moveOne;
  localStorage.setItem("move-one", moveOne ? "1" : "0");
  syncMoveMode();
  toast(moveOne ? "Dragging moves only the current caption" : "Dragging moves all captions");
};

// Anchor of caption i in % of the frame: its own position, or the look's slot moved by the global offset
function anchorOf(i) {
  const cap = ed.captions[i];
  if (cap.pos) return { ...cap.pos };
  const slots = getLook(ed.style.look).place.slots;
  const slot = slots[i % slots.length];
  return { x: slot.x + ed.style.offset.x, y: slot.y + ed.style.offset.y };
}

$("#sub-layer").addEventListener("pointerdown", (e) => {
  const block = e.target.closest(".sub-block");
  if (!block) return;
  const idx = +block.dataset.i;
  const cap = ed.captions[idx];
  if (!cap) return;
  e.preventDefault();
  const frame = $("#frame").getBoundingClientRect();
  // A caption with its own position always moves on its own; otherwise per the toggle mode
  const own = moveOne || !!cap.pos;
  const start = anchorOf(idx);
  const offset0 = { ...ed.style.offset };
  const before = JSON.stringify(ed.captions);
  const x0 = e.clientX, y0 = e.clientY;
  let moved = false;
  const layer = $("#sub-layer");
  layer.setPointerCapture(e.pointerId);
  block.classList.add("dragging");

  layer.onpointermove = (ev) => {
    if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
    moved = true;
    const dx = ((ev.clientX - x0) / frame.width) * 100;
    const dy = -((ev.clientY - y0) / frame.height) * 100;
    let x = Math.max(0, Math.min(100, start.x + dx));
    const y = Math.round(Math.max(0, Math.min(98, start.y + dy)) * 10) / 10;
    const snap = Math.abs(x - 50) < 2.5 && getLook(ed.style.look).place.slots[0].align === "center";
    if (snap) x = 50;
    $("#snap-guide").hidden = !snap;
    x = Math.round(x * 10) / 10;
    if (own) {
      const caps = ed.captions.slice();
      caps[idx] = { ...ed.captions[idx], pos: { x, y } };
      ed.captions = caps;
    } else {
      ed.style = { ...ed.style, offset: { x: Math.round((offset0.x + x - start.x) * 10) / 10, y: Math.round((offset0.y + y - start.y) * 10) / 10 } };
    }
    updateOverlay(true);
  };
  layer.onpointerup = layer.onpointercancel = () => {
    layer.onpointermove = layer.onpointerup = layer.onpointercancel = null;
    $$(".sub-block.dragging").forEach((b) => b.classList.remove("dragging"));
    $("#snap-guide").hidden = true;
    if (!moved) return;
    // A click after dragging must not toggle play/pause
    $("#frame").addEventListener("click", (ev) => ev.stopPropagation(), { capture: true, once: true });
    if (own) {
      ed.past.push(before);
      ed.future = [];
      renderCaptionList();
      $("#btn-undo").disabled = false;
    }
    scheduleSave();
  };
});

// ------------------------------------------------------------------ timeline

function renderTimeline() {
  const p = ed.project;
  if (!p) return;
  const pps = ed.pxPerSec;
  const dur = p.duration || video.duration || 1;
  const inner = $("#tl-inner");
  inner.style.width = `${dur * pps + 40}px`;

  const ruler = $("#tl-ruler");
  ruler.innerHTML = "";
  const step = pps > 150 ? 1 : pps > 60 ? 2 : pps > 30 ? 5 : 10;
  for (let t = 0; t <= dur; t += step) {
    const m = document.createElement("span");
    m.style.left = `${t * pps}px`;
    m.textContent = fmtTime(t, false);
    ruler.appendChild(m);
  }

  const track = $("#tl-track");
  track.innerHTML = "";
  ed.captions.forEach((c, i) => {
    const el = document.createElement("div");
    el.className = "tl-cap" + (i === ed.selected ? " selected" : "");
    el.dataset.i = i;
    el.style.left = `${c.start * pps}px`;
    el.style.width = `${Math.max(4, (c.end - c.start) * pps)}px`;
    el.innerHTML = `<span class="h l"></span><span class="txt"></span><span class="h r"></span>`;
    $(".txt", el).textContent = captionText(c);
    el.onpointerdown = (e) => startDrag(e, i);
    track.appendChild(el);
  });
}

function startDrag(e, i) {
  e.stopPropagation();
  const edge = e.target.classList.contains("l") ? "l" : e.target.classList.contains("r") ? "r" : "move";
  const cap = ed.captions[i];
  const prev = ed.captions[i - 1], next = ed.captions[i + 1];
  const x0 = e.clientX;
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  let moved = false;
  let result = cap;
  const lo = prev ? prev.end : 0;
  const hi = next ? next.start : ed.project.duration;
  const len = cap.end - cap.start;

  el.onpointermove = (ev) => {
    const dt = (ev.clientX - x0) / ed.pxPerSec;
    if (Math.abs(ev.clientX - x0) > 3) moved = true;
    if (!moved) return;
    let s = cap.start, en = cap.end;
    if (edge === "l") s = Math.min(Math.max(lo, cap.start + dt), cap.end - 0.1);
    else if (edge === "r") en = Math.max(Math.min(hi, cap.end + dt), cap.start + 0.1);
    else { s = Math.min(Math.max(lo, cap.start + dt), hi - len); en = s + len; }
    result = retimeRange(cap, s, en);
    el.style.left = `${result.start * ed.pxPerSec}px`;
    el.style.width = `${(result.end - result.start) * ed.pxPerSec}px`;
  };
  el.onpointerup = () => {
    el.onpointermove = el.onpointerup = null;
    if (moved) {
      const caps = ed.captions.slice();
      caps[i] = result;
      commit(caps);
    } else {
      select(i, true);
      seek(cap.start + 0.01);
    }
  };
}

$("#timeline").onpointerdown = (e) => {
  if (e.target.closest(".tl-cap")) return;
  const rect = $("#tl-inner").getBoundingClientRect();
  const scrub = (ev) => seek((ev.clientX - rect.left) / ed.pxPerSec);
  scrub(e);
  const tl = $("#timeline");
  tl.setPointerCapture(e.pointerId);
  tl.onpointermove = scrub;
  tl.onpointerup = () => (tl.onpointermove = tl.onpointerup = null);
};

$("#zoom").oninput = (e) => {
  const tl = $("#timeline");
  const center = (tl.scrollLeft + tl.clientWidth / 2) / ed.pxPerSec;
  ed.pxPerSec = +e.target.value;
  renderTimeline();
  tl.scrollLeft = center * ed.pxPerSec - tl.clientWidth / 2;
};

// ------------------------------------------------------------------ caption list

function select(i, scroll = false) {
  ed.selected = i;
  $$(".cap.selected, .tl-cap.selected").forEach((el) => el.classList.remove("selected"));
  $(`.cap[data-i="${i}"]`)?.classList.add("selected");
  $(`.tl-cap[data-i="${i}"]`)?.classList.add("selected");
  if (scroll) $(`.cap[data-i="${i}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function autoGrow(ta) {
  if (!ta.offsetParent) return; // tab is hidden — height will be computed when it opens
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight}px`;
}

function renderCaptionList() {
  const box = $("#captions");
  const focused = document.activeElement?.closest?.(".cap")?.dataset.i;
  box.innerHTML = "";
  ed.captions.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "cap" + (i === ed.selected ? " selected" : "");
    row.dataset.i = i;
    row.innerHTML = `
      <div class="cap-head">
        <input class="t-start" value="${fmtTime(c.start)}" title="Start">
        <span class="muted">→</span>
        <input class="t-end" value="${fmtTime(c.end)}" title="End">
        <div class="spacer"></div>
        ${c.pos ? `<button class="btn ghost icon small pos-reset" data-act="unpos" title="Custom position — reset to shared">${icon("locate")}</button>` : ""}
        <button class="btn ghost icon small" data-act="split" title="Split at cursor">${icon("scissors")}</button>
        <button class="btn ghost icon small" data-act="toPrev" title="Move text to the end of the previous caption (Backspace at the start)" ${i === 0 ? "disabled" : ""}>${icon("to-prev")}</button>
        <button class="btn ghost icon small" data-act="toNext" title="Move text to the start of the next caption" ${i === ed.captions.length - 1 ? "disabled" : ""}>${icon("to-next")}</button>
        <button class="btn ghost icon small" data-act="insert" title="Insert empty caption after">${icon("plus")}</button>
        <button class="btn ghost icon small" data-act="delete" title="Delete">${icon("x")}</button>
      </div>
      <textarea rows="1" spellcheck="true"></textarea>
      <div class="chips"></div>`;
    const ta = $("textarea", row);
    ta.value = captionText(c);
    row.onclick = (e) => {
      if (e.target.closest("button, input")) return;
      select(i);
      if (video.paused && (video.currentTime < c.start || video.currentTime >= c.end)) seek(c.start + 0.01);
    };
    let editing = false;
    ta.onfocus = () => (editing = false);
    ta.oninput = () => {
      autoGrow(ta);
      const caps = ed.captions.slice();
      caps[i] = retimeText(c, ta.value);
      // No full re-render so the cursor stays put; one history entry per edit
      if (!editing) {
        ed.past.push(JSON.stringify(ed.captions));
        ed.future = [];
        editing = true;
        $("#btn-undo").disabled = false;
      }
      ed.captions = caps;
      updateOverlay(true);
      $(`.tl-cap[data-i="${i}"] .txt`).textContent = ta.value;
      renderChips($(".chips", row), i);
      scheduleSave();
    };
    ta.onblur = () => {
      // All text erased — delete the caption. Chrome also fires blur when the field is removed
      // from the DOM during a list re-render — such events are skipped.
      if (!row.isConnected) return;
      const cur = ed.captions[i];
      if (cur && !cur.words.length) commit(ed.captions.filter((_, j) => j !== i));
    };
    ta.onkeydown = (e) => {
      const collapsed = ta.selectionStart === ta.selectionEnd;
      // Like a text editor: Backspace at the start merges with the previous caption,
      // Delete at the end pulls in the next one
      if (e.key === "Backspace" && collapsed && ta.selectionStart === 0 && i > 0) {
        e.preventDefault();
        return moveText(i, -1);
      }
      if (e.key === "Delete" && collapsed && ta.selectionStart === ta.value.length && i + 1 < ed.captions.length) {
        e.preventDefault();
        return moveText(i + 1, -1, i);
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSplit(i, ta);
      }
    };
    const timeInput = (inp, which) => {
      inp.onchange = () => {
        const t = parseTime(inp.value);
        const cur = ed.captions[i];
        if (isNaN(t)) { inp.value = fmtTime(cur[which]); return; }
        const s = which === "start" ? Math.min(t, cur.end - 0.05) : cur.start;
        const en = which === "end" ? Math.max(t, cur.start + 0.05) : cur.end;
        const caps = ed.captions.slice();
        caps[i] = retimeRange(cur, s, en);
        commit(caps);
      };
    };
    timeInput($(".t-start", row), "start");
    timeInput($(".t-end", row), "end");
    $$("button[data-act]", row).forEach((b) => (b.onclick = () => capAction(b.dataset.act, i, ta)));
    renderChips($(".chips", row), i);
    box.appendChild(row);
    requestAnimationFrame(() => autoGrow(ta));
  });
  if (focused != null) $(`.cap[data-i="${focused}"] textarea`)?.focus();
}

// Caption words as "chips": click marks the accent word, Shift+click starts a new line at the word
function renderChips(box, i) {
  const cap = ed.captions[i];
  box.hidden = !cap.words.length;
  if (!cap.words.length) return;
  const em = emphasisIndices(cap.words);
  const manual = cap.words.some((w, j) => w.em || (j > 0 && w.br));
  box.innerHTML = "";
  cap.words.forEach((w, j) => {
    if (j > 0 && w.br) box.insertAdjacentHTML("beforeend", `<span class="chip-br" title="New line">${icon("corner-down-left")}</span>`);
    const chip = document.createElement("button");
    chip.className = "chip" + (em.has(j) ? " role-1" : "");
    chip.textContent = w.text;
    chip.title = "Click: accent word · Shift+click: start a new line here";
    chip.onclick = (e) => toggleChip(i, j, e.shiftKey);
    box.appendChild(chip);
  });
  if (manual) {
    const reset = document.createElement("button");
    reset.className = "btn ghost small chip-reset";
    reset.textContent = "Auto";
    reset.title = "Restore automatic accent and lines";
    reset.onclick = () => {
      const caps = ed.captions.slice();
      caps[i] = { ...cap, words: cap.words.map(({ em, br, ...w }) => w) };
      commit(caps);
    };
    box.appendChild(reset);
  }
}

function toggleChip(i, j, lineBreak) {
  const cap = ed.captions[i];
  const words = cap.words.map((w) => ({ ...w }));
  if (lineBreak) {
    if (j === 0) return;
    if (words[j].br) delete words[j].br; else words[j].br = true;
  } else {
    // The first click replaces the automatic accent with the chosen word
    if (!words.some((w) => w.em)) words.forEach((w) => delete w.em);
    if (words[j].em) delete words[j].em; else words[j].em = true;
  }
  const caps = ed.captions.slice();
  caps[i] = { ...cap, words };
  commit(caps);
}

// Move caption i's text into a neighbour: dir = -1 — to the end of the previous one, 1 — to the start of the next.
// The captions are merged; properties (e.g. own position) stay with the target caption.
function moveText(i, dir, focusIdx) {
  const j = i + dir;
  if (j < 0 || j >= ed.captions.length) return;
  const caps = ed.captions.slice();
  const [first, second] = dir < 0 ? [caps[j], caps[i]] : [caps[i], caps[j]];
  const joinAt = captionText(first).length + 1; // cursor goes to the join point
  caps.splice(Math.min(i, j), 2, mergeCaptions(first, second, dir < 0 ? "a" : "b"));
  const target = Math.min(i, j);
  commit(caps);
  select(target);
  const ta = $(`.cap[data-i="${target}"] textarea`);
  if (ta) {
    ta.focus();
    const pos = focusIdx != null ? joinAt - 1 : joinAt;
    ta.setSelectionRange(pos, pos);
  }
}

function doSplit(i, ta) {
  const c = ed.captions[i];
  const before = ta.value.slice(0, ta.selectionStart).trim();
  const wi = before ? before.split(/\s+/).length : 0;
  if (wi <= 0 || wi >= c.words.length) return toast("Place the cursor between words");
  const caps = ed.captions.slice();
  caps.splice(i, 1, ...splitCaption(c, wi));
  commit(caps);
  $(`.cap[data-i="${i + 1}"] textarea`)?.focus();
}

function capAction(act, i, ta) {
  const caps = ed.captions.slice();
  const c = caps[i];
  if (act === "split") return doSplit(i, ta);
  if (act === "unpos") {
    const { pos, ...rest } = c;
    caps[i] = rest;
    return commit(caps);
  }
  if (act === "toPrev") return moveText(i, -1);
  if (act === "toNext") return moveText(i, 1);
  if (act === "delete") {
    caps.splice(i, 1);
  } else if (act === "insert") {
    const next = caps[i + 1];
    const s = c.end, en = next ? Math.min(next.start, s + 2) : Math.min(s + 2, ed.project.duration);
    if (en - s < 0.2) return toast("No room for a new caption");
    caps.splice(i + 1, 0, { start: s, end: en, words: [{ text: "Text", start: s, end: en }] });
  }
  commit(caps);
}

$("#btn-add-cap").onclick = () => {
  const t = video.currentTime;
  if (findCaption(ed.captions, t) >= 0) return toast("There is already a caption here — move the playhead");
  const next = ed.captions.find((c) => c.start > t);
  const en = Math.min(t + 2, next ? next.start : ed.project.duration);
  commit([...ed.captions, { start: t, end: en, words: [{ text: "Text", start: t, end: en }] }]);
  const i = findCaption(ed.captions, t + 0.01);
  select(i, true);
  const ta = $(`.cap[data-i="${i}"] textarea`);
  ta?.focus();
  ta?.select();
};

$("#btn-rechunk").onclick = () => {
  commit(chunkWords(flattenWords(ed.captions), chunkOpts()));
  toast("Captions re-split");
};
$$("[data-shift]").forEach((b) => (b.onclick = () => commit(shiftAll(ed.captions, +b.dataset.shift))));
$("#btn-replace").onclick = () => {
  const find = $("#find").value;
  if (!find) return;
  const repl = $("#replace").value;
  let n = 0;
  const caps = ed.captions.map((c) => {
    const text = captionText(c);
    if (!text.includes(find)) return c;
    n += text.split(find).length - 1;
    return retimeText(c, text.split(find).join(repl));
  }).filter((c) => c.words.length);
  if (!n) return toast("Nothing found");
  commit(caps);
  toast(`Replaced: ${n}`);
};
$("#btn-restt").onclick = () => {
  if (!confirm("Transcribe again? Your current edits will be replaced.")) return;
  $("#stt-card").hidden = false;
  $("#stt-card").scrollIntoView({ behavior: "smooth" });
};

// ------------------------------------------------------------------ transcription

async function startTranscribe() {
  const btn = $("#btn-stt");
  const [engine, model] = $("#stt-model").value.split(":");
  btn.disabled = true;
  $("#stt-card").hidden = false;
  try {
    const { job } = await api(`/api/projects/${ed.project.id}/transcribe`, {
      method: "POST",
      body: { engine, model, language: $("#stt-lang").value || null, prompt: $("#stt-prompt").value || null },
    });
    const pid = ed.project.id;
    const res = await pollJob(job, $("#stt-progress"));
    if (ed.project?.id !== pid) return;
    if (!res.words.length) {
      toast("No speech found in the video", true);
      return;
    }
    commit(chunkWords(res.words, chunkOpts()));
    toast(`Done! Words recognized: ${res.words.length}`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}
$("#btn-stt").onclick = startTranscribe;

// Vosk only handles Ukrainian, with no punctuation and no prompts
function syncEngine() {
  const vosk = $("#stt-model").value.startsWith("vosk:");
  if (vosk) $("#stt-lang").value = "uk";
  $("#stt-lang").disabled = vosk;
  $("#stt-prompt-box").hidden = vosk;
  $("#stt-note").textContent = vosk
    ? "Vosk outputs text without capitalization or punctuation — you can fix them in the editor. The model is downloaded on first run."
    : "The first run downloads the speech model — this may take a couple of minutes.";
  localStorage.setItem("stt-model", $("#stt-model").value);
}
$("#stt-model").onchange = syncEngine;
$("#stt-lang").onchange = () => localStorage.setItem("stt-lang", $("#stt-lang").value);
if (localStorage.getItem("stt-model")) $("#stt-model").value = localStorage.getItem("stt-model");
if (localStorage.getItem("stt-lang")) $("#stt-lang").value = localStorage.getItem("stt-lang");
syncEngine();

// ------------------------------------------------------------------ style

function setStyle(patch) {
  const recolor = "scene" in patch || "autoColor" in patch;
  ed.style = { ...ed.style, ...patch };
  if (recolor) renderLooks();
  syncStyleControls();
  updateOverlay(true);
  scheduleSave();
}

function syncStyleControls() {
  const s = ed.style;
  const look = getLook(s.look);
  const colors = resolveColors(look, s);
  $$(".look").forEach((el) => el.classList.toggle("active", el.dataset.id === look.id));
  $("#st-auto").checked = !!s.autoColor;
  $("#st-auto-note").textContent = s.autoColor
    ? (s.scene ? "The accent color is picked to stand out from this video." : "Reading the video's colors…")
    : "Colors are set by hand.";
  $("#st-main").value = colors.main.toLowerCase();
  $("#st-accent").value = colors.accent.toLowerCase();
  const sw = $("#st-swatches");
  sw.innerHTML = "";
  for (const c of look.accents) {
    const b = document.createElement("button");
    b.className = "swatch" + (c.toLowerCase() === colors.accent.toLowerCase() ? " on" : "");
    b.style.setProperty("--c", c);
    b.title = c;
    b.onclick = () => setStyle({ autoColor: false, colors: { main: colors.main, accent: c } });
    sw.appendChild(b);
  }
  $("#st-size").value = s.size;
  $("#st-size").nextElementSibling.textContent = `${Math.round(s.size * 100)}%`;
  $("#st-entrance").value = s.entrance || "";
  $("#st-reset-pos").disabled = !s.offset.x && !s.offset.y && !ed.captions.some((c) => c.pos);
}

$("#st-auto").onchange = (e) => {
  if (e.target.checked) {
    setStyle({ autoColor: true, colors: null });
    if (!ed.style.scene) matchVideoColors(true);
  } else {
    const look = getLook(ed.style.look);
    setStyle({ autoColor: false, colors: resolveColors(look, ed.style) });
  }
};
for (const key of ["main", "accent"]) {
  $(`#st-${key}`).addEventListener("input", (e) => {
    const colors = resolveColors(getLook(ed.style.look), ed.style);
    setStyle({ autoColor: false, colors: { ...colors, [key]: e.target.value.toUpperCase() } });
  });
}
$("#st-size").addEventListener("input", (e) => setStyle({ size: +e.target.value }));
$("#st-entrance").onchange = (e) => setStyle({ entrance: e.target.value || null });
$("#st-reset-pos").onclick = () => {
  ed.style = { ...ed.style, offset: { x: 0, y: 0 } };
  if (ed.captions.some((c) => c.pos)) commit(ed.captions.map(({ pos, ...c }) => c));
  setStyle({});
};

// Dominant colors of the video decide the accent (stored in the style, so preview and export agree)
async function matchVideoColors(announce) {
  const p = ed.project;
  try {
    const scene = await analyzeVideo(`/api/projects/${p.id}/video`, p.duration);
    if (ed.project !== p) return;
    setStyle({ scene });
    if (announce) toast("Colors matched to the video");
  } catch {
    if (announce) toast("Could not read the video colors", true);
  }
}

// Look cards: the look's own layout of a sample phrase, over a still from this video
function sampleCaption(text) {
  let t = 0;
  const words = [];
  for (const [li, line] of text.split("|").entries()) {
    line.split(" ").filter(Boolean).forEach((raw, k) => {
      const w = { text: raw.replace("*", ""), start: t, end: t + 0.3 };
      if (raw.startsWith("*")) w.em = true;
      if (li > 0 && k === 0) w.br = true;
      words.push(w);
      t += 0.3;
    });
  }
  return { start: 0, end: t, words, pos: { x: 50, y: 10 } };
}

function lookPreview(look) {
  const W = 1080, H = 1080;
  const style = { ...ed.style, look: look.id, colors: null, size: 1, offset: { x: 0, y: 0 } };
  const lay = layoutCaption(sampleCaption(look.sample), { style, W, H, fonts: fontMap, index: 0 });
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  const pad = 60;
  const { x, y, w, h } = lay.box;
  const side = Math.max(w * 0.62, h) + pad * 2; // cards are wider than tall
  svg.setAttribute("viewBox", `${x + w / 2 - side / 1.24} ${y + h / 2 - side / 2} ${side / 0.62} ${side}`);
  svg.setAttribute("class", "look-svg");
  for (const wd of lay.words) {
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", wd.cx);
    t.setAttribute("y", wd.y);
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("font-family", `"sub-${wd.font}"`);
    t.setAttribute("font-size", wd.em);
    t.setAttribute("fill", wd.color);
    t.setAttribute("opacity", wd.opacity);
    if (wd.spacing) t.style.letterSpacing = `${wd.spacing}px`;
    if (wd.halo) t.style.filter = `drop-shadow(0 0 ${wd.halo.blur * 0.5}px ${wd.halo.color})`;
    if (wd.outline) {
      t.setAttribute("stroke", wd.outline.color);
      t.setAttribute("stroke-width", wd.outline.width * 2);
      t.setAttribute("paint-order", "stroke");
    }
    if (wd.fx?.type === "marker") {
      const [bx, by, bw, bh] = wd.box;
      const r = document.createElementNS(NS, "rect");
      Object.entries({ x: bx - bw * 0.02, y: by + 0.51 * bh, width: bw * 1.04, height: bh * 0.42, fill: wd.fx.color, opacity: 0.75 })
        .forEach(([k, v]) => r.setAttribute(k, v));
      svg.appendChild(r);
    }
    t.textContent = wd.text;
    svg.appendChild(t);
  }
  return svg;
}

function renderLooks() {
  const box = $("#looks");
  if (!fonts.length) return;
  box.innerHTML = "";
  for (const look of LOOKS) {
    const b = document.createElement("button");
    b.className = "look" + (look.id === ed.style.look ? " active" : "");
    b.dataset.id = look.id;
    const pv = document.createElement("div");
    pv.className = "look-pv";
    pv.appendChild(lookPreview(look));
    b.appendChild(pv);
    const name = document.createElement("div");
    name.className = "pn";
    name.textContent = look.name;
    b.appendChild(name);
    b.onclick = () => setStyle({ look: look.id, colors: ed.style.autoColor ? null : ed.style.colors && resolveColors(look, { ...ed.style, colors: null }), entrance: null });
    box.appendChild(b);
  }
  updateLookBackdrop();
}

// A frame of the video behind the look cards
function updateLookBackdrop() {
  if (!video.videoWidth) return;
  try {
    const c = document.createElement("canvas");
    c.width = 240;
    c.height = Math.round((240 * video.videoHeight) / video.videoWidth);
    c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
    $("#looks").style.setProperty("--still", `url(${c.toDataURL("image/jpeg", 0.7)})`);
  } catch {
    /* the still is decoration only */
  }
}
video.addEventListener("loadeddata", () => setTimeout(updateLookBackdrop, 300));

// ------------------------------------------------------------------ export

function showResult() {
  const url = `/api/projects/${ed.project.id}/output?v=${Date.now()}`;
  $("#result-video").src = url;
  $("#btn-download").href = url;
  $("#render-result").hidden = false;
}

// Word placements for the server: the same layout the preview draws
function withLayout(captions, style) {
  const p = ed.project;
  return layoutAll(captions, { style, W: p.width, H: p.height, fonts: fontMap });
}

async function render() {
  if (!ed.captions.length) return toast("Add subtitles first", true);
  const btn = $("#btn-render");
  btn.disabled = true;
  $("#render-result").hidden = true;
  try {
    await flushSave();
    const { job } = await api(`/api/projects/${ed.project.id}/render`, {
      method: "POST",
      body: { captions: withLayout(ed.captions, ed.style), style: ed.style },
    });
    await pollJob(job, $("#render-progress"));
    showResult();
    toast("Video is ready!");
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}
$("#btn-render").onclick = render;
$("#btn-export-top").onclick = () => switchTab("export");

$$("[data-dl]").forEach((b) => (b.onclick = async () => {
  const name = ed.project.name || "subtitles";
  const up = false;
  const kind = b.dataset.dl;
  if (kind === "srt") download(`${name}.srt`, toSRT(ed.captions, up));
  if (kind === "vtt") download(`${name}.vtt`, toVTT(ed.captions, up), "text/vtt");
  if (kind === "txt") download(`${name}.txt`, toTXT(ed.captions));
  if (kind === "ass") {
    const ass = await api(`/api/projects/${ed.project.id}/ass`, { method: "POST", body: { captions: withLayout(ed.captions, ed.style), style: ed.style } });
    download(`${name}.ass`, ass);
  }
}));

// ------------------------------------------------------------------ tabs and hotkeys

function switchTab(name) {
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => (t.hidden = t.dataset.tab !== name));
  if (name === "text") $$(".cap textarea").forEach(autoGrow);
}
$$(".tabs button").forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

$("#project-name").oninput = scheduleSave;
$("#btn-undo").onclick = undo;
$("#btn-redo").onclick = redo;
$("#chunk-words").onchange = $("#chunk-chars").onchange = scheduleSave;

document.addEventListener("keydown", (e) => {
  if (!ed.project) return;
  const typing = e.target.matches("input, textarea, select");
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !typing) {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if (typing) return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  if (e.key === "ArrowLeft") seek(video.currentTime - (e.shiftKey ? 1 : 0.1));
  if (e.key === "ArrowRight") seek(video.currentTime + (e.shiftKey ? 1 : 0.1));
});

// ------------------------------------------------------------------ startup

Promise.all([
  loadFonts().catch(() => toast("Failed to load fonts", true)),
  api("/stopwords.json").then(setStopwords),
])
  .then(() => {
    fontMap = Object.fromEntries(fonts.map((f) => [f.name, f]));
    overlay.setFonts(fonts);
    renderLooks();
    if (ed.project) updateOverlay(true);
  })
  .catch((e) => {
    console.error(e);
    toast(e.message, true);
  })
  .finally(route);
