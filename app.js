const state = {
  audioContext: null,
  analyser: null,
  mediaStream: null,
  rafId: 0,
  recording: false,
  startedAt: 0,
  lastCaptureAt: 0,
  firstPitchAt: 0,
  stableMidi: null,
  pendingMidi: null,
  pendingSince: 0,
  rawFrames: [],
  melody: [],
  piano: null,
  activeKey: null,
  playing: false,
  playbackAbort: false,
  playbackContext: null,
};

const els = {
  recordButton: document.querySelector("#recordButton"),
  stopButton: document.querySelector("#stopButton"),
  demoButton: document.querySelector("#demoButton"),
  clearButton: document.querySelector("#clearButton"),
  naturalOnlyToggle: document.querySelector("#naturalOnlyToggle"),
  viewScoreButton: document.querySelector("#viewScoreButton"),
  exportButton: document.querySelector("#exportButton"),
  playButton: document.querySelector("#playButton"),
  statusPill: document.querySelector("#statusPill"),
  currentNote: document.querySelector("#currentNote"),
  frequencyReadout: document.querySelector("#frequencyReadout"),
  levelBar: document.querySelector("#levelBar"),
  noteCount: document.querySelector("#noteCount"),
  durationReadout: document.querySelector("#durationReadout"),
  noteTrail: document.querySelector("#noteTrail"),
  sheetSvg: document.querySelector("#sheetSvg"),
  fullSheetSvg: document.querySelector("#fullSheetSvg"),
  scoreDialog: document.querySelector("#scoreDialog"),
  closeScoreButton: document.querySelector("#closeScoreButton"),
  pianoScene: document.querySelector("#pianoScene"),
};

const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const whitePitchClasses = new Set([0, 2, 4, 5, 7, 9, 11]);
const blackPitchClasses = new Set([1, 3, 6, 8, 10]);
const recordingWarmupMs = 500;
const scoreWidth = 980;
const scoreMargin = 44;
const scoreRight = scoreWidth - scoreMargin;
const scoreStartX = 148;
const scoreSystemTop = 84;
const scoreSystemGap = 240;
const beatsPerMeasure = 4;

initPiano();
renderEmptySheet();

els.recordButton.addEventListener("click", startRecording);
els.stopButton.addEventListener("click", stopRecording);
els.demoButton.addEventListener("click", loadDemo);
els.clearButton.addEventListener("click", clearMelody);
els.playButton.addEventListener("click", playMelody);
els.exportButton.addEventListener("click", exportScore);
els.viewScoreButton.addEventListener("click", openScoreDialog);
els.closeScoreButton.addEventListener("click", () => els.scoreDialog.close());
els.naturalOnlyToggle.addEventListener("change", handlePitchModeChange);
window.addEventListener("resize", resizePiano);

async function startRecording() {
  try {
    stopPlayback();
    state.audioContext = new AudioContext();
    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    const source = state.audioContext.createMediaStreamSource(state.mediaStream);
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 4096;
    source.connect(state.analyser);

    state.rawFrames = [];
    state.melody = [];
    state.recording = true;
    state.startedAt = performance.now();
    state.lastCaptureAt = 0;
    state.firstPitchAt = 0;
    state.stableMidi = null;
    state.pendingMidi = null;
    state.pendingSince = 0;

    els.statusPill.textContent = "Listening";
    els.recordButton.disabled = true;
    els.stopButton.disabled = false;
    els.playButton.disabled = true;
    els.exportButton.disabled = true;
    els.viewScoreButton.disabled = true;
    renderEmptySheet();
    capturePitch();
  } catch (error) {
    els.statusPill.textContent = "Mic blocked";
    els.frequencyReadout.textContent = "Microphone access was not available. Try HTTPS, localhost, or the demo melody.";
  }
}

