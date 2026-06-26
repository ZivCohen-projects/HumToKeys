const state = {
  audioContext: null,
  analyser: null,
  mediaStream: null,
  rafId: 0,
  recording: false,
  startedAt: 0,
  lastCaptureAt: 0,
  rawFrames: [],
  melody: [],
  piano: null,
  activeKey: null,
};

const els = {
  recordButton: document.querySelector("#recordButton"),
  stopButton: document.querySelector("#stopButton"),
  demoButton: document.querySelector("#demoButton"),
  clearButton: document.querySelector("#clearButton"),
  playButton: document.querySelector("#playButton"),
  statusPill: document.querySelector("#statusPill"),
  currentNote: document.querySelector("#currentNote"),
  frequencyReadout: document.querySelector("#frequencyReadout"),
  levelBar: document.querySelector("#levelBar"),
  noteCount: document.querySelector("#noteCount"),
  durationReadout: document.querySelector("#durationReadout"),
  noteTrail: document.querySelector("#noteTrail"),
  sheetSvg: document.querySelector("#sheetSvg"),
  pianoScene: document.querySelector("#pianoScene"),
};

const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const whitePitchClasses = new Set([0, 2, 4, 5, 7, 9, 11]);
const blackPitchClasses = new Set([1, 3, 6, 8, 10]);

initPiano();
renderEmptySheet();

els.recordButton.addEventListener("click", startRecording);
els.stopButton.addEventListener("click", stopRecording);
els.demoButton.addEventListener("click", loadDemo);
els.clearButton.addEventListener("click", clearMelody);
els.playButton.addEventListener("click", playMelody);
window.addEventListener("resize", resizePiano);

async function startRecording() {
  try {
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

    els.statusPill.textContent = "Listening";
    els.recordButton.disabled = true;
    els.stopButton.disabled = false;
    els.playButton.disabled = true;
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
    const midi = frequencyToMidi(pitch);
    const note = midiToNoteName(midi);
    els.currentNote.textContent = note;
    els.frequencyReadout.textContent = `${pitch.toFixed(1)} Hz`;

    if (now - state.lastCaptureAt > 105) {
      state.rawFrames.push({ time: elapsed, frequency: pitch, midi });
      state.lastCaptureAt = now;
      renderTrailFromFrames();
    }
  } else {
    els.currentNote.textContent = "--";
    els.frequencyReadout.textContent = "Listening for a clear pitch.";
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
    .map((note, index) => ({
      ...note,
      start: index === 0 ? 0 : note.start - notes[0].start,
      duration: quantizeDuration(note.duration),
    }))
    .slice(0, 48);
}

function quantizeDuration(duration) {
  const grid = 0.25;
  return Math.max(grid, Math.round(duration / grid) * grid);
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
    item.textContent = `${note.note} - ${note.duration.toFixed(2)}s`;
    els.noteTrail.append(item);
  });
}

function renderEmptySheet() {
  els.sheetSvg.innerHTML = `
    <rect x="0" y="0" width="980" height="330" fill="#fffdf8"></rect>
    ${staffLines()}
    <text x="54" y="176" font-size="84" font-family="Georgia, serif" fill="#1f2320">G</text>
    <text x="178" y="176" font-size="22" fill="#697269">Record or load a demo to generate notation.</text>
  `;
}

function renderSheet(notes) {
  if (!notes.length) {
    renderEmptySheet();
    return;
  }

  const spacing = Math.max(46, Math.min(84, 780 / notes.length));
  const noteShapes = notes
    .map((note, index) => {
      const x = 150 + index * spacing;
      const y = midiToSheetY(note.midi);
      const stemUp = y > 132;
      const stemY = stemUp ? y - 58 : y + 58;
      const stemX = stemUp ? x + 11 : x - 11;
      const labelY = 282;
      return `
        ${ledgerLines(note.midi, x)}
        <ellipse cx="${x}" cy="${y}" rx="14" ry="10" transform="rotate(-18 ${x} ${y})" fill="#1f2320"></ellipse>
        <line x1="${stemX}" y1="${y}" x2="${stemX}" y2="${stemY}" stroke="#1f2320" stroke-width="3"></line>
        <text x="${x - 18}" y="${labelY}" font-size="13" fill="#697269">${note.note}</text>
      `;
    })
    .join("");

  els.sheetSvg.innerHTML = `
    <rect x="0" y="0" width="980" height="330" fill="#fffdf8"></rect>
    ${staffLines()}
    <text x="52" y="176" font-size="84" font-family="Georgia, serif" fill="#1f2320">G</text>
    <line x1="118" y1="74" x2="118" y2="218" stroke="#1f2320" stroke-width="3"></line>
    ${noteShapes}
  `;
}

function staffLines() {
  return [84, 110, 136, 162, 188]
    .map((y) => `<line x1="44" y1="${y}" x2="936" y2="${y}" stroke="#1f2320" stroke-width="2"></line>`)
    .join("");
}

function midiToSheetY(midi) {
  return 188 - (midi - 64) * 6.5;
}

function ledgerLines(midi, x) {
  const y = midiToSheetY(midi);
  if (y >= 82 && y <= 190) return "";
  const lines = [];
  if (y < 82) {
    for (let lineY = 58; lineY >= y - 8; lineY -= 26) {
      lines.push(`<line x1="${x - 20}" y1="${lineY}" x2="${x + 20}" y2="${lineY}" stroke="#1f2320" stroke-width="2"></line>`);
    }
  }
  if (y > 190) {
    for (let lineY = 214; lineY <= y + 8; lineY += 26) {
      lines.push(`<line x1="${x - 20}" y1="${lineY}" x2="${x + 20}" y2="${lineY}" stroke="#1f2320" stroke-width="2"></line>`);
    }
  }
  return lines.join("");
}

async function playMelody() {
  if (!state.melody.length) return;
  els.playButton.disabled = true;
  const context = new AudioContext();

  for (const note of state.melody) {
    pressPianoKey(note.midi, note.duration);
    playTone(context, midiToFrequency(note.midi), note.duration);
    await sleep(note.duration * 1000);
  }

  await context.close();
  els.playButton.disabled = false;
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
  const demo = [60, 62, 64, 67, 64, 62, 60, 67, 69, 67, 64, 62, 60];
  state.melody = demo.map((midi, index) => ({
    midi,
    note: midiToNoteName(midi),
    frequency: midiToFrequency(midi),
    start: index * 0.42,
    duration: index % 4 === 3 ? 0.7 : 0.42,
  }));
  els.statusPill.textContent = "Demo loaded";
  els.currentNote.textContent = state.melody[0].note;
  els.frequencyReadout.textContent = "Demo melody ready for playback.";
  els.playButton.disabled = false;
  renderMelody();
}

function clearMelody() {
  state.rawFrames = [];
  state.melody = [];
  els.currentNote.textContent = "--";
  els.frequencyReadout.textContent = "Waiting for microphone input.";
  els.noteCount.textContent = "0";
  els.durationReadout.textContent = "0.0s";
  els.noteTrail.innerHTML = "";
  els.playButton.disabled = true;
  renderEmptySheet();
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

function frequencyToMidi(frequency) {
  return Math.round(69 + 12 * Math.log2(frequency / 440));
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
