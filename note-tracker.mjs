const trackerDefaults = {
  historyMs: 220,
  initialHoldMs: 140,
  noteChangeHoldMs: 150,
  noteDeadband: 0.76,
  inlierRange: 0.46,
  minimumSamples: 4,
  minimumSupport: 0.66,
};

export class StablePitchTracker {
  constructor(options = {}) {
    this.settings = { ...trackerDefaults, ...options };
    this.reset();
  }

  reset() {
    this.history = [];
    this.stableMidi = null;
    this.pendingMidi = null;
    this.pendingSince = 0;
  }

  observe({ midiFloat, clarity = 1, time, snapMidi = Math.round }) {
    if (!Number.isFinite(midiFloat) || !Number.isFinite(time)) return this.snapshot();

    const weight = Math.max(0.2, Math.min(1, clarity));
    this.history.push({ midiFloat, weight, time });
    this.history = this.history.filter((sample) => time - sample.time <= this.settings.historyMs);

    const consensus = getPitchConsensus(this.history, this.settings);
    if (!consensus) return this.snapshot();

    const candidateMidi = snapMidi(Math.round(consensus.midiFloat));
    if (this.stableMidi === null) {
      this.advancePending(candidateMidi, time);
      if (time - this.pendingSince >= this.settings.initialHoldMs) {
        this.stableMidi = candidateMidi;
        this.clearPending();
      }
      return this.snapshot(consensus, candidateMidi);
    }

    const closeToStable = Math.abs(consensus.midiFloat - this.stableMidi) < this.settings.noteDeadband;
    if (candidateMidi === this.stableMidi || closeToStable) {
      this.clearPending();
      return this.snapshot(consensus, candidateMidi);
    }

    this.advancePending(candidateMidi, time);
    if (time - this.pendingSince >= this.settings.noteChangeHoldMs) {
      this.stableMidi = candidateMidi;
      this.clearPending();
    }

    return this.snapshot(consensus, candidateMidi);
  }

  advancePending(midi, time) {
    if (this.pendingMidi === midi) return;
    this.pendingMidi = midi;
    this.pendingSince = time;
  }

  clearPending() {
    this.pendingMidi = null;
    this.pendingSince = 0;
  }

  snapshot(consensus = null, candidateMidi = null) {
    return {
      midi: this.stableMidi,
      candidateMidi,
      midiFloat: consensus?.midiFloat ?? null,
      confidence: consensus?.support ?? 0,
      settling: this.stableMidi === null || this.pendingMidi !== null,
    };
  }
}

export function inferNoteFrames(frames, { snapMidi = Math.round } = {}) {
  if (!frames.length) return [];

  const inferred = [];
  let segment = [];
  for (const frame of frames) {
    if (frame.breakBefore && segment.length) {
      inferred.push(...inferSegment(segment, snapMidi));
      segment = [];
    }
    segment.push(frame);
  }
  inferred.push(...inferSegment(segment, snapMidi));
  return inferred;
}

function getPitchConsensus(history, settings) {
  if (history.length < settings.minimumSamples) return null;

  const midpoint = weightedMedian(history);
  const inliers = history.filter((sample) => Math.abs(sample.midiFloat - midpoint) <= settings.inlierRange);
  if (inliers.length < settings.minimumSamples) return null;

  const inlierWeight = inliers.reduce((total, sample) => total + sample.weight, 0);
  const totalWeight = history.reduce((total, sample) => total + sample.weight, 0);
  const midiFloat = inliers.reduce((total, sample) => total + sample.midiFloat * sample.weight, 0) / inlierWeight;
  const targetMidi = Math.round(midiFloat);
  const targetWeight = history
    .filter((sample) => Math.abs(sample.midiFloat - targetMidi) <= settings.inlierRange)
    .reduce((total, sample) => total + sample.weight, 0);
  const support = targetWeight / totalWeight;

  if (support < settings.minimumSupport) return null;
  return { midiFloat, support };
}