function stopRecording() {
  state.recording = false;
  cancelAnimationFrame(state.rafId);
  state.mediaStream?.getTracks().forEach((track) => track.stop());
  state.audioContext?.close();
  state.mediaStream = null;
  state.audioContext = null;
  state.analyser = null;

  state.melody = buildMelody(state.rawFrames);
  els.statusPill.textContent = state.melody.length ? "Captured" : "No melody";
  els.recordButton.disabled = false;
  els.stopButton.disabled = true;
  els.playButton.disabled = !state.melody.length;
  els.exportButton.disabled = !state.melody.length;
  els.viewScoreButton.disabled = !state.melody.length;
  renderMelody();
}

function capturePitch(now = performance.now()) {
  if (!state.recording || !state.analyser || !state.audioContext) return;

  const buffer = new Float32Array(state.analyser.fftSize);
  state.analyser.getFloatTimeDomainData(buffer);
  const pitch = autoCorrelate(buffer, state.audioContext.sampleRate);
  const rms = getRms(buffer);
  const elapsed = (now - state.startedAt) / 1000;

  els.levelBar.style.width = `${Math.min(100, rms * 700)}%`;
  els.durationReadout.textContent = `${elapsed.toFixed(1)}s`;

  if (pitch > 60 && pitch < 1400 && rms > 0.012) {
    const midi = stabilizeMidi(pitch, now);
    const note = midiToNoteName(midi);
    els.currentNote.textContent = note;
    els.frequencyReadout.textContent = `${pitch.toFixed(1)} Hz`;

    if (!state.firstPitchAt) {
      state.firstPitchAt = now;
      els.statusPill.textContent = "Settling";
    }

    const warmupComplete = now - state.firstPitchAt >= recordingWarmupMs;
    if (warmupComplete && els.statusPill.textContent !== "Recording") {
      els.statusPill.textContent = "Recording";
    }

    if (warmupComplete && now - state.lastCaptureAt > 105) {
      state.rawFrames.push({ time: elapsed, frequency: pitch, midi });
      state.lastCaptureAt = now;
      renderTrailFromFrames();
    }
  } else {
    if (!state.rawFrames.length) state.firstPitchAt = 0;
    els.currentNote.textContent = "--";
    els.frequencyReadout.textContent = "Listening for a clear pitch.";
    els.statusPill.textContent = state.rawFrames.length ? "Recording" : "Listening";
  }

  state.rafId = requestAnimationFrame(capturePitch);
}

function buildMelody(frames) {
  if (!frames.length) return [];
  const notes = [];
  let current = null;

  frames.forEach((frame, index) => {
    const nextTime = frames[index + 1]?.time ?? frame.time + 0.28;
    if (!current || Math.abs(frame.midi - current.midi) > 0) {
      if (current) notes.push(current);
      current = {
        midi: frame.midi,
        note: midiToNoteName(frame.midi),
        frequency: frame.frequency,
        start: frame.time,
        duration: Math.max(0.18, nextTime - frame.time),
      };
    } else {
      current.duration = Math.max(0.18, nextTime - current.start);
      current.frequency = (current.frequency + frame.frequency) / 2;
    }
  });

  if (current) notes.push(current);
  return notes
    .filter((note) => note.duration >= 0.12)
    .map((note, index) => normalizeNoteDuration({
      ...note,
      start: index === 0 ? 0 : note.start - notes[0].start,
    }));
}

function normalizeNoteDuration(note) {
  const notation = getNotationForDuration(note.duration);
  return {
    ...note,
    duration: notation.seconds,
    beats: notation.beats,
    durationName: notation.name,
    durationLabel: notation.label,
  };
}

function getNotationForDuration(duration) {
  const beatSeconds = 0.5;
  const beats = Math.max(0.5, duration / beatSeconds);
  const choices = [
    { beats: 0.5, name: "eighth", label: "eighth note" },
    { beats: 1, name: "quarter", label: "quarter note" },
    { beats: 2, name: "half", label: "half note" },
    { beats: 3, name: "dotted-half", label: "dotted half note" },
    { beats: 4, name: "whole", label: "whole note" },
  ];
  const closest = choices.reduce((best, candidate) =>
    Math.abs(candidate.beats - beats) < Math.abs(best.beats - beats) ? candidate : best,
  );
  return {
    ...closest,
    seconds: closest.beats * beatSeconds,
  };
}

