import assert from "node:assert/strict";
import { RollingAudioBuffer } from "../src/audio.js";
import { decide } from "../src/matcher.js";
import type { Utterance } from "../src/model.js";

let count = 0;
function test(name: string, body: () => void) { body(); count++; console.log(`ok ${count} - ${name}`); }
const transcript: Utterance[] = [
  { start: 10, end: 12, text: "The hallway is quiet.", embedding: [0, 1] },
  { start: 12, end: 15, text: "I said that I would eat the whole cake.", embedding: [1, 0] },
  { start: 15, end: 17, text: "Now let us start the game.", embedding: [0, 1] },
  { start: 17, end: 20, text: "Everyone in the room was ready to begin the evening game show.", embedding: [0, 1] }
];

test("confident match quotes exact transcript and surrounding sentences", () => {
  const result = decide("you said you would eat the whole cake", transcript, "viewer", "receipt-1", [1, 0]);
  assert.equal(result.outcome, "RECEIPT FOUND");
  assert.equal(result.quote, "I said that I would eat the whole cake.");
  assert.equal(result.context, "The hallway is quiet. … Now let us start the game.");
  assert.equal(result.timestamp, 12); assert.equal(result.clipStart, 10); assert.equal(result.clipEnd, 17);
});

test("confident miss has no transcript word overlap", () => {
  const reliable = [
    { start: 0, end: 3, text: "The tournament started early with everyone waiting quietly beside the brightly decorated entrance hall.", embedding: [0, 1] },
    { start: 3, end: 6, text: "We chose a different map and invited the whole team.", embedding: [0, 1] },
    { start: 6, end: 9, text: "The final round was close but nobody scored a point.", embedding: [0, 1] },
    { start: 9, end: 12, text: "After that we went straight back to the lobby and discussed our weekend plans before leaving together.", embedding: [0, 1] }
  ];
  const outcome = decide("you said the extraterrestrial cosmonaut fabricated a lavender sandwich yesterday", reliable, "viewer", undefined, [1, 0]).outcome;
  assert.equal(outcome, "NO MATCH");
  assert.equal(decide("you said the extraterrestrial cosmonaut fabricated a lavender sandwich yesterday", [{ start: 0, end: 1, text: "A short sentence.", embedding: [0, 1] }], "viewer", undefined, [1, 0]).outcome, "CAN'T TELL");
});

test("ambiguous and unusably short claims return CAN'T TELL", () => {
  const duplicate = [...transcript, { start: 20, end: 22, text: "I said that I would eat the whole cake.", embedding: [1, 0] }];
  assert.equal(decide("you said you would eat the whole cake", duplicate, "viewer", undefined, [1, 0]).outcome, "CAN'T TELL");
  assert.equal(decide("!", transcript, "viewer", undefined, [1, 0]).outcome, "CAN'T TELL");
});

test("negation and always/never contradiction prevents a semantic hit", () => {
  const contradiction: Utterance[] = [
    { start: 0, end: 1, text: "We loaded the game after checking all of the equipment and microphones carefully before the first round started.", embedding: [0, 1] },
    { start: 1, end: 2, text: "I'll always play this.", embedding: [1, 0] },
    { start: 2, end: 3, text: "The next round is beginning now while all the players watch.", embedding: [0, 1] },
    { start: 3, end: 4, text: "Everyone is ready to play another long round together after testing the headsets and controls.", embedding: [0, 1] }
  ];
  assert.notEqual(decide("you said you'd never play this", contradiction, "viewer", undefined, [1, 0]).outcome, "RECEIPT FOUND");
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
