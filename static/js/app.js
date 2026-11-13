import {
  BARS, DEFAULT_STYLE, PARTICLES, PRESETS, SubtitleOverlay, applyCase, comboLayout, findCaption, fxTextShadow, setStopwords,
} from "./overlay.js";
import {
  captionText, chunkWords, flattenWords, fmtTime, mergeCaptions, parseTime,
  retimeRange, retimeText, shiftAll, splitCaption, toSRT, toTXT, toVTT,
} from "./captions.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ------------------------------------------------------------------ общее

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
let combos = [];
async function loadFonts() {
  fonts = await api("/api/fonts");
  await Promise.all(
    fonts.map(async (f) => {
      const face = new FontFace(`sub-${f.name}`, `url(/fonts/${f.file})`);
      document.fonts.add(await face.load());
    }),
  );
}

// ------------------------------------------------------------------ роутинг

function route() {
  const m = location.hash.match(/^#\/p\/([a-f0-9]{12})/);
  $("#view-home").hidden = !!m;
  $("#view-editor").hidden = !m;
  if (m) openEditor(m[1]);
  else { closeEditor(); showHome(); }
}
window.addEventListener("hashchange", route);

// ------------------------------------------------------------------ главная

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
        <div class="small muted">${fmtTime(p.duration, false)} · ${p.width}×${p.height}${p.hasOutput ? " · ✓ экспортировано" : ""}</div>
      </div>
      <button class="p-del btn ghost icon small" title="Удалить">✕</button>`;
    $(".p-name", card).textContent = p.name;
    $(".p-del", card).onclick = async (e) => {
      e.preventDefault();
      if (!confirm(`Удалить проект «${p.name}»?`)) return;
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
  xhr.onerror = () => { bar.hidden = true; toast("Ошибка загрузки", true); };
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

// ------------------------------------------------------------------ редактор: состояние

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
  ed.style = { ...DEFAULT_STYLE, ...(p.style || {}) };
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
  renderAll();

  const auto = location.hash.includes("auto=1");
  history.replaceState(null, "", `#/p/${id}`);
  if (auto && !ed.captions.length && p.hasAudio !== false) startTranscribe();
}

function closeEditor() {
  if (!ed.project) return;
  if (ce.draft) cancelComboEditor(); // несохранённый свой стиль не оставляем в проекте
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
  $("#save-status").textContent = "Не сохранено";
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
        name: $("#project-name").value.trim() || "Без названия",
        captions: ed.captions,
        style: ed.style,
        chunk: chunkOpts(),
      },
    });
    $("#save-status").textContent = "Сохранено";
  } catch (e) {
    $("#save-status").textContent = "Ошибка сохранения";
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

// ------------------------------------------------------------------ плеер и превью

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
  overlay.configure({ style: ed.style, width: p.width, height: p.height, displayHeight: h });
  updateOverlay(true);
}
new ResizeObserver(layoutFrame).observe($("#frame-box"));

function updateOverlay(force = false) {
  if (!ed.project) return;
  if (force) overlay.configure({ style: ed.style, width: ed.project.width, height: ed.project.height, displayHeight: $("#frame").clientHeight });
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
  $("#btn-play").textContent = video.paused ? "▶" : "❚❚";
  $("#big-play").hidden = !video.paused;
};
video.onloadedmetadata = layoutFrame;
$("#btn-play").onclick = togglePlay;

