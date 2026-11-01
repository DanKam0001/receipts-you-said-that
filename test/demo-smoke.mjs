import { request as httpRequest } from "node:http";

const base = `http://127.0.0.1:${process.env.RECEIPTS_PORT ?? 3000}`;
const request = (path, options = {}) => new Promise((resolve, reject) => {
  const body = options.body ?? "";
  const req = httpRequest(base + path, { method: options.method ?? "GET", headers: options.headers }, res => {
    let data = ""; res.setEncoding("utf8"); res.on("data", part => data += part);
    res.on("end", () => res.statusCode && res.statusCode >= 200 && res.statusCode < 300
      ? resolve({ status: res.statusCode, json: () => JSON.parse(data) })
      : reject(new Error(`${path} returned ${res.statusCode}`)));
  });
  req.on("error", reject); req.end(body);
});

let state = (await request("/api/state")).json();
if (!state.simulated) throw new Error("Demo state did not mark simulated chat");
await request("/api/opt-in", { method: "POST" });
await request("/api/simulate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "!receipts you said it was raining" }) });
state = (await request("/api/state")).json();
if (state.receipt?.outcome !== "CAN'T TELL" || state.lives !== 3) throw new Error("Empty transcript should be non-punitive CAN'T TELL");
const overlay = await request("/overlay.html"), control = await request("/control");
console.log(JSON.stringify({ simulated: state.simulated, outcome: state.receipt.outcome, lives: state.lives, overlay: overlay.status, control: control.status }));