function inferSegment(frames, snapMidi) {
  if (!frames.length) return [];
  const smoothed = frames.map((_, index) => weightedMedian(
    frames
      .slice(Math.max(0, index - 2), Math.min(frames.length, index + 3))
      .map((frame) => ({ midiFloat: frame.midiFloat, weight: Math.max(0.2, frame.clarity ?? 1) })),
  ));
  const labels = runViterbi(smoothed, frames);
  const cleanedLabels = mergeShortRuns(labels, smoothed, frames);

  return frames.map((frame, index) => ({
    ...frame,
    midi: snapMidi(cleanedLabels[index]),
  }));
}

function runViterbi(observations, frames) {
  const low = Math.floor(Math.min(...observations)) - 2;
  const high = Math.ceil(Math.max(...observations)) + 2;
  const states = Array.from({ length: high - low + 1 }, (_, index) => low + index);
  let costs = states.map((state, index) => emissionCost(observations[0], state, frames[0]) + index * 0);
  const paths = [];

  for (let frameIndex = 1; frameIndex < observations.length; frameIndex += 1) {
    const nextCosts = [];
    const previousIndexes = [];
    for (let stateIndex = 0; stateIndex < states.length; stateIndex += 1) {
      let bestCost = Infinity;
      let bestPreviousIndex = 0;
      for (let previousIndex = 0; previousIndex < states.length; previousIndex += 1) {
        const distance = Math.abs(states[stateIndex] - states[previousIndex]);
        const transition = distance ? 0.8 + Math.min(1.2, distance * 0.08) : 0;
        const cost = costs[previousIndex] + transition;
        if (cost < bestCost) {
          bestCost = cost;
          bestPreviousIndex = previousIndex;
        }
      }
      nextCosts.push(bestCost + emissionCost(observations[frameIndex], states[stateIndex], frames[frameIndex]));
      previousIndexes.push(bestPreviousIndex);
    }
    paths.push(previousIndexes);
    costs = nextCosts;
  }

  let index = costs.reduce((best, cost, current) => cost < costs[best] ? current : best, 0);
  const labels = new Array(observations.length);
  labels[labels.length - 1] = states[index];
  for (let frameIndex = paths.length - 1; frameIndex >= 0; frameIndex -= 1) {
    index = paths[frameIndex][index];
    labels[frameIndex] = states[index];
  }
  return labels;
}

function mergeShortRuns(labels, observations, frames) {
  const result = [...labels];
  for (let pass = 0; pass < 2; pass += 1) {
    const runs = getRuns(result);
    for (const run of runs) {
      if (run.length >= 3 || !run.before || !run.after) continue;
      const beforeCost = runCost(run, run.before.midi, observations, frames);
      const afterCost = runCost(run, run.after.midi, observations, frames);
      const replacement = beforeCost <= afterCost ? run.before.midi : run.after.midi;
      result.fill(replacement, run.start, run.end + 1);
    }
  }
  return result;
}

function getRuns(labels) {
  const runs = [];
  let start = 0;
  for (let index = 1; index <= labels.length; index += 1) {
    if (index < labels.length && labels[index] === labels[start]) continue;
    runs.push({ start, end: index - 1, length: index - start, midi: labels[start] });
    start = index;
  }
  return runs.map((run, index) => ({
    ...run,
    before: runs[index - 1] ?? null,
    after: runs[index + 1] ?? null,
  }));
}

function runCost(run, midi, observations, frames) {
  let cost = 0;
  for (let index = run.start; index <= run.end; index += 1) {
    cost += emissionCost(observations[index], midi, frames[index]);
  }
  return cost;
}

function emissionCost(observation, midi, frame) {
  const confidence = Math.max(0.25, frame.clarity ?? 1);
  return Math.min(4, (observation - midi) ** 2) * confidence;
}

function weightedMedian(samples) {
  const sorted = [...samples].sort((left, right) => left.midiFloat - right.midiFloat);
  const totalWeight = sorted.reduce((total, sample) => total + sample.weight, 0);
  let accumulated = 0;
  for (const sample of sorted) {
    accumulated += sample.weight;
    if (accumulated >= totalWeight / 2) return sample.midiFloat;
  }
  return sorted[sorted.length - 1]?.midiFloat ?? 0;
}
