import assert from "node:assert/strict";
import { inferNoteFrames, StablePitchTracker } from "./note-tracker.mjs";

const tracker = new StablePitchTracker();
let lockedMidi = null;
for (let frame = 0; frame < 18; frame += 1) {
  const wobble = [-0.38, -0.24, -0.11, 0.09, 0.27, 0.41][frame % 6];
  lockedMidi = tracker.observe({ midiFloat: 60 + wobble, clarity: 0.92, time: frame * 36 }).midi;
}
assert.equal(lockedMidi, 60, "A wobbly C must lock to C instead of flipping to C#.");

let changedMidi = lockedMidi;
for (let frame = 18; frame < 34; frame += 1) {
  const wobble = [-0.2, 0.08, 0.23, -0.1][frame % 4];
  changedMidi = tracker.observe({ midiFloat: 61 + wobble, clarity: 0.9, time: frame * 36 }).midi;
}
assert.equal(changedMidi, 61, "A held half-step change must eventually be accepted.");

let octaveMidi = changedMidi;
for (let frame = 34; frame < 38; frame += 1) {
  octaveMidi = tracker.observe({ midiFloat: 73, clarity: 0.82, time: frame * 36 }).midi;
}
assert.equal(octaveMidi, 61, "A brief octave error must not replace the held note.");

const sharpWobbleTracker = new StablePitchTracker();
for (let frame = 0; frame < 10; frame += 1) {
  sharpWobbleTracker.observe({ midiFloat: 60 + [-0.18, 0.04, 0.16, -0.07][frame % 4], clarity: 0.9, time: frame * 36 });
}
let sharpWobbleMidi = 60;
for (const [index, offset] of [0.68, 0.74, 0.63, 0.21].entries()) {
  sharpWobbleMidi = sharpWobbleTracker.observe({ midiFloat: 60 + offset, clarity: 0.88, time: (10 + index) * 36 }).midi;
}
assert.equal(sharpWobbleMidi, 60, "Brief sharp-leaning vocal drift must stay on C instead of becoming C#.");

const frames = [
  ...createFrames(60, 8, 0),
  ...createFrames(61, 2, 8),
  ...createFrames(60, 8, 10),
  ...createFrames(62, 7, 18),
];
const inferred = inferNoteFrames(frames);
assert.ok(inferred.slice(0, 18).every((frame) => frame.midi === 60), "A two-frame C# wobble must not become a score note.");
assert.ok(inferred.slice(18).every((frame) => frame.midi === 62), "A held D must remain a real note change.");

console.log("Note tracker checks passed.");

function createFrames(midi, count, start) {
  return Array.from({ length: count }, (_, index) => ({
    time: (start + index) * 0.072,
    midiFloat: midi + [-0.18, 0.05, 0.16, -0.08][index % 4],
    clarity: 0.9,
    breakBefore: false,
  }));
}
