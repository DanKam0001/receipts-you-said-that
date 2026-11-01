import { fitQuote, receiptCountLabel } from "/overlay-layout.js";
import { ANNOUNCER_FILES } from "/show-control.js";

const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
const $ = selector => document.querySelector(selector);
const stamp = $("#stamp"), hallLabel = $("#hallLabel"), panel = $("#panel"), claimLine = $("#claim"), quote = $("#quote");
const reason = $("#reason"), reasonIcon = $("#reasonIcon"), reasonText = $("#reasonText"), meta = $("#meta");
const vetoWrap = $("#vetoWrap"), vetoFill = $("#vetoFill"), wave = $("#wave"), waveCtx = wave.getContext("2d");
const recordStrip = $("#recordStrip"), recordQuote = $("#recordQuote"), player = $("#showAudio");
const params = new URLSearchParams(location.search);
let lastPanelKey = "", lastSoundEvent = "", lastPlaybackRequest = "", lastStopRequest = "";
let activeReceipt, visibleStart = 0, visibleEnd = 0, lastFitKey = "", clearTimer;
let audioQueue = [], currentTask, audioGeneration = 0, taskTimer, audioContext, analyser, frequency;
const announcerWhitelist = new Set(ANNOUNCER_FILES);

if (params.get("scripted") === "1") $("#scripted").style.display = "inline-block";
function renderHearts(lives, max) {
  const root = $("#hearts"); root.replaceChildren();
  for (let i = 0; i < max; i++) { const heart = document.createElement("span"); heart.className = i < lives ? "heart-live" : "heart-lost"; heart.textContent = i < lives ? "♥" : "♡"; root.append(heart); }
}
function wordsInQuote() { return activeReceipt?.quote?.match(/\S+/g) ?? []; }
function renderQuote(activeIndex = 0) {
  if (!activeReceipt?.quote) return;
  const fit = fitQuote(activeReceipt.quote, Math.max(1, quote.clientWidth || 1800), activeIndex);
  const key = `${fit.startWord}:${fit.endWord}:${fit.fontSize}:${fit.text}`;
  if (key === lastFitKey) return;
  lastFitKey = key; visibleStart = fit.startWord; visibleEnd = fit.endWord;
  quote.style.setProperty("--quote-size", `${fit.fontSize}px`); quote.replaceChildren();
  let local = 0;
  for (const token of fit.text.match(/\S+|\s+/g) ?? []) {
    if (/^\s+$/.test(token)) { quote.append(document.createTextNode(token)); continue; }
    const ellipsis = token === "…", span = document.createElement("span"); span.className = "word"; span.textContent = token;
    if (!ellipsis) span.dataset.word = String(visibleStart + local++);
    quote.append(span);
  }
}
function activeWordIndex() {
  if (!currentTask || currentTask.kind !== "clip" || !activeReceipt) return 0;
  const times = activeReceipt.quoteWords ?? [], absolute = (activeReceipt.clipStart ?? activeReceipt.timestamp) + player.currentTime;
  if (times.length) {
    const found = times.findIndex(word => absolute >= word.start && absolute <= word.end);
    if (found >= 0) return found;
    const next = times.findIndex(word => word.start > absolute);
    return next < 0 ? times.length - 1 : next;
  }
  const count = wordsInQuote().length, duration = Math.max(.05, (activeReceipt.quoteEnd ?? activeReceipt.clipEnd ?? activeReceipt.timestamp + 1) - activeReceipt.timestamp);
  return Math.min(count - 1, Math.floor(Math.min(1, Math.max(0, absolute - activeReceipt.timestamp) / duration) * count));
}
function updateWord() {
  if (!currentTask || currentTask.kind !== "clip" || !activeReceipt?.quote) return;
  const index = activeWordIndex();
  if (index < visibleStart || index >= visibleEnd) renderQuote(index);
  quote.querySelectorAll(".word[data-word]").forEach(word => word.classList.toggle("active", Number(word.dataset.word) === index));
}
function drawWave() {
  if (!currentTask || currentTask.kind !== "clip" || player.paused) { wave.classList.remove("visible"); waveCtx.clearRect(0, 0, wave.width, wave.height); return; }
  wave.classList.add("visible"); waveCtx.clearRect(0, 0, wave.width, wave.height); waveCtx.lineWidth = 4; waveCtx.strokeStyle = "#ffca28"; waveCtx.shadowColor = "#ffca28"; waveCtx.shadowBlur = 9; waveCtx.beginPath();
  if (analyser) analyser.getByteFrequencyData(frequency);
  for (let i = 0; i < 64; i++) {
    const x = i / 63 * wave.width, amp = analyser ? frequency[Math.floor(i * frequency.length / 64)] / 255 : .15 + .75 * Math.abs(Math.sin(Date.now() / 120 + i * .7));
    const y = wave.height / 2 + (amp - .5) * wave.height * .86;
    if (i === 0) waveCtx.moveTo(x, y); else waveCtx.lineTo(x, y);
  }
  waveCtx.stroke(); waveCtx.shadowBlur = 0; updateWord(); requestAnimationFrame(drawWave);
}
async function prepareAnalyzer() {
  if (audioContext) { await audioContext.resume().catch(() => undefined); return; }
  try {
    audioContext = new AudioContext(); analyser = audioContext.createAnalyser(); analyser.fftSize = 128; frequency = new Uint8Array(analyser.frequencyBinCount);
    const source = audioContext.createMediaElementSource(player); source.connect(analyser); analyser.connect(audioContext.destination); await audioContext.resume();
  } catch { analyser = undefined; }
}
function postPlaybackComplete(requestId) {
  void fetch("/api/playback/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId }) }).catch(() => undefined);
}
function finishTask(generation, task, playedToEnd) {
  if (generation !== audioGeneration || currentTask !== task) return;
  clearTimeout(taskTimer); player.onended = null; player.onerror = null; currentTask = undefined;
  if (task.completeRequestId) postPlaybackComplete(task.completeRequestId);
  if (playedToEnd && task.after) audioQueue.unshift(task.after);
  wave.classList.remove("visible"); pumpAudio();
}
async function pumpAudio() {
  if (currentTask || !audioQueue.length) return;
  const task = audioQueue.shift();
  if (task.kind === "announcer" && !window.announcerEnabled) { pumpAudio(); return; }
  currentTask = task; const generation = audioGeneration;
  player.onended = () => finishTask(generation, task, true);
  player.onerror = () => finishTask(generation, task, false);
  taskTimer = setTimeout(() => finishTask(generation, task, false), 45_000);
  if (task.kind === "clip") await prepareAnalyzer();
  player.src = task.url; player.load();
  if (task.kind === "clip") player.addEventListener("play", drawWave, { once: true });
  player.play().catch(() => finishTask(generation, task, false));
}
function enqueueAnnouncer(file) {
  if (!announcerWhitelist.has(file)) return;
  audioQueue.push({ kind: "announcer", url: `/announcer/${file}` }); pumpAudio();
}
function enqueuePlayback(playback) {
  if (!playback?.playing || lastPlaybackRequest === playback.requestId) return;
  lastPlaybackRequest = playback.requestId;
  const tasks = [];
  if (playback.kind === "replay") tasks.push({ kind: "announcer", url: "/announcer/replay.mp3" });
  tasks.push({ kind: "clip", url: playback.clipUrl, completeRequestId: playback.requestId,
    after: { kind: "announcer", url: "/announcer/played.mp3" } });
  audioQueue.push(...tasks); pumpAudio();
}
function stopAudioForVeto(requestId) {
  if (lastStopRequest === requestId) return;
  lastStopRequest = requestId; audioGeneration++; clearTimeout(taskTimer); audioQueue = []; currentTask = undefined;
  player.pause(); player.removeAttribute("src"); player.load(); wave.classList.remove("visible");
  postPlaybackComplete(requestId);
}
function renderPanel(state) {
  const receipt = state.receipt;
  const replay = state.overlayPlayback?.kind === "replay" && state.overlayPlayback.receipt.status === "played" &&
    (state.overlayPlayback.playing || !receipt || state.overlayPlayback.receipt.id === receipt.id) ? state.overlayPlayback : undefined;
  const selected = replay?.receipt ?? receipt;
  const key = replay ? `hall:${replay.requestId}` : selected ? `${selected.id}:${selected.outcome}:${selected.status}` : "none";
  if (key === lastPanelKey) return;
  lastPanelKey = key; clearTimeout(clearTimer);
  if (!selected) { panel.style.display = "none"; $("#idle").style.display = "block"; updateRecord(state); return; }
  $("#idle").style.display = "none"; panel.style.display = "block";
  stamp.style.display = replay ? "none" : "block"; hallLabel.style.display = replay ? "block" : "none";
  stamp.textContent = selected.outcome; stamp.className = `stamp ${selected.outcome === "RECEIPT FOUND" ? "found" : selected.outcome === "NO MATCH" ? "miss" : "uncertain"}`;
  if (!replay && lastReceiptId !== selected.id) { lastReceiptId = selected.id; stamp.classList.remove("slam"); void stamp.offsetWidth; stamp.classList.add("slam"); }
  claimLine.style.display = "block"; claimLine.textContent = `${selected.requester}: “${selected.query}”`;
  activeReceipt = selected;
  if (selected.outcome === "RECEIPT FOUND" && selected.quote) {
    reason.classList.remove("visible"); reasonIcon.classList.remove("visible"); quote.style.display = "block"; lastFitKey = ""; renderQuote(0);
    meta.textContent = `STREAM TIME ${new Date(selected.timestamp * 1000).toISOString().slice(11, 19)} · ENTAILMENT ${Number(selected.score ?? 0).toFixed(3)} · ${selected.candidateId ?? "NO CANDIDATE"}`;
  } else {
    quote.style.display = "none"; reason.classList.add("visible"); reasonIcon.textContent = selected.outcome === "NO MATCH" ? "💔" : "";
    reasonIcon.classList.toggle("visible", selected.outcome === "NO MATCH"); reasonText.textContent = selected.outcome === "NO MATCH" ? "No match. Chat loses a life." : "Can't tell. No life lost.";
    meta.textContent = `ENTAILMENT ${Number(selected.score ?? 0).toFixed(3)} · ${selected.candidateId ?? "NO CANDIDATE"}`;
  }
  clearTimer = setTimeout(() => { panel.style.display = "none"; $("#idle").style.display = "block"; updateRecord(window.lastState); }, 18_000);
  updateRecord(state);
}
function updateRecord(state) {
  const record = state?.onRecordReceipt;
  if (!record?.quote || panel.style.display !== "none") { recordStrip.style.display = "none"; return; }
  recordQuote.textContent = record.quote; recordStrip.style.display = "flex";
}
function tickVeto(receipt, hold) {
  if (receipt?.outcome !== "RECEIPT FOUND" || receipt.status !== "pending" || !receipt.vetoUntil) { vetoWrap.classList.remove("visible"); vetoFill.style.width = "0%"; return; }
  vetoWrap.classList.add("visible"); vetoFill.style.width = `${100 * Math.min(1, Math.max(0, receipt.vetoUntil - Date.now()) / Math.max(1, hold))}%`;
}
function handleState(state) {
  window.lastState = state; window.announcerEnabled = state.announcerEnabled !== false;
  $("#sim").style.display = state.simulated ? "inline-block" : "none";
  $("#scripted").style.display = (params.get("scripted") === "1" || state.scriptedAudio) ? "inline-block" : "none";
  $("#lifetime").textContent = receiptCountLabel(state.lifetimeReceiptCount ?? 0); renderHearts(state.lives ?? 0, state.maxLives ?? 3);
  const asr = state.asr ?? {}, showHealth = asr.state && asr.state !== "stopped" && (asr.state !== "ready" || (asr.lastRtf ?? 0) > 1);
  $("#health").style.display = showHealth ? "block" : "none";
  $("#health").textContent = showHealth ? `LOCAL SPEECH: ${asr.message ?? asr.state} | waiting ${Number(asr.queuedAudioSeconds ?? 0).toFixed(1)}s` : "";
  tickVeto(state.receipt, state.holdMs); renderPanel(state); updateRecord(state);
  if (state.stopPlaybackRequest) stopAudioForVeto(state.stopPlaybackRequest);
  const event = state.announcerEvent;
  if (event?.id && event.id !== lastSoundEvent) { lastSoundEvent = event.id; if (window.announcerEnabled) enqueueAnnouncer(event.file); }
  enqueuePlayback(state.overlayPlayback);
}
let lastReceiptId = "";
ws.onmessage = ({ data }) => handleState(JSON.parse(data));
window.addEventListener("resize", () => { lastFitKey = ""; if (activeReceipt?.quote) renderQuote(activeWordIndex()); });
setInterval(() => { if (currentTask?.kind === "clip" && !player.paused) updateWord(); if (window.lastState) tickVeto(window.lastState.receipt, window.lastState.holdMs); }, 50);