function renderMelody() {
  renderTrailFromMelody();
  renderSheet(state.melody);
  els.noteCount.textContent = String(state.melody.length);
  const total = state.melody.reduce((sum, note) => sum + note.duration, 0);
  els.durationReadout.textContent = `${total.toFixed(1)}s`;
}

function renderTrailFromFrames() {
  const preview = buildMelody(state.rawFrames).slice(-10);
  renderNoteTrail(preview);
  els.noteCount.textContent = String(preview.length);
}

function renderTrailFromMelody() {
  renderNoteTrail(state.melody.slice(-16));
}

function renderNoteTrail(notes) {
  els.noteTrail.innerHTML = "";
  notes.forEach((note) => {
    const item = document.createElement("li");
    item.textContent = `${note.note} - ${note.durationLabel || "note"}`;
    els.noteTrail.append(item);
  });
}

function renderEmptySheet() {
  renderEmptyScore(els.sheetSvg);
  renderEmptyScore(els.fullSheetSvg);
}

function renderSheet(notes) {
  if (!notes.length) {
    renderEmptySheet();
    return;
  }

  renderScore(els.sheetSvg, notes, { preview: true });
  renderScore(els.fullSheetSvg, notes, { preview: false });
}

function renderEmptyScore(svg) {
  const height = 330;
  svg.setAttribute("viewBox", `0 0 ${scoreWidth} ${height}`);
  svg.dataset.scoreHeight = String(height);
  svg.innerHTML = `
    <rect x="0" y="0" width="${scoreWidth}" height="${height}" fill="#fffdf8"></rect>
    ${staffLines(scoreSystemTop)}
    <text x="54" y="176" font-size="84" font-family="Georgia, serif" fill="#1f2320">G</text>
    <text x="178" y="176" font-size="22" fill="#697269">Record or load a demo to generate notation.</text>
  `;
}

function renderScore(svg, notes, { preview }) {
  const systems = layoutScore(notes);
  const visibleSystems = preview ? systems.slice(0, 1) : systems;
  const overflowCount = preview
    ? systems.slice(1).reduce((total, system) => total + system.items.length, 0)
    : 0;
  const height = preview ? 330 : Math.max(330, 78 + systems.length * scoreSystemGap);
  const content = visibleSystems.map((system) => renderSystem(system, preview)).join("");
  const overflowMessage = overflowCount
    ? `<text x="${scoreStartX}" y="306" font-size="15" font-weight="800" fill="#176a62">+ ${overflowCount} more notes in full score</text>`
    : "";

  svg.setAttribute("viewBox", `0 0 ${scoreWidth} ${height}`);
  svg.dataset.scoreHeight = String(height);
  svg.innerHTML = `
    <rect x="0" y="0" width="${scoreWidth}" height="${height}" fill="#fffdf8"></rect>
    ${content}
    ${overflowMessage}
  `;
}

function layoutScore(notes) {
  const measures = groupNotesIntoMeasures(notes);
  const systems = [];
  let system = createScoreSystem(scoreSystemTop);

  measures.forEach((measure) => {
    const width = measureWidthFor(measure);
    if (system.measures.length && system.cursor + width > scoreRight) {
      systems.push(system);
      system = createScoreSystem(scoreSystemTop + systems.length * scoreSystemGap);
    }
    appendMeasureToSystem(system, measure, width);
  });

  if (system.measures.length) systems.push(system);
  return systems;
}

function createScoreSystem(top) {
  return {
    top,
    cursor: scoreStartX,
    measures: [],
    items: [],
    barlines: [122],
  };
}