// Размер превью на телефоне: крупный по умолчанию, компактный — по кнопке или пока правится текст
let compactPinned = localStorage.getItem("compact-preview") === "1";
function setCompact(on) {
  $("#view-editor").classList.toggle("compact", on);
  $("#btn-size").textContent = on ? "⤢" : "⤡";
  setTimeout(layoutFrame, 220); // после анимации высоты
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

// ------------------------------------------------------------------ перетаскивание текста по видео

let moveOne = localStorage.getItem("move-one") === "1";
function syncMoveMode() {
  $("#btn-move-mode").textContent = moveOne ? "✥ Эта подпись" : "✥ Все подписи";
  $("#btn-move-mode").classList.toggle("on", moveOne);
}
syncMoveMode();
$("#btn-move-mode").onclick = () => {
  moveOne = !moveOne;
  localStorage.setItem("move-one", moveOne ? "1" : "0");
  syncMoveMode();
  toast(moveOne ? "Перетаскивание двигает только текущую подпись" : "Перетаскивание двигает все подписи");
};

$("#sub-layer").addEventListener("pointerdown", (e) => {
  const block = e.target.closest(".sub-block");
  const idx = findCaption(ed.captions, video.currentTime);
  if (!block || idx < 0 || !block.childElementCount) return;
  e.preventDefault();
  const frame = $("#frame").getBoundingClientRect();
  const cap = ed.captions[idx];
  // Подпись со своей позицией двигается отдельно всегда; иначе — по режиму кнопки
  const own = moveOne || !!cap.pos;
  const start = own && cap.pos ? { ...cap.pos } : { x: ed.style.x, y: ed.style.position };
  const blockH = (block.offsetHeight / frame.height) * 100;
  const before = JSON.stringify(ed.captions);
  const x0 = e.clientX, y0 = e.clientY;
  let moved = false;
  block.setPointerCapture(e.pointerId);
  block.classList.add("dragging");

  block.onpointermove = (ev) => {
    if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
    moved = true;
    let x = start.x + ((ev.clientX - x0) / frame.width) * 100;
    let y = start.y - ((ev.clientY - y0) / frame.height) * 100;
    x = Math.max(5, Math.min(95, x));
    y = Math.max(0, Math.min(100 - blockH, y));
    const snap = Math.abs(x - 50) < 2.5;
    if (snap) x = 50;
    $("#snap-guide").hidden = !snap;
    x = Math.round(x * 10) / 10;
    y = Math.round(y * 10) / 10;
    if (own) {
      const caps = ed.captions.slice();
      caps[idx] = { ...ed.captions[idx], pos: { x, y } };
      ed.captions = caps;
    } else {
      ed.style = { ...ed.style, x, position: y };
      syncStyleControls();
    }
    updateOverlay(true);
  };
  block.onpointerup = block.onpointercancel = () => {
    block.onpointermove = block.onpointerup = block.onpointercancel = null;
    block.classList.remove("dragging");
    $("#snap-guide").hidden = true;
    if (!moved) return;
    // Щелчок после перетаскивания не должен ставить видео на паузу/воспроизведение
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

// ------------------------------------------------------------------ таймлайн

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

// ------------------------------------------------------------------ список подписей

function select(i, scroll = false) {
  ed.selected = i;
  $$(".cap.selected, .tl-cap.selected").forEach((el) => el.classList.remove("selected"));
  $(`.cap[data-i="${i}"]`)?.classList.add("selected");
  $(`.tl-cap[data-i="${i}"]`)?.classList.add("selected");
  if (scroll) $(`.cap[data-i="${i}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function autoGrow(ta) {
  if (!ta.offsetParent) return; // вкладка скрыта — высоту посчитаем при её открытии
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
        <input class="t-start" value="${fmtTime(c.start)}" title="Начало">
        <span class="muted">→</span>
        <input class="t-end" value="${fmtTime(c.end)}" title="Конец">
        <div class="spacer"></div>
        ${c.pos ? '<button class="btn ghost icon small pos-reset" data-act="unpos" title="Своя позиция — вернуть общую">⌖</button>' : ""}
        <button class="btn ghost icon small" data-act="split" title="Разделить по курсору">✂</button>
        <button class="btn ghost icon small" data-act="toPrev" title="Перенести текст в конец предыдущей подписи (Backspace в начале текста)" ${i === 0 ? "disabled" : ""}>⤒</button>
        <button class="btn ghost icon small" data-act="toNext" title="Перенести текст в начало следующей подписи" ${i === ed.captions.length - 1 ? "disabled" : ""}>⤓</button>
        <button class="btn ghost icon small" data-act="insert" title="Вставить пустую после">＋</button>
        <button class="btn ghost icon small" data-act="delete" title="Удалить">✕</button>
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
      // Без полной перерисовки, чтобы не сбить курсор; в историю — одна запись на правку
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
      // Стёрли весь текст — удаляем подпись. Chrome шлёт blur и при удалении поля из DOM
      // во время перерисовки списка — такие события пропускаем.
      if (!row.isConnected) return;
      const cur = ed.captions[i];
      if (cur && !cur.words.length) commit(ed.captions.filter((_, j) => j !== i));
    };
    ta.onkeydown = (e) => {
      const collapsed = ta.selectionStart === ta.selectionEnd;
      // Как в текстовом редакторе: Backspace в начале — склеить с предыдущей,
      // Delete в конце — подтянуть сюда следующую
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

// Слова подписи «чипсами» в шрифтах комбинированного стиля. Щелчок по слову:
// в стиле-акценте — сделать/убрать акцент, в стиле-строках — начать/не начинать с него строку.
function currentCombo() {
  if (ed.style.preset !== "combo") return null;
  return combos.find((c) => c.id === ed.style.combo) || ed.style.comboDef || combos[0];
}

function renderChips(box, i) {
  const combo = currentCombo();
  box.hidden = !combo;
  if (!combo) return;
  const cap = ed.captions[i];
  const layout = comboLayout(combo, cap.words);
  const accent = combo.layout === "accent";
  const manual = cap.words.some((w, j) => (accent ? w.em : j > 0 && w.br));
  box.innerHTML = "";
  cap.words.forEach((w, j) => {
    const [role, newLine, roleIdx] = layout[j];
    if (newLine) box.insertAdjacentHTML("beforeend", '<span class="chip-br" title="Новая строка">↵</span>');
    const chip = document.createElement("button");
    chip.className = `chip role-${roleIdx}`;
    chip.textContent = applyCase(w.text, role.case, ed.style.uppercase);
    chip.style.fontFamily = `"sub-${role.font}", sans-serif`;
    chip.title = accent ? "Сделать акцентом / убрать акцент" : j === 0 ? "Первое слово всегда начинает строку" : "Начать строку с этого слова / убрать перенос";
    chip.disabled = !accent && j === 0;
    chip.onclick = () => toggleChip(i, j, accent, layout);
    box.appendChild(chip);
  });
  if (manual) {
    const reset = document.createElement("button");
    reset.className = "btn ghost small chip-reset";
    reset.textContent = "Авто";
    reset.title = "Вернуть автоматическую раскладку";
    reset.onclick = () => {
      const caps = ed.captions.slice();
      caps[i] = { ...cap, words: cap.words.map(({ em, br, ...w }) => w) };
      commit(caps);
    };
    box.appendChild(reset);
  }
}

function toggleChip(i, j, accent, layout) {
  const cap = ed.captions[i];
  let words = cap.words.map((w) => ({ ...w }));
  if (accent) {
    // Первый щелчок заменяет автоматический акцент выбранным словом
    if (!words.some((w) => w.em)) words.forEach((w) => delete w.em);
    if (words[j].em) delete words[j].em; else words[j].em = true;
  } else {
    // Первый щелчок фиксирует текущие автоматические переносы, дальше правим их
    if (!words.some((w, k) => k > 0 && w.br)) layout.forEach(([, nl], k) => nl && (words[k].br = true));
    if (words[j].br) delete words[j].br; else words[j].br = true;
  }
  const caps = ed.captions.slice();
  caps[i] = { ...cap, words };
  commit(caps);
}

// Перенос текста подписи i в соседнюю: dir = -1 — в конец предыдущей, 1 — в начало следующей.
// Подписи склеиваются в одну; свойства (например, своя позиция) остаются у той, куда перенесли.
function moveText(i, dir, focusIdx) {
  const j = i + dir;
  if (j < 0 || j >= ed.captions.length) return;
  const caps = ed.captions.slice();
  const [first, second] = dir < 0 ? [caps[j], caps[i]] : [caps[i], caps[j]];
  const joinAt = captionText(first).length + 1; // курсор — на место стыка
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
  if (wi <= 0 || wi >= c.words.length) return toast("Поставьте курсор между словами");
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
    if (en - s < 0.2) return toast("Нет места для новой подписи");
    caps.splice(i + 1, 0, { start: s, end: en, words: [{ text: "Текст", start: s, end: en }] });
  }
  commit(caps);
}

$("#btn-add-cap").onclick = () => {
  const t = video.currentTime;
  if (findCaption(ed.captions, t) >= 0) return toast("В этот момент уже есть подпись — переместите курсор");
  const next = ed.captions.find((c) => c.start > t);
  const en = Math.min(t + 2, next ? next.start : ed.project.duration);
  commit([...ed.captions, { start: t, end: en, words: [{ text: "Текст", start: t, end: en }] }]);
  const i = findCaption(ed.captions, t + 0.01);
  select(i, true);
  const ta = $(`.cap[data-i="${i}"] textarea`);
  ta?.focus();
  ta?.select();
};

$("#btn-rechunk").onclick = () => {
  commit(chunkWords(flattenWords(ed.captions), chunkOpts()));
  toast("Подписи разбиты заново");
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
  if (!n) return toast("Ничего не найдено");
  commit(caps);
  toast(`Заменено: ${n}`);
};
$("#btn-restt").onclick = () => {
  if (!confirm("Распознать заново? Текущие правки будут заменены.")) return;
  $("#stt-card").hidden = false;
  $("#stt-card").scrollIntoView({ behavior: "smooth" });
};

// ------------------------------------------------------------------ распознавание

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
      toast("Речь не найдена в видео", true);
      return;
    }
    commit(chunkWords(res.words, chunkOpts()));
    toast(`Готово! Распознано слов: ${res.words.length}`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}
$("#btn-stt").onclick = startTranscribe;

// Vosk распознаёт только украинский, без пунктуации и подсказок
function syncEngine() {
  const vosk = $("#stt-model").value.startsWith("vosk:");
  if (vosk) $("#stt-lang").value = "uk";
  $("#stt-lang").disabled = vosk;
  $("#stt-prompt-box").hidden = vosk;
  $("#stt-note").textContent = vosk
    ? "Vosk выдаёт текст без заглавных букв и знаков препинания — их можно поправить в редакторе. Модель скачивается при первом запуске."
    : "Первый запуск скачивает модель распознавания — это может занять пару минут.";
  localStorage.setItem("stt-model", $("#stt-model").value);
}
$("#stt-model").onchange = syncEngine;
$("#stt-lang").onchange = () => localStorage.setItem("stt-lang", $("#stt-lang").value);
if (localStorage.getItem("stt-model")) $("#stt-model").value = localStorage.getItem("stt-model");
if (localStorage.getItem("stt-lang")) $("#stt-lang").value = localStorage.getItem("stt-lang");
syncEngine();

// ------------------------------------------------------------------ стиль

const STYLE_FIELDS = ["font", "fontSize", "uppercase", "color", "highlightColor", "outlineColor", "boxColor",
  "outline", "shadow", "boxOpacity", "wordScale", "position", "x", "maxWidth", "lineSpacing", "animation", "reveal"];

const VISIBLE = {
  font: ["highlight", "wordbox", "karaoke", "pop", "classic", "box"],
  reveal: ["highlight", "wordbox", "classic", "box"],
  highlightColor: ["highlight", "wordbox", "karaoke", "combo"],
  outlineColor: ["highlight", "karaoke", "pop", "classic", "combo"],
  outline: ["highlight", "karaoke", "pop", "classic", "combo"],
  shadow: ["highlight", "karaoke", "pop", "classic"],
  boxColor: ["box"],
  boxOpacity: ["box"],
  wordScale: ["highlight", "wordbox"],
  animation: ["highlight", "wordbox", "karaoke", "classic", "box", "combo"],
  lineSpacing: ["highlight", "wordbox", "karaoke", "classic", "combo"],
};

function fmtOut(key, v) {
  if (key === "boxOpacity") return `${Math.round((1 - v) * 100)}%`;
  if (key === "wordScale") return `${Math.round(v * 100)}%`;
  if (key === "position" || key === "maxWidth") return `${v}%`;
  if (key === "lineSpacing") return `${Math.round(v * 100)}%`;
  if (key === "x") return v == 50 ? "центр" : `${Math.round(v)}%`;
  return String(v);
}

function syncStyleControls() {
  const s = ed.style;
  const sel = $("#st-font");
  if (!sel.options.length) {
    for (const f of fonts) {
      const o = new Option(f.name, f.name);
      o.style.fontFamily = `"sub-${f.name}"`;
      sel.add(o);
    }
  }
  for (const k of STYLE_FIELDS) {
    const el = $(`#st-${k}`);
    if (el.type === "checkbox") el.checked = !!s[k];
    else el.value = s[k];
    const out = el.parentElement.querySelector("output");
    if (out) out.textContent = fmtOut(k, s[k]);
  }
  sel.style.fontFamily = `"sub-${s.font}"`;
  for (const [k, presets] of Object.entries(VISIBLE)) {
    $$(`[data-for="${k}"]`).forEach((el) => (el.hidden = !presets.includes(s.preset)));
  }
  const activeId = s.preset === "combo" ? `combo:${s.combo}` : s.preset;
  $$(".preset").forEach((el) => el.classList.toggle("active", el.dataset.id === activeId));
  $("#st-outline").closest(".slider").querySelector("span").textContent = s.preset === "combo" ? "Тень вокруг" : "Обводка";
  $('[data-for="highlightColor"]').firstChild.textContent = s.preset === "combo" ? "Второй цвет " : "Акцент ";
}

function setStyle(patch) {
  const prevLayout = `${ed.style.preset}:${ed.style.combo}:${ed.style.uppercase}`;
  ed.style = { ...ed.style, ...patch };
  if (`${ed.style.preset}:${ed.style.combo}:${ed.style.uppercase}` !== prevLayout) renderCaptionList();
  syncStyleControls();
  updateOverlay(true);
  scheduleSave();
}

for (const k of STYLE_FIELDS) {
  const el = $(`#st-${k}`);
  el.addEventListener("input", () => {
    const v = el.type === "checkbox" ? el.checked : el.type === "range" ? +el.value : el.value;
    setStyle({ [k]: v });
  });
}

function renderPresets() {
  const box = $("#presets");
  for (const p of PRESETS) {
    const b = document.createElement("button");
    b.className = "preset";
    b.dataset.id = p.id;
    b.innerHTML = `<div class="pv pv-${p.id}"><span>Твои</span> <span class="on">слова</span></div><div class="pn">${p.name}</div>`;
    b.onclick = () => setStyle(p.style);
    box.appendChild(b);
  }
}

// Карточки комбинированных стилей: образец набирается шрифтами самого шаблона
function comboCardPreview(c) {
  const pv = document.createElement("div");
  pv.className = "pv pv-combo";
  const roles = c.layout === "accent" ? [c.roles[0], c.roles[1], c.roles[0]] : [c.roles[0], ...c.roles.slice(1), c.roles[c.roles.length - 1]].slice(0, 3);
  ["Твої", "яскраві", "слова"].forEach((word, i) => {
    const r = roles[i % roles.length];
    const sp = document.createElement("span");
    sp.textContent = applyCase(word, r.case, false);
    sp.style.fontFamily = `"sub-${r.font}"`;
    sp.style.fontSize = `${Math.min(26, 14 * (r.size ?? 1))}px`;
    sp.style.color = r.color === "accent" ? c.style.highlightColor : c.style.color;
    if (r.spacing) sp.style.letterSpacing = `${r.spacing}em`;
    const fxShadow = fxTextShadow(r.fx, 0.35);
    if (fxShadow) sp.style.textShadow = fxShadow;
    if (FX_BADGE[r.fx?.type]) sp.dataset.sparkle = FX_BADGE[r.fx.type];
    if (r.fx?.type === "marker") sp.style.background = `linear-gradient(transparent 55%, ${r.fx.color}99 55%)`;
    if (r.fx?.type === "underline") sp.style.textDecoration = `underline ${r.fx.color}`;
    if (r.anim?.type) sp.classList.add("card-anim", `card-anim-${r.anim.type}`);
    pv.appendChild(sp);
  });
  return pv;
}

function applyCombo(c) {
  setStyle({ preset: "combo", combo: c.id, comboDef: c.custom ? c : null, uppercase: false, animation: "none", ...c.style });
}

function renderCombos() {
  const box = $("#combos");
  box.innerHTML = "";
  for (const c of combos) {
    const b = document.createElement("button");
    b.className = "preset";
    b.dataset.id = `combo:${c.id}`;
    b.appendChild(comboCardPreview(c));
    const pn = document.createElement("div");
    pn.className = "pn";
    pn.textContent = c.name;
    b.appendChild(pn);
    b.onclick = () => applyCombo(c);
    if (c.custom) {
      const edit = document.createElement("span");
      edit.className = "p-edit";
      edit.title = "Изменить стиль";
      edit.textContent = "✎";
      edit.onclick = (e) => { e.stopPropagation(); openComboEditor(c); };
      b.appendChild(edit);
    }
    box.appendChild(b);
  }
  const add = document.createElement("button");
  add.className = "preset preset-add";
  add.innerHTML = '<span class="plus">＋</span><span class="pn">Свой стиль</span>';
  add.onclick = () => openComboEditor(null);
  box.appendChild(add);
  syncStyleControls();
}

// ------------------------------------------------------------------ конструктор своих стилей

const ce = { draft: null, saved: null, prevStyle: null };
const FX_STRENGTH_LABEL = {
  glow: "Сила", shadow: "Сдвиг", outline: "Толщина", sparkle: "Количество", hearts: "Количество", confetti: "Количество",
  fireflies: "Количество", bubbles: "Количество", snow: "Количество", burst: "Лучи", marker: "Насыщенность", underline: "Толщина",
};
// Цвет эффекта по умолчанию; null — второй цвет стиля
const FX_DEFAULT_COLOR = {
  sparkle: "#FFFFFF", hearts: "#FF4D8D", fireflies: "#FFD27A", bubbles: "#9BE7FF", snow: "#FFFFFF", confetti: "#FFFFFF",
};
const FX_BADGE = { sparkle: "✦", hearts: "♥", confetti: "⁂", fireflies: "•", bubbles: "○", snow: "❄", burst: "✺" };
const LAYOUT_HINT = {
  stack: "Подпись делится на две строки: первая — основным шрифтом, вторая — вторым.",
  accent: "Слова набраны основным шрифтом, главное слово — вторым. Акцент можно выбрать щелчком по слову во вкладке «Текст».",
};

function upsertCombo(c) {
  const i = combos.findIndex((x) => x.id === c.id);
  if (i >= 0) combos[i] = c; else combos.push(c);
  overlay.setCombos(combos);
}

function openComboEditor(combo) {
  if (ce.draft) cancelComboEditor();
  ce.saved = combo ? structuredClone(combo) : null;
  ce.prevStyle = { ...ed.style };
  ce.draft = combo ? structuredClone(combo) : {
    id: `custom-${Math.random().toString(36).slice(2, 10)}`,
    name: "",
    layout: "stack",
    roles: [
      { font: "Montserrat", size: 1.25, case: "upper" },
      { font: "Marck Script", size: 1.35, color: "accent", case: "lower" },
    ],
    style: { color: "#FFFFFF", highlightColor: "#FFE45C", fontSize: 5.0, outline: 4 },
    custom: true,
  };
  $("#ce-title").textContent = combo ? "Изменить стиль" : "Новый стиль";
  $("#ce-delete").hidden = !combo;
  $("#combo-editor").hidden = false;
  fillComboEditor();
  // размер и обводка — из стиля; дальше их можно менять обычными ползунками ниже
  ed.style = { ...ed.style, fontSize: ce.draft.style.fontSize, outline: ce.draft.style.outline, lineSpacing: ce.draft.style.lineSpacing ?? 1 };
  applyDraft();
  renderCombos();
  $("#combo-editor").scrollIntoView({ behavior: "smooth", block: "start" });
}

function fillComboEditor() {
  const d = ce.draft;
  $("#ce-name").value = d.name;
  $$("#ce-layout button").forEach((b) => b.classList.toggle("on", b.dataset.v === d.layout));
  $("#ce-layout-hint").textContent = LAYOUT_HINT[d.layout];
  $$(".ce-role").forEach((box) => {
    const r = d.roles[+box.dataset.role];
    renderFontPicker($(".ce-font", box), r);
    $(".ce-size", box).value = r.size ?? 1;
    $(".ce-size", box).nextElementSibling.textContent = `${Math.round((r.size ?? 1) * 100)}%`;
    $(".ce-spacing", box).value = r.spacing ?? 0;
    $(".ce-spacing", box).nextElementSibling.textContent = r.spacing ? `${Math.round(r.spacing * 100)}%` : "нет";
    $$(".ce-case button", box).forEach((b) => b.classList.toggle("on", b.dataset.v === (r.case || "")));
    const acc = $(".ce-accent", box);
    if (acc) acc.checked = r.color === "accent";
    const fxBox = $(".ce-fx", box);
    if (fxBox) {
      const type = r.fx?.type || "";
      $$(".ce-fx-type button", fxBox).forEach((b) => b.classList.toggle("on", b.dataset.v === type));
      $(".ce-fx-opts", fxBox).hidden = !type;
      if (type) {
        $(".ce-fx-color", fxBox).value = r.fx.color;
        $(".ce-fx-strength", fxBox).value = r.fx.strength;
        $(".ce-fx-strength", fxBox).nextElementSibling.textContent = r.fx.strength;
        $(".ce-fx-strength-label", fxBox).textContent = FX_STRENGTH_LABEL[type];
        $(".ce-fx-color", fxBox).closest(".row").hidden = type === "confetti"; // у конфетти своя палитра
      }
      const an = r.anim?.type || "";
      $$(".ce-anim-type button", fxBox).forEach((b) => b.classList.toggle("on", b.dataset.v === an));
      $(".ce-anim-opts", fxBox).hidden = !an;
      if (an) {
        $(".ce-anim-strength", fxBox).value = r.anim.strength;
        $(".ce-anim-strength", fxBox).nextElementSibling.textContent = r.anim.strength;
        $(".ce-anim-speed", fxBox).value = r.anim.speed;
        $(".ce-anim-speed", fxBox).nextElementSibling.textContent = r.anim.speed;
      }
    }
  });
  $("#ce-color").value = d.style.color;
  $("#ce-color2").value = d.style.highlightColor;
}

// Выбор шрифта образцами: на телефоне обычный <select> показывает все шрифты одинаково
const FONT_GROUPS = [
  ["Гротески", ["Montserrat", "Montserrat SemiBold", "Inter", "Roboto", "Rubik", "Comfortaa", "Unbounded", "Russo One"]],
  ["Узкие", ["Oswald", "PT Sans Narrow"]],
  ["С засечками", ["Playfair Display", "Playfair Display Italic", "Cormorant Italic"]],
  ["Рукописные", ["Marck Script", "Caveat", "Bad Script", "Lobster", "Great Vibes"]],
];

function fontTile(cls, name, role) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.dataset.font = name;
  const sample = document.createElement("span");
  sample.className = "fp-sample";
  sample.textContent = applyCase("Яскраві слова", role.case, false);
  sample.style.fontFamily = `"sub-${name}", sans-serif`;
  if (role.spacing) sample.style.letterSpacing = `${role.spacing}em`;
  const label = document.createElement("span");
  label.className = "fp-name";
  label.textContent = name;
  b.append(sample, label);
  return b;
}

function renderFontPicker(picker, role) {
  const open = picker.classList.contains("open");
  picker.innerHTML = "";
  const cur = fontTile("fp-current", role.font, role);
  cur.insertAdjacentHTML("beforeend", '<span class="fp-caret">▾</span>');
  picker.appendChild(cur);
  const grid = document.createElement("div");
  grid.className = "fp-grid";
  const known = new Set(fonts.map((f) => f.name));
  const grouped = new Set(FONT_GROUPS.flatMap(([, list]) => list));
  const groups = [...FONT_GROUPS, ["Другие", [...known].filter((n) => !grouped.has(n))]];
  for (const [title, list] of groups) {
    const names = list.filter((n) => known.has(n));
    if (!names.length) continue;
    grid.insertAdjacentHTML("beforeend", `<div class="fp-group">${title}</div>`);
    for (const name of names) {
      const t = fontTile("fp-item", name, role);
      t.classList.toggle("on", name === role.font);
      grid.appendChild(t);
    }
  }
  picker.appendChild(grid);
  picker.classList.toggle("open", open);
}

// Черновик сразу показывается на видео
function applyDraft() {
  upsertCombo(ce.draft);
  setStyle({ preset: "combo", combo: ce.draft.id, comboDef: ce.draft, uppercase: false, color: ce.draft.style.color, highlightColor: ce.draft.style.highlightColor });
  const card = $(`.preset[data-id="combo:${ce.draft.id}"]`);
  if (card) {
    card.querySelector(".pv").replaceWith(comboCardPreview(ce.draft));
    card.querySelector(".pn").textContent = ce.draft.name || "Новый стиль";
  }
}

let chipsFrame = 0;
function editDraft(fn) {
  fn(ce.draft);
  fillComboEditor();
  applyDraft();
  // «чипсы» на вкладке «Текст» набраны шрифтами стиля — обновим их (не чаще раза за кадр)
  cancelAnimationFrame(chipsFrame);
  chipsFrame = requestAnimationFrame(renderCaptionList);
}

$("#ce-name").oninput = (e) => editDraft((d) => (d.name = e.target.value));
$$("#ce-layout button").forEach((b) => (b.onclick = () => editDraft((d) => (d.layout = b.dataset.v))));
$$(".ce-role").forEach((box) => {
  const role = (d) => d.roles[+box.dataset.role];
  $(".ce-font", box).addEventListener("click", (e) => {
    const item = e.target.closest(".fp-item");
    if (item) {
      e.currentTarget.classList.remove("open");
      return editDraft((d) => (role(d).font = item.dataset.font));
    }
    if (e.target.closest(".fp-current")) {
      const picker = e.currentTarget;
      const open = !picker.classList.contains("open");
      $$(".font-picker.open").forEach((p) => p.classList.remove("open"));
      picker.classList.toggle("open", open);
      if (open) picker.querySelector(".fp-item.on")?.scrollIntoView({ block: "nearest" });
    }
  });
  $(".ce-size", box).oninput = (e) => editDraft((d) => (role(d).size = +e.target.value));
  $(".ce-spacing", box).oninput = (e) => editDraft((d) => {
    if (+e.target.value > 0) role(d).spacing = +e.target.value; else delete role(d).spacing;
  });
  $$(".ce-case button", box).forEach((b) => (b.onclick = () => editDraft((d) => {
    if (b.dataset.v) role(d).case = b.dataset.v; else delete role(d).case;
  })));
  const acc = $(".ce-accent", box);
  if (acc) acc.onchange = () => editDraft((d) => {
    if (acc.checked) role(d).color = "accent"; else delete role(d).color;
  });
  const fxBox = $(".ce-fx", box);
  if (fxBox) {
    $$(".ce-fx-type button", fxBox).forEach((b) => (b.onclick = () => editDraft((d) => {
      const r = role(d);
      if (!b.dataset.v) return delete r.fx;
      // при смене эффекта — его цвет по умолчанию; между свечением/тенью/обводкой/маркером
      // (у которых это второй цвет стиля) выбранный цвет сохраняется
      const own = (t) => FX_DEFAULT_COLOR[t] ?? null;
      const keep = r.fx && own(r.fx.type) === null && own(b.dataset.v) === null;
      const color = keep ? r.fx.color : own(b.dataset.v) ?? d.style.highlightColor;
      r.fx = { type: b.dataset.v, color, strength: r.fx?.strength ?? 5 };
    })));
    $(".ce-fx-color", fxBox).oninput = (e) => editDraft((d) => (role(d).fx.color = e.target.value));
    $(".ce-fx-strength", fxBox).oninput = (e) => editDraft((d) => (role(d).fx.strength = +e.target.value));
    $$(".ce-anim-type button", fxBox).forEach((b) => (b.onclick = () => editDraft((d) => {
      const r = role(d);
      if (!b.dataset.v) return delete r.anim;
      r.anim = { type: b.dataset.v, strength: r.anim?.strength ?? 5, speed: r.anim?.speed ?? 5 };
    })));
    $(".ce-anim-strength", fxBox).oninput = (e) => editDraft((d) => (role(d).anim.strength = +e.target.value));
    $(".ce-anim-speed", fxBox).oninput = (e) => editDraft((d) => (role(d).anim.speed = +e.target.value));
  }
});
$("#ce-color").oninput = (e) => editDraft((d) => (d.style.color = e.target.value));
$("#ce-color2").oninput = (e) => editDraft((d) => (d.style.highlightColor = e.target.value));

function closeComboEditor() {
  ce.draft = ce.saved = ce.prevStyle = null;
  $("#combo-editor").hidden = true;
  renderCombos();
}

function cancelComboEditor() {
  const { draft, saved, prevStyle } = ce;
  if (saved) upsertCombo(saved);
  else combos.splice(combos.findIndex((c) => c.id === draft.id), 1);
  overlay.setCombos(combos);
  closeComboEditor();
  ed.style = prevStyle;
  setStyle({});
}

$("#ce-cancel").onclick = cancelComboEditor;

$("#ce-save").onclick = async () => {
  const d = ce.draft;
  // размер и обводку берём из текущих ползунков стиля — пользователь мог их подстроить
  d.style.fontSize = ed.style.fontSize;
  d.style.outline = ed.style.outline;
  d.style.lineSpacing = ed.style.lineSpacing;
  if (!d.name.trim()) d.name = "Мой стиль";
  try {
    const saved = await api(`/api/custom-combos/${d.id}`, { method: "PUT", body: d });
    upsertCombo(saved);
    closeComboEditor();
    applyCombo(saved);
    toast(`Стиль «${saved.name}» сохранён`);
  } catch (e) {
    toast(e.message, true);
  }
};

$("#ce-delete").onclick = async () => {
  const d = ce.draft;
  if (!confirm(`Удалить стиль «${ce.saved.name}»? В проектах, где он уже выбран, он сохранится.`)) return;
  await api(`/api/custom-combos/${d.id}`, { method: "DELETE" });
  combos.splice(combos.findIndex((c) => c.id === d.id), 1);
  overlay.setCombos(combos);
  const prev = ce.prevStyle;
  closeComboEditor();
  ed.style = { ...prev, comboDef: prev.combo === d.id ? ce.saved ?? prev.comboDef : prev.comboDef };
  setStyle({});
  toast("Стиль удалён");
};

// ------------------------------------------------------------------ экспорт

function showResult() {
  const url = `/api/projects/${ed.project.id}/output?v=${Date.now()}`;
  $("#result-video").src = url;
  $("#btn-download").href = url;
  $("#render-result").hidden = false;
}

// При интервале ≠ 100% сервер выводит каждую строку отдельно — ему нужно знать, где
// предпросмотр переносит строки. Считаем это во скрытом слое того же размера, что и превью.
function withLines(captions, style) {
  const f = style.lineSpacing ?? 1;
  const needLines = !(Math.abs(f - 1) < 1e-3 || style.preset === "box" || style.preset === "pop");
  const combo = style.preset === "combo" ? currentCombo() : null;
  const boxFx = new Set(["sparkle", ...PARTICLES, ...BARS]);
  const needFx = !!combo?.roles.some((r) => boxFx.has(r.fx?.type) || (r.anim?.type && r.anim.type !== "none"));
  if (!needLines && !needFx) return captions;
  const p = ed.project;
  const h = Math.min(p.height, 1280), w = (h * p.width) / p.height;
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${w}px;height:${h}px;visibility:hidden;`;
  const layer = document.createElement("div");
  layer.className = "sub-layer";
  host.appendChild(layer);
  document.body.appendChild(host);
  const ov = new SubtitleOverlay(layer);
  ov.setFonts(fonts);
  ov.setCombos(combos);
  ov.configure({ style, width: p.width, height: p.height, displayHeight: h });
  // ширина слов меняется по ходу подписи только у увеличенного активного слова
  const perWord = (style.preset === "highlight" || style.preset === "wordbox") && Math.abs(style.wordScale - 1) > 1e-3;
  try {
    const toVideo = p.height / h;
    return captions.map((cap) => {
      if (!cap.words.length) return cap;
      const out = { ...cap };
      if (needLines) {
        out.lines = perWord
          ? cap.words.map((_, i) => ov.layoutStarts(cap, i))
          : ov.layoutStarts(cap, cap.words.length - 1);
      }
      if (needFx) {
        // рамки слов с блёстками в пикселях видео — вокруг них сервер рисует звёзды
        ov.layoutStarts(cap, cap.words.length - 1);
        out.fx = Object.fromEntries(Object.entries(ov.lastFxBoxes).map(([j, b]) => [j, b.map((v) => +(v * toVideo).toFixed(1))]));
      }
      return out;
    });
  } finally {
    host.remove();
  }
}

async function render() {
  if (!ed.captions.length) return toast("Сначала добавьте субтитры", true);
  const btn = $("#btn-render");
  btn.disabled = true;
  $("#render-result").hidden = true;
  try {
    await flushSave();
    const { job } = await api(`/api/projects/${ed.project.id}/render`, {
      method: "POST",
      body: { captions: withLines(ed.captions, ed.style), style: ed.style },
    });
    await pollJob(job, $("#render-progress"));
    showResult();
    toast("Видео готово!");
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
  const up = ed.style.uppercase;
  const kind = b.dataset.dl;
  if (kind === "srt") download(`${name}.srt`, toSRT(ed.captions, up));
  if (kind === "vtt") download(`${name}.vtt`, toVTT(ed.captions, up), "text/vtt");
  if (kind === "txt") download(`${name}.txt`, toTXT(ed.captions));
  if (kind === "ass") {
    const ass = await api(`/api/projects/${ed.project.id}/ass`, { method: "POST", body: { captions: withLines(ed.captions, ed.style), style: ed.style } });
    download(`${name}.ass`, ass);
  }
}));

// ------------------------------------------------------------------ вкладки и горячие клавиши

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

// ------------------------------------------------------------------ старт

renderPresets();
Promise.all([
  loadFonts(),
  Promise.all([api("/combos.json"), api("/api/custom-combos")]).then(([builtin, custom]) => (combos = [...builtin, ...custom])),
  api("/stopwords.json").then(setStopwords),
])
  .then(() => {
    overlay.setFonts(fonts);
    overlay.setCombos(combos);
    renderCombos();
  })
  .catch(() => toast("Не удалось загрузить шрифты", true))
  .finally(route);
