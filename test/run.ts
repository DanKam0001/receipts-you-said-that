import assert from "node:assert/strict";
import { RollingAudioBuffer } from "../src/audio.js";
import { decide } from "../src/matcher.js";
import type { Utterance } from "../src/model.js";

let count = 0;
function test(name: string, body: () => void) { body(); count++; console.log(`ok ${count} - ${name}`); }
const transcript: Utterance[] = [
  { start: 10, end: 12, text: "The hallway is quiet." },
  { start: 12, end: 15, text: "I never said that I would eat the whole cake." },
  { start: 15, end: 17, text: "Now let us start the game." }
];

test("confident match quotes exact transcript and surrounding sentences", () => {
  const result = decide("you said you would eat the whole cake", transcript, "viewer", "receipt-1");
  assert.equal(result.outcome, "RECEIPT FOUND");
  assert.equal(result.quote, "I never said that I would eat the whole cake.");
  assert.equal(result.context, "The hallway is quiet. … Now let us start the game.");
  assert.equal(result.timestamp, 12); assert.equal(result.clipStart, 10); assert.equal(result.clipEnd, 17);
});

test("confident miss has no transcript word overlap", () => {
  const reliable = [
    { start: 0, end: 3, text: "The tournament started early with everyone waiting quietly." },
    { start: 3, end: 6, text: "We chose a different map and invited the whole team." },
    { start: 6, end: 9, text: "The final round was close but nobody scored a point." },
    { start: 9, end: 12, text: "After that we went straight back to the lobby." }
  ];
  const outcome = decide("spaceship announcement yesterday", reliable, "viewer").outcome;
  assert.equal(outcome, "NO MATCH");
  assert.equal(decide("spaceship announcement yesterday", transcript, "viewer").outcome, "CAN'T TELL");
});

test("ambiguous and unusably short claims return CAN'T TELL", () => {
  const duplicate = [...transcript, { start: 20, end: 22, text: "I never said that I would eat the whole cake." }];
  assert.equal(decide("you said you would eat the whole cake", duplicate, "viewer").outcome, "CAN'T TELL");
  assert.equal(decide("!", transcript, "viewer").outcome, "CAN'T TELL");
});

test("rolling audio buffer emits a WAV cropped to the requested interval", () => {
  const ring = new RollingAudioBuffer(4); ring.push({ start: 0, end: 2, pcm: Buffer.alloc(64000, 1) });
  const clip = ring.clip(0.5, 1.5)!;
  assert.equal(clip.subarray(0, 4).toString(), "RIFF"); assert.equal(clip.readUInt32LE(40), 32000); assert.equal(clip.length, 32044);
});

test("rolling buffer expires audio outside its time window", () => {
  const ring = new RollingAudioBuffer(3);
  ring.push({ start: 0, end: 2, pcm: Buffer.alloc(64000) }); ring.push({ start: 2, end: 4, pcm: Buffer.alloc(64000) });
  assert.equal(ring.clip(0, 1), undefined);
});

console.log(`\n${count} tests passed`);