function groupNotesIntoMeasures(notes) {
  const measures = [];
  let measure = [];
  let beatTotal = 0;

  notes.forEach((note) => {
    const beats = note.beats || 1;
    if (measure.length && beatTotal + beats > beatsPerMeasure) {
      measures.push(measure);
      measure = [];
      beatTotal = 0;
    }

    measure.push(note);
    beatTotal += beats;

    if (beatTotal >= beatsPerMeasure) {
      measures.push(measure);
      measure = [];
      beatTotal = 0;
    }
  });

  if (measure.length) measures.push(measure);
  return measures;
}

function appendMeasureToSystem(system, measure, width) {
  const available = Math.max(1, width - 36);
  const gap = available / measure.length;

  measure.forEach((note, index) => {
    system.items.push({
      note,
      x: system.cursor + 18 + index * gap + gap / 2,
    });
  });

  system.cursor += width;
  system.measures.push(measure);
  system.barlines.push(system.cursor);
}

function measureWidthFor(measure) {
  const beatWidth = 42;
  const noteWidth = 38;
  const beats = measure.reduce((sum, note) => sum + (note.beats || 1), 0);
  return Math.max(118, Math.min(360, beats * beatWidth + measure.length * noteWidth + 28));
}

function renderSystem(system, preview) {
  const labelY = system.top + 198;
  const barlines = system.barlines
    .map((x) => `<line x1="${x}" y1="${system.top - 10}" x2="${x}" y2="${system.top + 134}" stroke="#1f2320" stroke-width="3"></line>`)
    .join("");
  const noteShapes = system.items
    .map(({ note, x }) => `
      ${renderNoteGlyph(note, x, system.top)}
      <text x="${x - 24}" y="${labelY}" font-size="13" fill="#697269">${note.note}</text>
      <text x="${x - 24}" y="${labelY + 16}" font-size="11" fill="#9a9f97">${durationShortLabel(note.durationName)}</text>
    `)
    .join("");
  const systemLabel = preview
    ? ""
    : `<text x="${scoreMargin}" y="${system.top - 24}" font-size="12" fill="#9a9f97">${system.measures.length} measure${system.measures.length === 1 ? "" : "s"}</text>`;

  return `
    ${systemLabel}
    ${staffLines(system.top)}
    <text x="52" y="${system.top + 92}" font-size="84" font-family="Georgia, serif" fill="#1f2320">G</text>
    ${barlines}
    ${noteShapes}
  `;
}

function renderNoteGlyph(note, x, systemTop) {
  const y = midiToSheetY(note.midi, systemTop);
  const stemUp = y > systemTop + 48;
  const openHead = ["half", "dotted-half", "whole"].includes(note.durationName);
  const hasStem = note.durationName !== "whole";
  const stemY = stemUp ? y - 58 : y + 58;
  const stemX = stemUp ? x + 11 : x - 11;
  const head = openHead
    ? `<ellipse cx="${x}" cy="${y}" rx="14" ry="10" transform="rotate(-18 ${x} ${y})" fill="#fffdf8" stroke="#1f2320" stroke-width="3"></ellipse>`
    : `<ellipse cx="${x}" cy="${y}" rx="14" ry="10" transform="rotate(-18 ${x} ${y})" fill="#1f2320"></ellipse>`;
  const stem = hasStem
    ? `<line x1="${stemX}" y1="${y}" x2="${stemX}" y2="${stemY}" stroke="#1f2320" stroke-width="3"></line>`
    : "";
  const dot = note.durationName === "dotted-half"
    ? `<circle cx="${x + 27}" cy="${y - 2}" r="4" fill="#1f2320"></circle>`
    : "";
  const flag = note.durationName === "eighth" && hasStem
    ? renderEighthFlag(stemX, stemY, stemUp)
    : "";

  return `
    ${ledgerLines(note.midi, x, systemTop)}
    ${head}
    ${stem}
    ${dot}
    ${flag}
  `;
}

