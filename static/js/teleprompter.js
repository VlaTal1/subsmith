import { hydrateIcons, setIcon } from "./icons.js";

const $ = (s) => document.querySelector(s);
hydrateIcons();

const SETTINGS = ["speed", "size", "width", "mirror", "camera", "aspect"];
const store = JSON.parse(localStorage.getItem("tp-settings") || "{}");
$("#script").value = localStorage.getItem("tp-script") || "";

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 4000);
}

// ------------------------------------------------------------------ settings

for (const k of SETTINGS) {
  const el = $(`#${k}`);
  if (k in store) el.type === "checkbox" ? (el.checked = store[k]) : (el.value = store[k]);
  el.addEventListener("input", saveSettings);
}
function val(k) {
  const el = $(`#${k}`);
  return el.type === "checkbox" ? el.checked : el.type === "range" ? +el.value : el.value;
}
function saveSettings() {
  const s = {};
  for (const k of SETTINGS) s[k] = val(k);
  localStorage.setItem("tp-settings", JSON.stringify(s));
  document.querySelectorAll(".slider").forEach((sl) => (sl.querySelector("output").textContent = sl.querySelector("input").value));
  $("#cam-opts").hidden = !val("camera");
}
saveSettings();

function updateInfo() {
  const text = $("#script").value;
  localStorage.setItem("tp-script", text);
  const words = text.split(/\s+/).filter(Boolean).length;
  // ~140 words per minute — average speaking pace
  const min = words / 140;
  $("#script-info").textContent = words ? `${words} words · about ${Math.max(1, Math.round(min * 60))} s to read` : "";
}
$("#script").oninput = updateInfo;
updateInfo();

