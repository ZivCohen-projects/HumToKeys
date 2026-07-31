import { estimatePitchYin } from "./pitch-detector.mjs";
import { inferNoteFrames, StablePitchTracker } from "./note-tracker.mjs";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const state = {
  audioContext: null,
  analyser: null,
  mediaStream: null,
  rafId: 0,
  recording: false,
  startedAt: 0,
  lastAnalysisAt: 0,
  lastCaptureAt: 0,
  lastVoicedAt: 0,
  firstPitchAt: 0,
  pitchTracker: new StablePitchTracker(),
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
  dialogExportButton: document.querySelector("#dialogExportButton"),
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
const pianoLowestMidi = 21;
const pianoHighestMidi = 108;
const recordingWarmupMs = 500;
const scoreWidth = 980;
const scoreMargin = 44;
const scoreRight = scoreWidth - scoreMargin;
const scoreStartX = 148;
const scoreSystemTop = 84;
const scoreSystemGap = 240;
const beatsPerMeasure = 4;
const pitchAnalysisIntervalMs = 42;
const frameCaptureIntervalMs = 72;
const silenceBreakMs = 280;

initPiano();
renderEmptySheet();

els.recordButton.addEventListener("click", startRecording);
els.stopButton.addEventListener("click", stopRecording);
els.demoButton.addEventListener("click", loadDemo);
els.clearButton.addEventListener("click", clearMelody);
els.playButton.addEventListener("click", playMelody);
els.exportButton.addEventListener("click", exportScore);
els.dialogExportButton.addEventListener("click", exportScore);
els.viewScoreButton.addEventListener("click", openScoreDialog);
els.closeScoreButton.addEventListener("click", () => els.scoreDialog.close());
els.naturalOnlyToggle.addEventListener("change", handlePitchModeChange);

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
    const highPass = state.audioContext.createBiquadFilter();
    highPass.type = "highpass";
    highPass.frequency.value = 65;
    highPass.Q.value = 0.7;
    const lowPass = state.audioContext.createBiquadFilter();
    lowPass.type = "lowpass";
    lowPass.frequency.value = 1400;
    lowPass.Q.value = 0.7;
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 8192;
    state.analyser.smoothingTimeConstant = 0;
    source.connect(highPass).connect(lowPass).connect(state.analyser);

    state.rawFrames = [];
    state.melody = [];
    state.recording = true;
    state.startedAt = performance.now();
    state.lastAnalysisAt = 0;
    state.lastCaptureAt = 0;
    state.lastVoicedAt = 0;
    state.firstPitchAt = 0;
    state.pitchTracker.reset();

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
  if (now - state.lastAnalysisAt < pitchAnalysisIntervalMs) {
    state.rafId = requestAnimationFrame(capturePitch);
    return;
  }

  state.lastAnalysisAt = now;
  const buffer = new Float32Array(state.analyser.fftSize);
  state.analyser.getFloatTimeDomainData(buffer);
  const estimate = estimatePitchYin(buffer, state.audioContext.sampleRate);
  const elapsed = (now - state.startedAt) / 1000;
  const rms = estimate?.rms ?? 0;

  els.levelBar.style.width = `${Math.min(100, rms * 700)}%`;
  els.durationReadout.textContent = `${elapsed.toFixed(1)}s`;

  if (estimate) {
    const trackedPitch = state.pitchTracker.observe({
      midiFloat: frequencyToMidiFloat(estimate.frequency),
      clarity: estimate.clarity,
      time: now,
      snapMidi: applyPitchMode,
    });
    const displayMidi = trackedPitch.midi ?? trackedPitch.candidateMidi;
    const note = displayMidi === null ? "--" : midiToNoteName(displayMidi);
    const centsFromNote = displayMidi === null || trackedPitch.midiFloat === null
      ? 0
      : Math.round((trackedPitch.midiFloat - displayMidi) * 100);
    const centsLabel = centsFromNote === 0 ? "on pitch" : `${centsFromNote > 0 ? "+" : ""}${centsFromNote} cents`;
    els.currentNote.textContent = note;
    els.frequencyReadout.textContent = `${estimate.frequency.toFixed(1)} Hz | ${centsLabel} | ${Math.round(estimate.clarity * 100)}% clear`;

    if (!state.firstPitchAt) {
      state.firstPitchAt = now;
      els.statusPill.textContent = "Settling";
    }

    const warmupComplete = now - state.firstPitchAt >= recordingWarmupMs;
    if (warmupComplete && els.statusPill.textContent !== "Recording") {
      els.statusPill.textContent = "Recording";
    }

    if (warmupComplete && trackedPitch.midiFloat !== null && now - state.lastCaptureAt > frameCaptureIntervalMs) {
      state.rawFrames.push({
        time: elapsed,
        frequency: estimate.frequency,
        midiFloat: trackedPitch.midiFloat,
        midi: trackedPitch.midi ?? trackedPitch.candidateMidi,
        clarity: estimate.clarity,
        breakBefore: state.rawFrames.length > 0 && now - state.lastCaptureAt > silenceBreakMs,
      });
      state.lastCaptureAt = now;
      renderTrailFromFrames();
    }
    state.lastVoicedAt = now;
  } else {
    if (!state.rawFrames.length) state.firstPitchAt = 0;
    if (now - state.lastVoicedAt > 220) {
      state.pitchTracker.reset();
    }
    els.currentNote.textContent = "--";
    els.frequencyReadout.textContent = "Listening for a clear pitch.";
    els.statusPill.textContent = state.rawFrames.length ? "Recording" : "Listening";
  }

  state.rafId = requestAnimationFrame(capturePitch);
}