function renderEighthFlag(stemX, stemY, stemUp) {
  if (stemUp) {
    return `<path d="M ${stemX} ${stemY} C ${stemX + 26} ${stemY + 8}, ${stemX + 28} ${stemY + 28}, ${stemX + 8} ${stemY + 34}" fill="none" stroke="#1f2320" stroke-width="3" stroke-linecap="round"></path>`;
  }
  return `<path d="M ${stemX} ${stemY} C ${stemX + 26} ${stemY - 8}, ${stemX + 28} ${stemY - 28}, ${stemX + 8} ${stemY - 34}" fill="none" stroke="#1f2320" stroke-width="3" stroke-linecap="round"></path>`;
}

function durationShortLabel(durationName) {
  const labels = {
    eighth: "1/8",
    quarter: "1/4",
    half: "1/2",
    "dotted-half": "dotted 1/2",
    whole: "whole",
  };
  return labels[durationName] || "";
}

function staffLines(systemTop) {
  return [0, 26, 52, 78, 104]
    .map((offset) => `<line x1="${scoreMargin}" y1="${systemTop + offset}" x2="${scoreRight}" y2="${systemTop + offset}" stroke="#1f2320" stroke-width="2"></line>`)
    .join("");
}

function midiToSheetY(midi, systemTop = scoreSystemTop) {
  return systemTop + 104 - (midi - 64) * 6.5;
}

function ledgerLines(midi, x, systemTop) {
  const y = midiToSheetY(midi, systemTop);
  if (y >= systemTop - 2 && y <= systemTop + 106) return "";
  const lines = [];
  if (y < systemTop - 2) {
    for (let lineY = systemTop - 26; lineY >= y - 8; lineY -= 26) {
      lines.push(`<line x1="${x - 20}" y1="${lineY}" x2="${x + 20}" y2="${lineY}" stroke="#1f2320" stroke-width="2"></line>`);
    }
  }
  if (y > systemTop + 106) {
    for (let lineY = systemTop + 130; lineY <= y + 8; lineY += 26) {
      lines.push(`<line x1="${x - 20}" y1="${lineY}" x2="${x + 20}" y2="${lineY}" stroke="#1f2320" stroke-width="2"></line>`);
    }
  }
  return lines.join("");
}

async function playMelody() {
  if (!state.melody.length) return;
  if (state.playing) {
    stopPlayback();
    return;
  }

  state.playing = true;
  state.playbackAbort = false;
  const context = new AudioContext();
  state.playbackContext = context;
  els.playButton.textContent = "Stop playback";

  try {
    for (const note of state.melody) {
      if (state.playbackAbort) break;
      pressPianoKey(note.midi, note.duration);
      playTone(context, midiToFrequency(note.midi), note.duration);
      await sleepDuringPlayback(note.duration * 1000);
    }
  } finally {
    if (context.state !== "closed") {
      try {
        await context.close();
      } catch (error) {
        // The stop button may have already closed the context.
      }
    }
    state.playing = false;
    state.playbackAbort = false;
    state.playbackContext = null;
    els.playButton.textContent = "Play on piano";
  }
}

function stopPlayback() {
  if (!state.playing) return;
  state.playbackAbort = true;
  state.playbackContext?.close().catch(() => {});
}

async function sleepDuringPlayback(ms) {
  const interval = 40;
  const end = performance.now() + ms;
  while (!state.playbackAbort && performance.now() < end) {
    await sleep(Math.min(interval, end - performance.now()));
  }
}

function exportScore() {
  if (!state.melody.length) return;
  const clone = els.fullSheetSvg.cloneNode(true);
  const height = clone.dataset.scoreHeight || "330";
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(scoreWidth));
  clone.setAttribute("height", height);
  const source = `<?xml version="1.0" encoding="UTF-8"?>\n${clone.outerHTML}`;
  const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `humtokeys-score-${new Date().toISOString().slice(0, 10)}.svg`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function openScoreDialog() {
  if (!state.melody.length) return;
  if (typeof els.scoreDialog.showModal === "function") {
    els.scoreDialog.showModal();
  } else {
    els.scoreDialog.setAttribute("open", "");
  }
}

