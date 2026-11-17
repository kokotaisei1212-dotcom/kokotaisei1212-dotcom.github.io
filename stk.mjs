// STK: ask before your AI hands a conversation to a person. One call. https://stk-evidence.com/docs
//
//   import { ask } from "./stk.mjs";
//   if (await ask(conversationId, intent, trigger) === "finish") { /* your AI goes on */ } else { /* hand it to a person */ }
//
// trigger: unknown (your AI is not sure enough: the only one STK can answer finish), customer_asked, angry,
// out_of_scope, authority. After a person joins a conversation STK said finish on, call ask(..., {humanJoined: true}):
// that conversation is not billed, while its month is not closed (after the close STK refuses it with 409).
// Every answer comes with its row and STK's signature of it. STK keeps no row: this file keeps each one for you, as a
// JSON line in ROWS_DIR/<day>.jsonl (by default ./stk-rows), or gives it to setOnRow(fn) for your own store (a place
// with no files you keep, like a serverless function). If the folder cannot be written, the line goes to standard
// output. Lose them and STK cannot give them back. Check one: stk_verify.py.
// Without an answer within 300 ms, or on any error, ask() returns "escalate". The answer is still waited for (10 s):
// its row is kept, and if it said finish, STK is told that a person has the conversation, so it is not billed.
// A conversation that got finish once today (UTC) gets finish again without asking STK (each finish is billed); after a
// restart today's file is read again; with setOnRow it remembers only while the process runs. Many servers each
// remember their own: the same conversation asked on two of them is two.
// Node 18 or later, nothing to install.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
const KEY = "stk_test_...";   // your test key from the email STK sent you; the live key in its place when you go live
const URL = "https://api.stk-evidence.com/v1/ask";
const ROWS_DIR = process.env.STK_ROWS_DIR || "stk-rows";
let onRow = null;
export function setOnRow(fn) { onRow = fn; }
const finished = { day: null, ids: new Set() };
const today = () => new Date().toISOString().slice(0, 10);
function remember(row) {
  if (row && row.decision === "finish" && !row.human_joined && new Date(row.time_ms).toISOString().slice(0, 10) === finished.day)
    finished.ids.add(row.conversation_id);
}
async function finishedToday() {
  const d = today();
  if (finished.day !== d) {
    finished.day = d; finished.ids = new Set();
    if (!onRow) {
      try {
        for (const t of (await readFile(join(ROWS_DIR, d + ".jsonl"), "utf8")).split("\n")) {
          try { const r = JSON.parse(t).row; if (r.decision === "finish" && !r.human_joined) finished.ids.add(r.conversation_id); } catch {}
        }
      } catch {}
    }
  }
  return finished.ids;
}

async function keep(a) {
  if (!a || !a.row) return;
  remember(a.row);
  const line = { row: a.row, sig: a.sig };
  if (onRow) return onRow(line);
  const text = JSON.stringify(line);
  try {
    await mkdir(ROWS_DIR, { recursive: true });
    await appendFile(join(ROWS_DIR, new Date(a.row.time_ms).toISOString().slice(0, 10) + ".jsonl"), text + "\n");
  } catch { process.stdout.write(text + "\n"); }
}

const post = (b) => fetch(URL, { method: "POST", headers: { "Content-Type": "application/json", "X-STK-Key": KEY },
  body: JSON.stringify(b), signal: AbortSignal.timeout(10000) }).then((r) => (r.ok ? r.json() : null));

export async function ask(conversationId, intent, trigger, { humanJoined } = {}) {
  if (!humanJoined && (await finishedToday()).has(String(conversationId))) return "finish";   // not asked, not billed again
  const body = { conversation_id: String(conversationId), intent, trigger };
  if (humanJoined) body.human_joined = true;
  let late = false;
  const answer = post(body).catch(() => null);
  const kept = answer.then(async (a) => {
    await keep(a).catch(() => {});
    if (late && a && a.decision === "finish" && !humanJoined)   // your code did not wait: a person has it
      await post({ ...body, human_joined: true }).then((b) => keep(b)).catch(() => {});
  });
  kept.catch(() => {});
  const timer = new Promise((r) => setTimeout(() => r("late"), 300));
  const first = await Promise.race([answer, timer]);
  if (first === "late") { late = true; return "escalate"; }
  return (first && first.decision) || "escalate";
}