async function listCameras() {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    const sel = $("#cam-select");
    sel.innerHTML = "";
    devices.forEach((d, i) => sel.add(new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
    if (store.camId && devices.some((d) => d.deviceId === store.camId)) sel.value = store.camId;
  } catch {}
}
listCameras();
$("#cam-select").onchange = () => {
  store.camId = $("#cam-select").value;
  localStorage.setItem("tp-settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("tp-settings")), camId: store.camId }));
};

// ------------------------------------------------------------------ prompter

const tp = { pos: 0, playing: false, last: 0, stream: null, recorder: null, chunks: [], recStart: 0, recElapsed: 0, canvasLoop: 0, blob: null };

function show(id) {
  for (const s of ["setup", "prompter", "result"]) $(`#${s}`).hidden = s !== id;
}

async function startCamera() {
  const portrait = val("aspect") === "portrait";
  const camId = $("#cam-select").value;
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      ...(camId ? { deviceId: { exact: camId } } : { facingMode: "user" }),
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    },
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  tp.stream = stream;
  const cam = $("#cam");
  cam.srcObject = stream;
  await new Promise((r) => (cam.onloadedmetadata = r));
  if (!$("#cam-select").options.length || !$("#cam-select").options[0].label) listCameras();

  // Record via a center-cropped canvas so the output has the right aspect ratio (9:16 / 16:9)
  const vw = cam.videoWidth, vh = cam.videoHeight;
  const target = portrait ? 9 / 16 : 16 / 9;
  let cw = vw, ch = vh;
  if (vw / vh > target) cw = Math.round(vh * target); else ch = Math.round(vw / target);
  cw -= cw % 2; ch -= ch % 2;
  const canvas = Object.assign(document.createElement("canvas"), { width: cw, height: ch });
  const ctx = canvas.getContext("2d");
  const sx = (vw - cw) / 2, sy = (vh - ch) / 2;
  const draw = () => {
    ctx.drawImage(cam, sx, sy, cw, ch, 0, 0, cw, ch);
    tp.canvasLoop = requestAnimationFrame(draw);
  };
  draw();
  const out = canvas.captureStream(30);
  stream.getAudioTracks().forEach((t) => out.addTrack(t));
  tp.recStream = out;
}

function pickMime() {
  const types = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4"];
  return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
}

function stopCamera() {
  cancelAnimationFrame(tp.canvasLoop);
  tp.stream?.getTracks().forEach((t) => t.stop());
  tp.stream = null;
  $("#cam").srcObject = null;
}

async function start() {
  const text = $("#script").value.trim();
  if (!text) return toast("Add the script text", true);
  const t = $("#text");
  t.textContent = text;
  t.style.fontSize = `${val("size")}px`;
  t.style.width = `${val("width")}%`;
  $("#scroller").classList.toggle("mirror", val("mirror"));
  $("#cam").hidden = $("#shade").hidden = !val("camera");
  tp.pos = 0;
  applyPos();
  updateSpeedLabel();
  show("prompter");
  document.documentElement.requestFullscreen?.().catch(() => {});

  if (val("camera")) {
    try {
      await startCamera();
    } catch (e) {
      toast("No camera access: " + e.message, true);
      $("#cam").hidden = $("#shade").hidden = true;
    }
  }
  setPlayButton();
}

async function countdown() {
  const el = $("#countdown");
  el.hidden = false;
  for (let i = 3; i > 0; i--) {
    el.textContent = i;
    await new Promise((r) => setTimeout(r, 800));
  }
  el.hidden = true;
}

async function togglePlay() {
  if (tp.playing) {
    tp.playing = false;
    if (tp.recorder?.state === "recording") {
      tp.recorder.pause();
      tp.recElapsed += performance.now() - tp.recStart;
    }
  } else {
    if (tp.stream && !tp.recorder) {
      await countdown();
      const mime = pickMime();
      tp.chunks = [];
      tp.recorder = new MediaRecorder(tp.recStream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
      tp.recorder.ondataavailable = (e) => e.data.size && tp.chunks.push(e.data);
      tp.recorder.start(1000);
      tp.recElapsed = 0;
      $("#rec-badge").hidden = false;
    } else if (tp.recorder?.state === "paused") {
      tp.recorder.resume();
    }
    tp.recStart = performance.now();
    tp.playing = true;
    tp.last = performance.now();
    requestAnimationFrame(loop);
  }
  setPlayButton();
}

function setPlayButton() {
  const rec = !!tp.stream;
  setIcon($("#btn-toggle"), tp.playing ? "pause" : rec && !tp.recorder ? "record" : "play", tp.playing ? "Pause" : rec && !tp.recorder ? "Record" : "Start");
}

function applyPos() {
  $("#text").style.transform = `translateY(${-tp.pos}px)`;
}

function loop(now) {
  if (!tp.playing) return;
  const dt = (now - tp.last) / 1000;
  tp.last = now;
  tp.pos += val("speed") * dt;
  const max = $("#text").scrollHeight - innerHeight * 1.1;
  if (tp.pos >= max) tp.pos = max;
  applyPos();
  if (tp.recorder) {
    const ms = tp.recElapsed + (now - tp.recStart);
    const s = Math.floor(ms / 1000);
    $("#rec-time").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  requestAnimationFrame(loop);
}

function changeSpeed(d) {
  const el = $("#speed");
  el.value = Math.max(+el.min, Math.min(+el.max, +el.value + d));
  saveSettings();
  updateSpeedLabel();
}
function updateSpeedLabel() {
  $("#speed-label").textContent = val("speed");
}

async function exit() {
  tp.playing = false;
  document.fullscreenElement && document.exitFullscreen().catch(() => {});
  $("#rec-badge").hidden = true;
  if (tp.recorder) {
    const rec = tp.recorder;
    tp.recorder = null;
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    stopCamera();
    tp.blob = new Blob(tp.chunks, { type: rec.mimeType || "video/webm" });
    const url = URL.createObjectURL(tp.blob);
    $("#recorded").src = url;
    const ext = tp.blob.type.includes("mp4") ? "mp4" : "webm";
    $("#btn-save").href = url;
    $("#btn-save").download = `recording-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}.${ext}`;
    show("result");
  } else {
    stopCamera();
    show("setup");
  }
}

$("#btn-start").onclick = start;
$("#btn-toggle").onclick = togglePlay;
$("#btn-exit").onclick = exit;
$("#btn-faster").onclick = () => changeSpeed(10);
$("#btn-slower").onclick = () => changeSpeed(-10);
$("#btn-restart").onclick = () => { tp.pos = 0; applyPos(); };
$("#scroller").onclick = togglePlay;
$("#scroller").addEventListener("wheel", (e) => {
  e.preventDefault();
  tp.pos = Math.max(0, tp.pos + e.deltaY);
  applyPos();
}, { passive: false });

// Swipe scrolling
let touchY = null;
$("#scroller").addEventListener("touchstart", (e) => (touchY = e.touches[0].clientY), { passive: true });
$("#scroller").addEventListener("touchmove", (e) => {
  tp.pos = Math.max(0, tp.pos + (touchY - e.touches[0].clientY));
  touchY = e.touches[0].clientY;
  applyPos();
}, { passive: true });

document.addEventListener("keydown", (e) => {
  if ($("#prompter").hidden) return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  if (e.key === "ArrowUp") { e.preventDefault(); changeSpeed(10); }
  if (e.key === "ArrowDown") { e.preventDefault(); changeSpeed(-10); }
  if (e.key === "Escape") exit();
});

// ------------------------------------------------------------------ result

$("#btn-retake").onclick = $("#btn-back").onclick = () => show("setup");

$("#btn-subs").onclick = () => {
  if (!tp.blob) return;
  const btn = $("#btn-subs");
  btn.disabled = true;
  const bar = $("#up-progress");
  bar.hidden = false;
  const fd = new FormData();
  const ext = tp.blob.type.includes("mp4") ? "mp4" : "webm";
  fd.append("file", tp.blob, `recording.${ext}`);
  fd.append("name", `Recording ${new Date().toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}`);
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/projects");
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) bar.firstElementChild.style.width = `${(e.loaded / e.total) * 90}%`;
  };
  xhr.onload = () => {
    btn.disabled = false;
    if (xhr.status !== 200) {
      bar.hidden = true;
      let msg = xhr.statusText;
      try { msg = JSON.parse(xhr.responseText).detail; } catch {}
      return toast(msg, true);
    }
    const p = JSON.parse(xhr.responseText);
    // The script is a recognition hint: names and terms are recognized more accurately
    sessionStorage.setItem(`prompt:${p.id}`, $("#script").value.slice(0, 800));
    location.href = `/#/p/${p.id}?auto=1`;
  };
  xhr.onerror = () => { btn.disabled = false; bar.hidden = true; toast("Upload failed", true); };
  xhr.send(fd);
};