function playTone(context, frequency, duration) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "triangle";
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + duration);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + duration + 0.04);
}

function initPiano() {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  els.pianoScene.append(canvas);

  const keys = new Map();
  const whiteMidis = [];
  for (let midi = 48; midi <= 84; midi += 1) {
    if (whitePitchClasses.has(midi % 12)) whiteMidis.push(midi);
  }

  const whitePositions = new Map();

  whiteMidis.forEach((midi, index) => {
    const key = { midi, index, black: false, pressed: false, pressUntil: 0 };
    keys.set(midi, key);
    whitePositions.set(midi, index);
  });

  for (let midi = 49; midi <= 83; midi += 1) {
    if (!blackPitchClasses.has(midi % 12)) continue;
    const previousWhite = findPreviousWhite(midi);
    const nextWhite = findNextWhite(midi);
    if (!whitePositions.has(previousWhite) || !whitePositions.has(nextWhite)) continue;
    keys.set(midi, {
      midi,
      index: (whitePositions.get(previousWhite) + whitePositions.get(nextWhite)) / 2,
      black: true,
      pressed: false,
      pressUntil: 0,
    });
  }

  state.piano = { canvas, ctx, keys, whiteCount: whiteMidis.length };
  resizePiano();
  animatePiano();
}

function resizePiano() {
  if (!state.piano) return;
  const rect = els.pianoScene.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  state.piano.canvas.width = Math.max(1, rect.width) * ratio;
  state.piano.canvas.height = Math.max(1, rect.height) * ratio;
  state.piano.canvas.style.width = `${rect.width}px`;
  state.piano.canvas.style.height = `${rect.height}px`;
  state.piano.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function animatePiano() {
  if (!state.piano) return;
  drawPiano();
  requestAnimationFrame(animatePiano);
}

function drawPiano() {
  const { canvas, ctx, keys, whiteCount } = state.piano;
  const width = canvas.clientWidth || 900;
  const height = canvas.clientHeight || 360;
  const now = performance.now();
  ctx.clearRect(0, 0, width, height);

  const keyWidth = Math.min(34, (width - 90) / whiteCount);
  const startX = (width - keyWidth * whiteCount) / 2;
  const topY = height * 0.23;
  const keyDepth = height * 0.48;
  const perspective = Math.min(72, height * 0.18);
  const bodyY = topY - 34;

  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#30352f");
  gradient.addColorStop(1, "#111311");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  drawRoundedRect(ctx, startX - 34, bodyY, keyWidth * whiteCount + 68, 72, 10, "#5b3124");
  drawPerspectivePanel(ctx, startX - 28, topY - 16, keyWidth * whiteCount + 56, keyDepth + 48, perspective, "#3b1f18");

  [...keys.values()]
    .filter((key) => !key.black)
    .forEach((key) => {
      key.pressed = key.pressUntil > now;
      const x = startX + key.index * keyWidth;
      const press = key.pressed ? 12 : 0;
      drawWhiteKey(ctx, x, topY + press, keyWidth - 2, keyDepth, perspective, key.pressed);
    });

  [...keys.values()]
    .filter((key) => key.black)
    .forEach((key) => {
      key.pressed = key.pressUntil > now;
      const x = startX + key.index * keyWidth - keyWidth * 0.3;
      const press = key.pressed ? 10 : 0;
      drawBlackKey(ctx, x, topY + press, keyWidth * 0.6, keyDepth * 0.58, perspective * 0.62, key.pressed);
    });

  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.font = "700 13px Inter, sans-serif";
  ctx.fillText("3D piano playback", startX, height - 28);
}

function drawWhiteKey(ctx, x, y, width, depth, perspective, pressed) {
  const topColor = pressed ? "#f4c95d" : "#fffaf0";
  const sideColor = pressed ? "#dba83b" : "#d8d2c4";
  drawPerspectivePanel(ctx, x, y, width, depth, perspective, sideColor);
  drawKeyTop(ctx, x, y, width, depth, perspective, topColor, "#1f2320");
}

function drawBlackKey(ctx, x, y, width, depth, perspective, pressed) {
  const topColor = pressed ? "#f4c95d" : "#101110";
  const sideColor = pressed ? "#b98522" : "#050605";
  drawPerspectivePanel(ctx, x, y, width, depth, perspective, sideColor);
  drawKeyTop(ctx, x, y, width, depth, perspective, topColor, "#000000");
}

function drawKeyTop(ctx, x, y, width, depth, perspective, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + width, y);
  ctx.lineTo(x + width + perspective * 0.22, y + depth);
  ctx.lineTo(x - perspective * 0.22, y + depth);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.globalAlpha = 0.42;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawPerspectivePanel(ctx, x, y, width, depth, perspective, fill) {
  ctx.beginPath();
  ctx.moveTo(x - perspective * 0.22, y + depth);
  ctx.lineTo(x + width + perspective * 0.22, y + depth);
  ctx.lineTo(x + width + perspective * 0.42, y + depth + perspective);
  ctx.lineTo(x - perspective * 0.42, y + depth + perspective);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function drawRoundedRect(ctx, x, y, width, height, radius, fill) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function pressPianoKey(midi, duration) {
  const key = state.piano?.keys.get(clampMidiToPiano(midi));
  if (!key) return;
  key.pressUntil = performance.now() + Math.max(120, duration * 900);
}

function clampMidiToPiano(midi) {
  return Math.max(48, Math.min(84, midi));
}

function findPreviousWhite(midi) {
  for (let next = midi - 1; next >= 48; next -= 1) {
    if (whitePitchClasses.has(next % 12)) return next;
  }
  return midi;
}

function findNextWhite(midi) {
  for (let next = midi + 1; next <= 84; next += 1) {
    if (whitePitchClasses.has(next % 12)) return next;
  }
  return midi;
}

function loadDemo() {
  const demo = [
    [60, 0.5],
    [62, 0.5],
    [64, 1],
    [67, 2],
    [64, 1],
    [62, 0.5],
    [60, 0.5],
    [67, 3],
    [69, 1],
    [67, 1],
    [64, 2],
    [62, 1],
    [60, 4],
  ];
  let cursor = 0;
  state.melody = demo.map(([midi, beats]) => {
    const notation = getNotationForDuration(beats * 0.5);
    const note = {
      midi,
      note: midiToNoteName(midi),
      frequency: midiToFrequency(midi),
      start: cursor,
      duration: notation.seconds,
      beats: notation.beats,
      durationName: notation.name,
      durationLabel: notation.label,
    };
    cursor += notation.seconds;
    return note;
  });
  els.statusPill.textContent = "Demo loaded";
  els.currentNote.textContent = state.melody[0].note;
  els.frequencyReadout.textContent = "Demo melody ready for playback.";
  els.playButton.disabled = false;
  els.exportButton.disabled = false;
  els.viewScoreButton.disabled = false;
  renderMelody();
}

function clearMelody() {
  stopPlayback();
  state.rawFrames = [];
  state.melody = [];
  state.firstPitchAt = 0;
  state.lastCaptureAt = 0;
  els.currentNote.textContent = "--";
  els.frequencyReadout.textContent = "Waiting for microphone input.";
  els.noteCount.textContent = "0";
  els.durationReadout.textContent = "0.0s";
  els.noteTrail.innerHTML = "";
  els.playButton.disabled = true;
  els.exportButton.disabled = true;
  els.viewScoreButton.disabled = true;
  if (els.scoreDialog.open) els.scoreDialog.close();
  renderEmptySheet();
}

function handlePitchModeChange() {
  state.stableMidi = null;
  state.pendingMidi = null;
  state.pendingSince = 0;

  if (els.naturalOnlyToggle.checked && state.melody.length) {
    state.melody = state.melody.map((note) => {
      const midi = nearestNaturalMidi(note.midi);
      return {
        ...note,
        midi,
        note: midiToNoteName(midi),
        frequency: midiToFrequency(midi),
      };
    });
    renderMelody();
  }
}

function autoCorrelate(buffer, sampleRate) {
  const size = buffer.length;
  const rms = getRms(buffer);
  if (rms < 0.01) return -1;

  let start = 0;
  let end = size - 1;
  const threshold = 0.2;

  for (let index = 0; index < size / 2; index += 1) {
    if (Math.abs(buffer[index]) < threshold) {
      start = index;
      break;
    }
  }

  for (let index = 1; index < size / 2; index += 1) {
    if (Math.abs(buffer[size - index]) < threshold) {
      end = size - index;
      break;
    }
  }

  const trimmed = buffer.slice(start, end);
  const correlations = new Array(trimmed.length).fill(0);
  for (let lag = 0; lag < trimmed.length; lag += 1) {
    for (let index = 0; index < trimmed.length - lag; index += 1) {
      correlations[lag] += trimmed[index] * trimmed[index + lag];
    }
  }

  let lag = 0;
  while (correlations[lag] > correlations[lag + 1]) lag += 1;

  let bestLag = lag;
  let bestCorrelation = -1;
  for (; lag < correlations.length; lag += 1) {
    if (correlations[lag] > bestCorrelation) {
      bestCorrelation = correlations[lag];
      bestLag = lag;
    }
  }

  return bestLag ? sampleRate / bestLag : -1;
}

function getRms(buffer) {
  const sum = buffer.reduce((total, sample) => total + sample * sample, 0);
  return Math.sqrt(sum / buffer.length);
}

function stabilizeMidi(frequency, now) {
  const rawMidi = frequencyToMidiFloat(frequency);
  const targetMidi = applyPitchMode(Math.round(rawMidi));
  const toleranceSemitones = 0.42;
  const changeHoldMs = 170;

  if (state.stableMidi === null) {
    state.stableMidi = targetMidi;
    return targetMidi;
  }

  const stableDistance = Math.abs(rawMidi - state.stableMidi);
  if (targetMidi === state.stableMidi || stableDistance < toleranceSemitones) {
    state.pendingMidi = null;
    state.pendingSince = 0;
    return state.stableMidi;
  }

  if (state.pendingMidi !== targetMidi) {
    state.pendingMidi = targetMidi;
    state.pendingSince = now;
    return state.stableMidi;
  }

  if (now - state.pendingSince >= changeHoldMs) {
    state.stableMidi = targetMidi;
    state.pendingMidi = null;
    state.pendingSince = 0;
  }

  return state.stableMidi;
}

function applyPitchMode(midi) {
  return els.naturalOnlyToggle.checked ? nearestNaturalMidi(midi) : midi;
}

function nearestNaturalMidi(midi) {
  if (whitePitchClasses.has(((midi % 12) + 12) % 12)) return midi;
  const pitchClass = ((midi % 12) + 12) % 12;
  if (pitchClass === 1 || pitchClass === 6) return midi - 1;
  return midi + 1;
}

function frequencyToMidiFloat(frequency) {
  return 69 + 12 * Math.log2(frequency / 440);
}

function frequencyToMidi(frequency) {
  return applyPitchMode(Math.round(frequencyToMidiFloat(frequency)));
}

function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function midiToNoteName(midi) {
  const octave = Math.floor(midi / 12) - 1;
  return `${noteNames[((midi % 12) + 12) % 12]}${octave}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
