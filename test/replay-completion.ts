import assert from "node:assert/strict";
import { ReplayCompletion } from "../src/replay-completion.js";

const replay = new ReplayCompletion();
replay.addChunk();
replay.addChunk();
replay.end();
let resolved = false;
void replay.done.then(() => { resolved = true; });
await Promise.resolve();
assert.equal(resolved, false, "replay waits until all arrived chunks complete");
replay.finishChunk();
await Promise.resolve();
assert.equal(resolved, false, "one finished chunk does not complete a two-chunk replay");
replay.finishChunk();
await replay.done;
assert.equal(replay.counts.completed, 2);
console.log("ok - replay completion waits for every chunk after source end");