function buildMelody(frames) {
  if (!frames.length) return [];
  const cleanedFrames = inferNoteFrames(frames, { snapMidi: applyPitchMode });
  const notes = [];
  let current = null;

  cleanedFrames.forEach((frame, index) => {
    const nextTime = cleanedFrames[index + 1]?.time ?? frame.time + 0.28;
    if (!current || frame.breakBefore || Math.abs(frame.midi - current.midi) > 0) {
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
    <rect x="0" y="0" width="${scoreWidth}" height="${height}" fill="#ffffff"></rect>
    <text x="${scoreWidth / 2}" y="42" text-anchor="middle" font-size="28" font-family="Georgia, serif" font-weight="700" fill="#000000">HumToKeys Melody</text>
    ${staffLines(scoreSystemTop)}
    ${scoreClef(scoreSystemTop)}
    ${timeSignature(scoreSystemTop)}
    <text x="202" y="174" font-size="21" font-family="Georgia, serif" fill="#000000">Record or load a demo to generate notation.</text>
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
    ? `<text x="${scoreStartX}" y="306" font-size="15" font-family="Georgia, serif" font-weight="700" fill="#000000">+ ${overflowCount} more notes in full score</text>`
    : "";
  const title = preview
    ? ""
    : `<text x="${scoreWidth / 2}" y="42" text-anchor="middle" font-size="30" font-family="Georgia, serif" font-weight="700" fill="#000000">HumToKeys Melody</text>`;

  svg.setAttribute("viewBox", `0 0 ${scoreWidth} ${height}`);
  svg.dataset.scoreHeight = String(height);
  svg.innerHTML = `
    <rect x="0" y="0" width="${scoreWidth}" height="${height}" fill="#ffffff"></rect>
    ${title}
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
  const barlines = system.barlines
    .map((x) => `<line x1="${x}" y1="${system.top}" x2="${x}" y2="${system.top + 104}" stroke="#000000" stroke-width="2"></line>`)
    .join("");
  const noteShapes = system.items
    .map(({ note, x }) => `
      ${renderNoteGlyph(note, x, system.top)}
    `)
    .join("");

  return `
    ${staffLines(system.top)}
    ${scoreClef(system.top)}
    ${timeSignature(system.top)}
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
    ? `<ellipse cx="${x}" cy="${y}" rx="14" ry="10" transform="rotate(-18 ${x} ${y})" fill="#ffffff" stroke="#000000" stroke-width="3"></ellipse>`
    : `<ellipse cx="${x}" cy="${y}" rx="14" ry="10" transform="rotate(-18 ${x} ${y})" fill="#000000"></ellipse>`;
  const stem = hasStem
    ? `<line x1="${stemX}" y1="${y}" x2="${stemX}" y2="${stemY}" stroke="#000000" stroke-width="3"></line>`
    : "";
  const dot = note.durationName === "dotted-half"
    ? `<circle cx="${x + 27}" cy="${y - 2}" r="4" fill="#000000"></circle>`
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
    return `<path d="M ${stemX} ${stemY} C ${stemX + 26} ${stemY + 8}, ${stemX + 28} ${stemY + 28}, ${stemX + 8} ${stemY + 34}" fill="none" stroke="#000000" stroke-width="3" stroke-linecap="round"></path>`;
  }
  return `<path d="M ${stemX} ${stemY} C ${stemX + 26} ${stemY - 8}, ${stemX + 28} ${stemY - 28}, ${stemX + 8} ${stemY - 34}" fill="none" stroke="#000000" stroke-width="3" stroke-linecap="round"></path>`;
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
    .map((offset) => `<line x1="${scoreMargin}" y1="${systemTop + offset}" x2="${scoreRight}" y2="${systemTop + offset}" stroke="#000000" stroke-width="2"></line>`)
    .join("");
}

function scoreClef(systemTop) {
  return `<text x="55" y="${systemTop + 96}" font-size="98" font-family="Georgia, 'Times New Roman', serif" fill="#000000">&#119070;</text>`;
}

function timeSignature(systemTop) {
  return `
    <text x="112" y="${systemTop + 44}" text-anchor="middle" font-size="39" font-family="Georgia, serif" font-weight="700" fill="#000000">4</text>
    <text x="112" y="${systemTop + 90}" text-anchor="middle" font-size="39" font-family="Georgia, serif" font-weight="700" fill="#000000">4</text>
  `;
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
      lines.push(`<line x1="${x - 20}" y1="${lineY}" x2="${x + 20}" y2="${lineY}" stroke="#000000" stroke-width="2"></line>`);
    }
  }
  if (y > systemTop + 106) {
    for (let lineY = systemTop + 130; lineY <= y + 8; lineY += 26) {
      lines.push(`<line x1="${x - 20}" y1="${lineY}" x2="${x + 20}" y2="${lineY}" stroke="#000000" stroke-width="2"></line>`);
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

async function exportScore() {
  if (!state.melody.length) return;
  setExportButtons(true, "Saving...");

  try {
    const pages = await scoreSvgToPdfPages();
    const pdf = buildPdf(pages);
    const url = URL.createObjectURL(new Blob([pdf], { type: "application/pdf" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `humtokeys-score-${new Date().toISOString().slice(0, 10)}.pdf`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } finally {
    setExportButtons(false, "Save PDF");
  }
}

function setExportButtons(disabled, label) {
  els.exportButton.disabled = disabled;
  els.dialogExportButton.disabled = disabled;
  els.exportButton.textContent = label;
  els.dialogExportButton.textContent = label;
}

async function scoreSvgToPdfPages() {
  const clone = els.fullSheetSvg.cloneNode(true);
  const height = clone.dataset.scoreHeight || "330";
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(scoreWidth));
  clone.setAttribute("height", height);
  const source = `<?xml version="1.0" encoding="UTF-8"?>\n${clone.outerHTML}`;
  const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const image = await loadImage(url);
  URL.revokeObjectURL(url);

  const sourceCanvas = document.createElement("canvas");
  const scale = 2;
  sourceCanvas.width = scoreWidth * scale;
  sourceCanvas.height = Number(height) * scale;
  const sourceContext = sourceCanvas.getContext("2d");
  sourceContext.fillStyle = "#ffffff";
  sourceContext.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
  sourceContext.drawImage(image, 0, 0, sourceCanvas.width, sourceCanvas.height);

  return sliceScoreCanvas(sourceCanvas);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

function sliceScoreCanvas(sourceCanvas) {
  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 36;
  const printableWidth = pageWidth - margin * 2;
  const printableHeight = pageHeight - margin * 2;
  const sourceSliceHeight = Math.floor(sourceCanvas.width * (printableHeight / printableWidth));
  const pages = [];

  for (let y = 0; y < sourceCanvas.height; y += sourceSliceHeight) {
    const sliceHeight = Math.min(sourceSliceHeight, sourceCanvas.height - y);
    const canvas = document.createElement("canvas");
    canvas.width = sourceCanvas.width;
    canvas.height = sliceHeight;
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(sourceCanvas, 0, y, sourceCanvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);
    pages.push({
      pageWidth,
      pageHeight,
      x: margin,
      y: pageHeight - margin - (printableWidth * sliceHeight) / sourceCanvas.width,
      width: printableWidth,
      height: (printableWidth * sliceHeight) / sourceCanvas.width,
      imageWidth: canvas.width,
      imageHeight: canvas.height,
      imageBytes: dataUrlToBytes(canvas.toDataURL("image/jpeg", 0.94)),
    });
  }

  return pages;
}

function dataUrlToBytes(dataUrl) {
  const binary = atob(dataUrl.split(",")[1]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function buildPdf(pages) {
  const encoder = new TextEncoder();
  const chunks = [];
  const offsets = [0];
  let byteLength = 0;
  const objectCount = 2 + pages.length * 3;
  const catalogId = 1;
  const pagesId = 2;

  const addString = (value) => {
    const bytes = encoder.encode(value);
    chunks.push(bytes);
    byteLength += bytes.length;
  };
  const addBytes = (bytes) => {
    chunks.push(bytes);
    byteLength += bytes.length;
  };
  const addObject = (id, parts) => {
    offsets[id] = byteLength;
    addString(`${id} 0 obj\n`);
    parts.forEach((part) => {
      if (typeof part === "string") addString(part);
      else addBytes(part);
    });
    addString("\nendobj\n");
  };

  addString("%PDF-1.4\n");
  addObject(catalogId, [`<< /Type /Catalog /Pages ${pagesId} 0 R >>`]);

  const pageIds = pages.map((_, index) => 3 + index * 3);
  addObject(pagesId, [`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`]);

  pages.forEach((page, index) => {
    const pageId = 3 + index * 3;
    const imageId = pageId + 1;
    const contentId = pageId + 2;
    const imageName = `Im${index + 1}`;
    const content = `q\n${page.width.toFixed(2)} 0 0 ${page.height.toFixed(2)} ${page.x.toFixed(2)} ${page.y.toFixed(2)} cm\n/${imageName} Do\nQ`;

    addObject(pageId, [
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${page.pageWidth} ${page.pageHeight}] /Resources << /XObject << /${imageName} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    ]);
    addObject(imageId, [
      `<< /Type /XObject /Subtype /Image /Width ${page.imageWidth} /Height ${page.imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.imageBytes.length} >>\nstream\n`,
      page.imageBytes,
      "\nendstream",
    ]);
    addObject(contentId, [
      `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`,
    ]);
  });

  const xrefOffset = byteLength;
  addString(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`);
  for (let id = 1; id <= objectCount; id += 1) {
    addString(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  }
  addString(`trailer\n<< /Size ${objectCount + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  const pdf = new Uint8Array(byteLength);
  let cursor = 0;
  chunks.forEach((chunk) => {
    pdf.set(chunk, cursor);
    cursor += chunk.length;
  });
  return pdf;
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

async function initPiano() {
  const canvas = document.createElement("canvas");
  canvas.className = "webgl-piano";
  canvas.setAttribute("aria-label", "Interactive 3D 88-key concert grand piano");
  els.pianoScene.replaceChildren(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x080a0b);
  scene.fog = new THREE.Fog(0x080a0b, 17, 34);

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(11.5, 8.1, 15.2);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, -0.15, 0.85);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.enablePan = false;
  controls.minDistance = 10;
  controls.maxDistance = 24;
  controls.minPolarAngle = Math.PI / 5;
  controls.maxPolarAngle = Math.PI / 2.06;
  controls.update();

  addPianoStudio(scene);
  let model;
  try {
    model = await loadRiggedGrandPiano();
  } catch (error) {
    console.warn("The rigged piano asset could not load; using the built-in piano instead.", error);
    model = buildGrandPianoModel();
  }
  const { root, keys, pickables } = model;
  scene.add(root);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerStart = null;
  canvas.addEventListener("pointerdown", (event) => {
    pointerStart = { x: event.clientX, y: event.clientY };
  });
  canvas.addEventListener("pointerup", (event) => {
    if (!pointerStart || Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 6) return;
    const rect = canvas.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(pickables, false)[0];
    const key = hit?.object.userData.pianoKey;
    if (key) previewPianoKey(key.midi);
  });

  const resize = () => {
    const rect = els.pianoScene.getBoundingClientRect();
    renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
    camera.aspect = rect.width / Math.max(1, rect.height);
    camera.updateProjectionMatrix();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(els.pianoScene);
  resize();

  state.piano = { renderer, scene, camera, controls, keys, resizeObserver };
  animatePiano();
}

async function loadRiggedGrandPiano() {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync("./assets/concert-grand-piano.glb");
  const root = gltf.scene;
  const keys = new Map();
  const pickables = [];

  root.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = true;
    object.receiveShadow = true;
  });

  root.traverse((pivot) => {
    const match = /^pivot_(\d+)_/.exec(pivot.name);
    if (!match) return;

    const midi = Number(match[1]);
    const meshes = [];
    pivot.traverse((child) => {
      if (!child.isMesh) return;
      child.material = Array.isArray(child.material)
        ? child.material.map((material) => material.clone())
        : child.material.clone();
      meshes.push(child);
      pickables.push(child);
    });

    if (!meshes.length) return;
    keys.set(midi, {
      midi,
      pivot,
      meshes,
      materials: meshes.flatMap((mesh) => Array.isArray(mesh.material) ? mesh.material : [mesh.material]),
      pressUntil: 0,
      pressed: false,
      pressRotation: Number(pivot.userData.pressRadians) || -0.08,
    });
  });

  if (keys.size !== 88) {
    throw new Error(`Expected 88 rigged piano keys but found ${keys.size}.`);
  }

  root.scale.setScalar(5.2);
  root.position.set(0, -2.8, 0.35);
  root.rotation.y = -0.12;
  return { root, keys, pickables };
}

function addPianoStudio(scene) {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(52, 52),
    new THREE.MeshStandardMaterial({ color: 0x121615, metalness: 0.15, roughness: 0.72 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -3.05;
  floor.receiveShadow = true;
  scene.add(floor);

  const halo = new THREE.Mesh(
    new THREE.CircleGeometry(10, 80),
    new THREE.MeshBasicMaterial({ color: 0x5f3a17, transparent: true, opacity: 0.16 }),
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = -3.035;
  scene.add(halo);

  scene.add(new THREE.HemisphereLight(0xd8e8ff, 0x29150c, 1.65));

  const keyLight = new THREE.DirectionalLight(0xffe3af, 4.2);
  keyLight.position.set(7, 11, 8);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.camera.near = 1;
  keyLight.shadow.camera.far = 30;
  keyLight.shadow.camera.left = -11;
  keyLight.shadow.camera.right = 11;
  keyLight.shadow.camera.top = 11;
  keyLight.shadow.camera.bottom = -11;
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0x5f8fb2, 2.1);
  rimLight.position.set(-11, 7, -9);
  scene.add(rimLight);

  const warmLight = new THREE.PointLight(0xc2782c, 18, 16, 2);
  warmLight.position.set(-4, 3.5, 5);
  scene.add(warmLight);
}

function buildGrandPianoModel() {
  const keys = new Map();
  const whiteMidis = [];
  for (let midi = pianoLowestMidi; midi <= pianoHighestMidi; midi += 1) {
    if (whitePitchClasses.has(midi % 12)) whiteMidis.push(midi);
  }

  const root = new THREE.Group();
  root.rotation.y = -0.12;
  root.position.y = -0.35;

  const ebony = new THREE.MeshPhysicalMaterial({
    color: 0x160c0a,
    roughness: 0.2,
    metalness: 0.12,
    clearcoat: 0.95,
    clearcoatRoughness: 0.13,
  });
  const edgeWood = new THREE.MeshPhysicalMaterial({
    color: 0x3e1710,
    roughness: 0.26,
    metalness: 0.06,
    clearcoat: 0.78,
    clearcoatRoughness: 0.2,
  });
  const brass = new THREE.MeshStandardMaterial({ color: 0xc99232, metalness: 0.82, roughness: 0.24 });
  const stringMaterial = new THREE.MeshStandardMaterial({ color: 0xd3a54b, metalness: 0.9, roughness: 0.18 });

  const bodyShape = new THREE.Shape();
  bodyShape.moveTo(-6.55, -1.95);
  bodyShape.lineTo(6.15, -1.95);
  bodyShape.lineTo(6.55, 0.85);
  bodyShape.bezierCurveTo(6.8, 3.8, 4.5, 5.45, 1.1, 5.7);
  bodyShape.bezierCurveTo(-2.7, 5.98, -6.5, 4.65, -7.15, 2.1);
  bodyShape.bezierCurveTo(-7.45, 0.3, -7.1, -1.1, -6.55, -1.95);

  const body = new THREE.Mesh(
    new THREE.ExtrudeGeometry(bodyShape, {
      depth: 0.88,
      bevelEnabled: true,
      bevelSegments: 4,
      bevelSize: 0.16,
      bevelThickness: 0.13,
      curveSegments: 30,
    }),
    ebony,
  );
  body.geometry.rotateX(-Math.PI / 2);
  body.position.y = -1.56;
  body.castShadow = true;
  body.receiveShadow = true;
  root.add(body);

  const rim = new THREE.Mesh(
    new THREE.ExtrudeGeometry(bodyShape, {
      depth: 0.14,
      bevelEnabled: true,
      bevelSegments: 3,
      bevelSize: 0.1,
      bevelThickness: 0.08,
      curveSegments: 30,
    }),
    edgeWood,
  );
  rim.geometry.rotateX(-Math.PI / 2);
  rim.position.y = -0.58;
  rim.castShadow = true;
  root.add(rim);

  const soundboard = new THREE.Mesh(
    new THREE.CircleGeometry(4.7, 56, 0, Math.PI * 1.72),
    new THREE.MeshStandardMaterial({ color: 0x7d4b1f, roughness: 0.38, metalness: 0.08 }),
  );
  soundboard.rotation.x = -Math.PI / 2;
  soundboard.rotation.z = 0.54;
  soundboard.scale.set(1.26, 0.9, 1);
  soundboard.position.set(0.2, -0.43, -1.5);
  root.add(soundboard);

  for (let index = 0; index < 34; index += 1) {
    const stringLength = 2.2 + (index / 33) * 4.3;
    const string = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, stringLength, 6), stringMaterial);
    string.rotation.z = Math.PI / 2;
    string.rotation.y = -0.42 + (index / 33) * 0.88;
    string.position.set(-2.2 + index * 0.12, -0.3, -0.7 + index * 0.045);
    root.add(string);
  }

  const lid = new THREE.Mesh(
    new THREE.BoxGeometry(10.1, 0.16, 5.7),
    ebony,
  );
  lid.position.set(-0.55, 2.95, -0.95);
  lid.rotation.x = -0.48;
  lid.rotation.z = -0.06;
  lid.castShadow = true;
  root.add(lid);

  const lidRim = new THREE.Mesh(new THREE.BoxGeometry(10.3, 0.09, 0.1), edgeWood);
  lidRim.position.set(-0.55, 4.25, -2.25);
  lidRim.rotation.x = -0.48;
  lidRim.rotation.z = -0.06;
  root.add(lidRim);

  const lidProp = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 3.55, 12), brass);
  lidProp.position.set(3.25, 0.82, -1.4);
  lidProp.rotation.z = -0.2;
  lidProp.rotation.x = 0.15;
  root.add(lidProp);

  const keyboardBed = new THREE.Mesh(new THREE.BoxGeometry(12.85, 0.36, 2.85), edgeWood);
  keyboardBed.position.set(0, -0.22, 2.8);
  keyboardBed.castShadow = true;
  keyboardBed.receiveShadow = true;
  root.add(keyboardBed);

  const fallboard = new THREE.Mesh(new THREE.BoxGeometry(12.55, 0.74, 0.19), ebony);
  fallboard.position.set(0, 0.62, 1.38);
  fallboard.castShadow = true;
  root.add(fallboard);

  const musicDesk = new THREE.Mesh(new THREE.BoxGeometry(3.1, 1.45, 0.1), edgeWood);
  musicDesk.position.set(0, 1.72, 0.7);
  musicDesk.rotation.x = -0.18;
  musicDesk.castShadow = true;
  root.add(musicDesk);

  const keyboardRail = new THREE.Mesh(new THREE.BoxGeometry(12.72, 0.24, 0.14), ebony);
  keyboardRail.position.set(0, -0.43, 4.25);
  root.add(keyboardRail);

  const legPositions = [
    [-5.1, 3.45],
    [5.0, 3.45],
    [-4.8, -2.5],
  ];
  legPositions.forEach(([x, z]) => {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.5, 2.35, 18), ebony);
    leg.position.set(x, -1.82, z);
    leg.castShadow = true;
    root.add(leg);

    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.57, 0.66, 0.18, 18), edgeWood);
    foot.position.set(x, -2.98, z);
    foot.castShadow = true;
    root.add(foot);
  });

  [-0.34, 0, 0.34].forEach((x) => {
    const pedal = new THREE.Mesh(new THREE.SphereGeometry(0.17, 18, 12), brass);
    pedal.scale.set(1.7, 0.5, 0.8);
    pedal.position.set(x, -2.34, 4.12);
    pedal.castShadow = true;
    root.add(pedal);
  });

  const whitePositions = new Map();
  const pickables = [];
  const whiteSpacing = 0.24;
  const keyboardStart = -((whiteMidis.length - 1) * whiteSpacing) / 2;

  whiteMidis.forEach((midi, index) => {
    const key = buildThreePianoKey(
      midi,
      keyboardStart + index * whiteSpacing,
      false,
      index,
      root,
      pickables,
    );
    keys.set(midi, key);
    whitePositions.set(midi, index);
  });

  for (let midi = pianoLowestMidi + 1; midi < pianoHighestMidi; midi += 1) {
    if (!blackPitchClasses.has(midi % 12)) continue;
    const previousWhite = findPreviousWhite(midi);
    const nextWhite = findNextWhite(midi);
    if (!whitePositions.has(previousWhite) || !whitePositions.has(nextWhite)) continue;
    const index = (whitePositions.get(previousWhite) + whitePositions.get(nextWhite)) / 2;
    const key = buildThreePianoKey(
      midi,
      keyboardStart + index * whiteSpacing,
      true,
      index,
      root,
      pickables,
    );
    keys.set(midi, key);
  }

  return { root, keys, pickables };
}

function buildThreePianoKey(midi, x, black, index, root, pickables) {
  const pivot = new THREE.Group();
  pivot.position.set(x, black ? 0.04 : 0, 1.46);
  root.add(pivot);

  const material = new THREE.MeshStandardMaterial({
    color: black ? 0x08090b : 0xf0ece1,
    metalness: black ? 0.6 : 0.08,
    roughness: black ? 0.18 : 0.26,
    emissive: 0x000000,
    emissiveIntensity: 0.8,
  });
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(black ? 0.148 : 0.226, black ? 0.18 : 0.145, black ? 1.58 : 2.55),
    material,
  );
  mesh.position.set(0, black ? 0.05 : -0.07, black ? 0.79 : 1.275);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  pivot.add(mesh);

  const key = {
    midi,
    index,
    black,
    pressed: false,
    pressUntil: 0,
    pivot,
    mesh,
    materials: [material],
    pressRotation: 0.068,
  };
  mesh.userData.pianoKey = key;
  pickables.push(mesh);
  return key;
}

function animatePiano() {
  if (!state.piano) return;
  const now = performance.now();
  state.piano.keys.forEach((key) => {
    const pressed = key.pressUntil > now;
    key.pressed = pressed;
    const targetRotation = pressed ? key.pressRotation : 0;
    key.pivot.rotation.x += (targetRotation - key.pivot.rotation.x) * 0.28;
    const targetEmission = pressed ? 0x9a4e0c : 0x000000;
    key.materials.forEach((material) => material.emissive?.lerp(new THREE.Color(targetEmission), 0.24));
  });
  state.piano.controls.update();
  state.piano.renderer.render(state.piano.scene, state.piano.camera);
  requestAnimationFrame(animatePiano);
}

function previewPianoKey(midi) {
  const context = new AudioContext();
  pressPianoKey(midi, 0.58);
  playTone(context, midiToFrequency(midi), 0.58);
  window.setTimeout(() => context.close().catch(() => {}), 760);
}

function pressPianoKey(midi, duration) {
  const key = state.piano?.keys.get(clampMidiToPiano(midi));
  if (!key) return;
  key.pressUntil = performance.now() + Math.max(120, duration * 900);
}

function clampMidiToPiano(midi) {
  return Math.max(pianoLowestMidi, Math.min(pianoHighestMidi, midi));
}

function findPreviousWhite(midi) {
  for (let next = midi - 1; next >= pianoLowestMidi; next -= 1) {
    if (whitePitchClasses.has(next % 12)) return next;
  }
  return midi;
}

function findNextWhite(midi) {
  for (let next = midi + 1; next <= pianoHighestMidi; next += 1) {
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
  state.lastAnalysisAt = 0;
  state.lastCaptureAt = 0;
  state.lastVoicedAt = 0;
  state.pitchTracker.reset();
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
  state.pitchTracker.reset();

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
