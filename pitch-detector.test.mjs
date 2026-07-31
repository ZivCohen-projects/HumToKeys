import assert from "node:assert/strict";
import { estimatePitchYin } from "./pitch-detector.mjs";

const sampleRate = 44100;
const testPitches = [82.41, 110, 117.3, 196, 261.63, 446.2, 659.26, 880];

for (const expectedFrequency of testPitches) {
  const signal = createVoiceLikeSignal(expectedFrequency);
  const result = estimatePitchYin(signal, sampleRate);
  assert.ok(result, `Expected a pitch estimate for ${expectedFrequency} Hz.`);
  const centsError = 1200 * Math.log2(result.frequency / expectedFrequency);
  assert.ok(
    Math.abs(centsError) < 8,
    `Expected ${expectedFrequency} Hz within 8 cents, got ${result.frequency.toFixed(2)} Hz.`,
  );
  assert.ok(result.clarity > 0.8, `Expected a clear estimate for ${expectedFrequency} Hz.`);
}

const harmonicHeavyResult = estimatePitchYin(createHarmonicHeavySignal(196), sampleRate);
assert.ok(harmonicHeavyResult, "Expected an estimate when the second harmonic is strongest.");
assert.ok(
  Math.abs(1200 * Math.log2(harmonicHeavyResult.frequency / 196)) < 8,
  "Expected the detector to keep the 196 Hz fundamental instead of jumping an octave.",
);

assert.equal(estimatePitchYin(new Float32Array(4096), sampleRate), null);
console.log("Pitch detector checks passed.");

function createVoiceLikeSignal(frequency) {
  const samples = new Float32Array(4096);
  let noiseSeed = 17;
  for (let index = 0; index < samples.length; index += 1) {
    const time = index / sampleRate;
    noiseSeed = (noiseSeed * 16807) % 2147483647;
    const noise = ((noiseSeed / 2147483647) * 2 - 1) * 0.006;
    samples[index] =
      0.54 * Math.sin(2 * Math.PI * frequency * time) +
      0.18 * Math.sin(2 * Math.PI * frequency * 2 * time) +
      0.1 * Math.sin(2 * Math.PI * frequency * 3 * time) +
      noise;
  }
  return samples;
}

function createHarmonicHeavySignal(frequency) {
  const samples = new Float32Array(8192);
  for (let index = 0; index < samples.length; index += 1) {
    const time = index / sampleRate;
    samples[index] =
      0.12 * Math.sin(2 * Math.PI * frequency * time) +
      0.58 * Math.sin(2 * Math.PI * frequency * 2 * time) +
      0.18 * Math.sin(2 * Math.PI * frequency * 3 * time);
  }
  return samples;
}
