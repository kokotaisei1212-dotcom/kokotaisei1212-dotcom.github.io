// STK: ask before your AI hands a conversation to a person. https://stk-evidence.com/docs
//
//   import { ask, joined } from "./stk.mjs";
//   if (await ask(intent, trigger, { conversationId }) === "finish") { /* your AI goes on */ } else { /* hand it to a person */ }
//   await joined(conversationId);   // a person joined a conversation that got finish: taken off its day's bill
//
// trigger: a trigger of the rules' Triggers list (https://stk-evidence.com/rules-full#triggers) that happened in the
// conversation: customer_asked, distressed, angry, bereavement, threat, legal_claim; or unknown when none of them
// happened (the only one the rules can answer finish to).
// This file decides, here, on your side, from STK's public rules (GET /v1/rules, the same for every company, signed by
// STK). STK receives nothing of the conversation. Only on finish does it call STK, and it sends the seal and the time it recorded the action:
// SHA-256 of 32 random bytes and your row (intent, trigger and any fields you give in the third argument). The row and
// the random bytes stay here. STK signs the seal with the time and the rules version: that is the permission, and each
// one is billed. Unpaid 60 days after a due date, or STK without a published key: no signature, and ask() escalates.
// Each permission is one JSON line in ROWS_DIR/<day>.jsonl (by default ./stk-rows, or STK_ROWS_DIR), kept before ask()
// returns, or given to setOnRow(fn) for your own store; if the folder cannot be written, the line goes to standard
// output; if your function throws, the permission is told to STK as a person joining and ask() escalates. Check them:
// stk_verify.py. An intent on no list of the rules leaves a not_listed line there, for your own count; STK is not told.
// When STK's answer says a newer version of the rules, this file reads them again and applies them again; if they now
// say escalate, it escalates and tells STK a person has it, so it is not billed. The same conversation and intent that
// got finish today (UTC) gets finish again without calling STK. Without an answer within 300 ms, or on any error,
// ask() escalates; a late permission is told to STK as a person joining, so it is not billed.
// Each answer of STK's also brings a grant, signed by STK, for this account and this version of the rules, for 10 minutes.
// If STK cannot be reached (no answer within 300 ms, or an error reaching it) while the last grant holds, the rules here
// say finish and the queue is not full, ask() returns "finish" and the seal waits in a queue, kept as a queued line; it
// is sent as soon as STK answers again, and STK signs it as any seal. The grant gone, or queueMax seals waiting:
// "escalate", as before. A receipt has two times: recorded_ms, when this file recorded the action (your claim), and
// time_ms, when STK signed (what STK attests). They are the same moment unless the seal waited in the queue.
// Try it without a key: node stk.mjs conversation.order.status unknown   (it reads the public rules; it sends nothing)
// Node 18 or later, nothing to install.
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
export const config = {
  key: "stk_test_...",   // your test key, shown once when you took it; the live key in its place when you go live
  api: process.env.STK_API || "https://api.stk-evidence.com",
  timeout: 300,
  rowsDir: process.env.STK_ROWS_DIR || "stk-rows",
  onRow: null,           // or a function(line): each line, for your own store
  queueMax: 10000,       // seals waiting for STK at most; past it, "escalate"
  queueRetry: 5000,      // ms between tries to send the queue
};
let grant = null;        // the last grant: g, sig, until (performance.now())
const queue = new Map(); // seal -> its queued line, waiting for STK; in the order recorded
let offset = 0;          // ms to add to this machine's clock when STK said it is more than a minute off
let sending = false;
const nowMs = () => Date.now() + offset;
const grantOk = (version) => !!grant && grant.g.rule_version === version && performance.now() < grant.until && queue.size < config.queueMax;
function keepGrant(a) {
  if (a && a.grant && a.grant_sig) grant = { g: a.grant, sig: a.grant_sig, until: performance.now() + (a.grant.expires_ms - a.grant.issued_ms) };
  if (a && a.receipt) { const d = a.receipt.time_ms - Date.now(); offset = Math.abs(d) > 30000 ? d : 0; }
}
export function setOnRow(fn) { config.onRow = fn; }
let current = null;      // the signed rules in use
const done = { day: null, set: new Set(), kids: new Set(), seals: new Map(), yesterday: new Map(), told: new Set() };
const GRACE = 600;   // seconds after midnight (UTC) in which STK counts a seal of the day before for its day
const today = () => new Date(Date.now()).toISOString().slice(0, 10);

// An intent's full name, with its domain (conversation.claim.status), is read as the name listed (claim.status).
function named(intent, sets) {
  const has = (x) => sets.some((s) => s.has(x));
  return typeof intent === "string" && intent.startsWith("conversation.") && has(intent.slice(13)) ? intent.slice(13) : intent;
}

export function decide(text, intent, trigger) {
  const lst = (name) => {
    const m = text.match(new RegExp("^" + name + " \\((\\d+)\\): (.*)$", "m"));
    const items = m[2] === "none" ? [] : m[2].split(",").map((x) => x.trim().split(" (closed")[0]);
    if (items.length !== Number(m[1])) throw new Error("the rules text does not read as STK's");
    return new Set(items);
  };
  const never = lst("Never"), permitted = lst("Permitted"), closed = lst("Closed");
  intent = named(intent, [never, permitted, closed]);
  if (trigger !== "unknown") return "escalate";
  if (never.has(intent)) return "escalate";
  if (!never.has(intent) && !permitted.has(intent) && !closed.has(intent)) return "escalate";
  if (closed.has(intent)) return "escalate";
  return "finish";
}

export function listed(text, intent) {   // the intent is on one of the rules' lists (Never, Permitted, Closed)
  for (const name of ["Never", "Permitted", "Closed"]) {
    const m = text.match(new RegExp("^" + name + " \\((\\d+)\\): (.*)$", "m"));
    const items = m[2] === "none" ? [] : m[2].split(",").map((x) => x.trim().split(" (closed")[0]);
    if (items.includes(intent) || (typeof intent === "string" && intent.startsWith("conversation.") && items.includes(intent.slice(13)))) return true;
  }
  return false;
}

async function http(method, path, body, key = true, ms = 10000) {
  const headers = { "Content-Type": "application/json", "User-Agent": "stk.mjs" };
  if (key) headers["X-STK-Key"] = config.key;
  const r = await fetch(config.api + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(ms) });
  if (!r.ok) { const e = new Error(String(r.status)); e.status = r.status; e.headers = r.headers; throw e; }
  return r.json();
}

async function write(line) {
  if (config.onRow) return config.onRow(line);
  const text = JSON.stringify(line);
  try {
    await mkdir(config.rowsDir, { recursive: true });
    await appendFile(join(config.rowsDir, today() + ".jsonl"), text + "\n");
  } catch { process.stdout.write(text + "\n"); }
}

export async function rules(fresh = false, ms = 10000) {
  if (current && !fresh) return current;
  const r = await http("GET", "/v1/rules", undefined, false, ms);
  decide(r.text, "", "unknown");
  const isNew = !current || current.version !== r.version;
  current = r;
  if (isNew) await write({ rules: r });
  return r;
}

let loading = null;   // today's file being read: every caller waits for the same read

async function doneToday() {
  const d = today();
  if (done.day === d) return done.set;
  if (!loading || loading.day !== d) {
    loading = { day: d, p: (async () => {
      const set = new Set(), kids = new Set(), seals = new Map(), takenOff = new Set();
      if (!config.onRow) {
        try {
          for (const t of (await readFile(join(config.rowsDir, d + ".jsonl"), "utf8")).split("\n")) {
            try {
              const l = JSON.parse(t);
              if (l.key) kids.add(l.key.kid);
              if (l.joined && l.joined.seal) takenOff.add(l.joined.seal);   // told to STK as a person joining
              if (l.queued && l.queued.row) { const r = JSON.parse(l.queued.row); if ("conversation_id" in r) { set.add(r.conversation_id + "\u0000" + r.intent); seals.set(r.conversation_id + "\u0000" + r.intent, l.queued.seal); } }
              if (l.sig && !l.cancelled) { const r = JSON.parse(l.row); if ("conversation_id" in r) { set.add(r.conversation_id + "\u0000" + r.intent); seals.set(r.conversation_id + "\u0000" + r.intent, l.receipt.seal); } }
            } catch {}
          }
        } catch {}
      }
      for (const [x, v] of [...seals]) if (takenOff.has(v)) { seals.delete(x); set.delete(x); }
      if (done.day === null && !config.onRow) await reloadQueue();
      if (done.day !== d) { if (done.day !== null) done.yesterday = done.seals; done.day = d; done.set = set; done.kids = kids; done.seals = seals; done.told = new Set(); }   // set only once the file is read
    })() };
  }
  await loading.p;
  return done.set;
}

const asking = new Map();   // conversation and intent being asked now: one call to STK for them

const byCodePoint = (a, b) => {   // as Python sorts text: by code point, not by UTF-16 unit
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) { const d = x[i].codePointAt(0) - y[i].codePointAt(0); if (d) return d; }
  return x.length - y.length;
};

// The row as text, one way only, the same in stk.py and stk.mjs: keys sorted by code point, no spaces, Unicode as it
// is, numbers as JavaScript writes them, NaN and infinities as null. Its bytes are what is sealed.
export function rowText(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? JSON.stringify(v) : "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map((x) => (typeof x === "function" ? "null" : rowText(x))).join(",") + "]";
  if (typeof v === "object") {
    if (typeof v.toJSON === "function") return rowText(v.toJSON());
    const ks = Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== "function").sort(byCodePoint);
    return "{" + ks.map((k) => JSON.stringify(k) + ":" + rowText(v[k])).join(",") + "}";
  }
  throw new TypeError("a row holds text, numbers, true, false, null, lists and objects only");
}

export const sealOf = (nonce, rowText) => createHash("sha256").update(Buffer.concat([nonce, Buffer.from(rowText, "utf8")])).digest("hex");

export async function ask(intent, trigger, { conversationId, ...fields } = {}) {
  if (typeof intent === "string") intent = intent.trim().toLowerCase();   // " Order.Status " is order.status
  if (typeof trigger === "string") trigger = trigger.trim().toLowerCase();
  if (!current) {   // the first ask of this process reads the rules first (up to 2 seconds), outside STK's 300 ms
    try { await rules(false, 2000); } catch { return "escalate"; }
  }
  const state = { late: false, how: null, covered: () => false, settle: null, answer: null };
  const settled = new Promise((r) => (state.settle = r));
  const answered = new Promise((r) => (state.answer = r));   // the result, handed over before anything that may wait
  run(intent, trigger, conversationId, fields, state, settled).catch(() => {}).finally(() => state.answer("escalate"));
  const timer = new Promise((r) => setTimeout(() => r("late"), config.timeout));
  const first = await Promise.race([answered, timer]);
  if (state.how === null) state.how = first !== "late" ? "answer" : (state.covered() ? "grant" : "late");   // first to settle wins
  state.late = state.how === "late";
  state.settle();
  if (state.how === "grant") return "finish";
  return state.late ? "escalate" : first;
}

async function run(intent, trigger, conversationId, fields, state, settled) {
  let r = await rules();
  if (decide(r.text, intent, trigger) !== "finish") {
    state.answer("escalate");                                // STK is not called
    if (!listed(r.text, intent)) await write({ not_listed: { time_ms: Date.now(), intent } });   // for your own count; STK is not told
    return;
  }
  const cid = conversationId === undefined || conversationId === null ? null : String(conversationId);
  const k = cid === null ? null : cid + "\u0000" + intent;
  if (k !== null) {
    for (;;) {
      if ((await doneToday()).has(k)) return state.answer("finish");   // got finish today: not asked again, not billed again
      const other = asking.get(k);
      if (!other) break;
      await other;                                           // being asked now: its answer, not a second call
    }
    let release;
    asking.set(k, new Promise((r) => (release = r)));
    try { return await ask1(intent, trigger, cid, fields, state, settled, r); }
    finally { asking.delete(k); release(); }
  }
  return ask1(intent, trigger, cid, fields, state, settled, r);
}

async function ask1(intent, trigger, cid, fields, state, settled, r) {
  const row = { ...fields, intent, trigger };
  if (cid !== null) row.conversation_id = cid;
  const text = rowText(row);
  const nonce = randomBytes(32);
  const seal = sealOf(nonce, text);
  let recorded = nowMs();
  const g = grant;
  state.covered = () => grantOk(r.version);
  let a;
  try {
    try { a = await http("POST", "/v1/ask", { seal, recorded_ms: recorded }); }
    catch (e) {                                              // this machine's clock is more than a minute from STK's: STK's, then once again
      if (e.status !== 422 || !e.headers || !e.headers.get("x-stk-time-ms")) throw e;
      offset = Number(e.headers.get("x-stk-time-ms")) - Date.now(); recorded = nowMs();
      a = await http("POST", "/v1/ask", { seal, recorded_ms: recorded });
    }
  } catch (e) {
    const reached = e.status !== undefined && e.status < 500;
    if (state.how === null) state.how = !reached && g && g.g.rule_version === r.version && performance.now() < g.until && queue.size < config.queueMax ? "grant" : "error";
    if (state.how === "grant" && (g || grant)) {             // STK not reached, the grant holds: finish now, the seal waits in the queue
      await enqueue(cid, intent, text, nonce, seal, recorded, g || grant);
      return state.answer("finish");
    }
    try { await postJoined("no answer from STK", seal); } catch {} throw e;   // it may have been counted: taken off, never billed
  }
  keepGrant(a);
  if (!a.sig) {
    state.answer("escalate");                                // not signed: no permission, not billed
    await settled;
    if (state.how === "grant") await write({ not_signed: { seal, recorded_ms: recorded, why: a.not_signed || "STK did not sign it" } });   // ask() had returned finish under the grant
    return;
  }
  const line = { row: text, nonce: nonce.toString("hex"), receipt: a.receipt, sig: a.sig };
  let result = "finish";
  if (a.rule_version !== r.version && state.how !== "grant") {
    try {
      r = await rules(true);
      if (decide(r.text, intent, trigger) !== "finish") { result = "escalate"; line.cancelled = "the rules of " + a.rule_version.slice(0, 12) + " say escalate"; }
    } catch { result = "escalate"; line.cancelled = "the rules of " + a.rule_version.slice(0, 12) + " could not be read"; }   // taken off
  }
  const key = cid === null ? null : cid + "\u0000" + intent;
  const tell = async () => { try { await postJoined(line.cancelled, seal); } catch { line.cancelled += "; STK could not be told"; } };
  if (line.cancelled) await tell();
  try { await write(line); }                                 // kept before the answer: a process stopped right after it still has it
  catch (e) {                                                // not kept: never a permission you cannot prove; taken off, escalate
    if (!line.cancelled) { line.cancelled = "the line could not be kept"; await tell(); }
    throw e;
  }
  if (!line.cancelled && key !== null && done.day === today()) { done.set.add(key); done.seals.set(key, seal); }
  state.answer(result);
  await settled;                                             // ask() has returned, on time or not
  if (result === "finish" && state.late) {                   // too late: your code has handed it to a person
    if (key !== null) { done.set.delete(key); done.seals.delete(key); }
    try { await postJoined("the answer came after ask() returned", seal); }   // its joined line takes it off your count too
    catch { await write({ not_told: { time_ms: Date.now(), seal, why: "the answer came after ask() returned; STK could not be told, it stays billed" } }); }
  }
  await saveKey(line.receipt.kid);
}

async function enqueue(cid, intent, text, nonce, seal, recorded, g) {
  const q = { row: text, nonce: nonce.toString("hex"), seal, recorded_ms: recorded, grant: g.g, grant_sig: g.sig };
  await write({ queued: q });                                // kept before the answer, as every permission
  queue.set(seal, q);
  const key = cid === null ? null : cid + "\u0000" + intent;
  if (key !== null && done.day === today()) { done.set.add(key); done.seals.set(key, seal); }
  startSender();
}

function startSender() {
  if (sending || !queue.size) return;
  sending = true;
  sendQueue().finally(() => { sending = false; if (queue.size) setTimeout(startSender, config.queueRetry).unref?.(); });
}

// The queued seals, sent in the order recorded, as soon as STK answers. Each signed one becomes an ordinary line
// (from_queue: true), its receipt with both times. One STK refuses (its grant did not hold): a not_signed line.
async function sendQueue() {
  while (queue.size) {
    const [seal, q] = queue.entries().next().value;
    let a;
    try { a = await http("POST", "/v1/ask", { seal, recorded_ms: q.recorded_ms, grant: q.grant, grant_sig: q.grant_sig }); }
    catch (e) {
      if (e.status === undefined || e.status >= 500) return;   // not reached: tried again in queueRetry ms
      await write({ not_signed: { seal, recorded_ms: q.recorded_ms, why: "STK refused it: " + e.status } });
      queue.delete(seal); continue;
    }
    keepGrant(a);
    if (!a.sig) await write({ not_signed: { seal, recorded_ms: q.recorded_ms, why: a.not_signed || "STK did not sign it" } });
    else { await write({ row: q.row, nonce: q.nonce, receipt: a.receipt, sig: a.sig, from_queue: true }); await saveKey(a.receipt.kid); }
    queue.delete(seal);
  }
}

// Waits until the queue is empty or ms pass: true when empty. Call it before a process ends.
export async function flush(ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!queue.size) return true;
    if (!sending) startSender();
    await new Promise((r) => setTimeout(r, 50));
  }
  return !queue.size;
}

async function reloadQueue() {   // after a restart: queued lines of today and yesterday with no signed line yet go back in the queue
  const waiting = new Map(), gone = new Set();
  for (const d of [new Date(Date.now() - 86400000).toISOString().slice(0, 10), today()]) {
    try {
      for (const t of (await readFile(join(config.rowsDir, d + ".jsonl"), "utf8")).split("\n")) {
        try {
          const l = JSON.parse(t);
          if (l.queued && l.queued.seal) waiting.set(l.queued.seal, l.queued);
          else if (l.receipt) gone.add(l.receipt.seal);
          for (const k of ["not_signed", "dequeued", "joined"]) if (l[k] && l[k].seal) gone.add(l[k].seal);
        } catch {}
      }
    } catch {}
  }
  for (const [s, q] of waiting) if (!gone.has(s) && !queue.has(s)) queue.set(s, q);
  startSender();
}

async function saveKey(kid) {   // the receipt's public key, once a day: the lines can be checked with nothing of STK running
  await doneToday();
  if (done.kids.has(kid)) return;
  done.kids.add(kid);
  try { const r = await http("GET", "/v1/rules?keys=1&kid=" + encodeURIComponent(kid), undefined, false); if (r.keys.length) await write({ key: r.keys[0] }); }
  catch { done.kids.delete(kid); }
}

export async function joined(conversationId) {
  // told once for each finish this file knows the conversation got today (with its seal), or once without one
  let seals = [null];
  const cid = conversationId === undefined || conversationId === null ? null : String(conversationId);
  if (cid !== null) {
    const p = cid + "\u0000";
    const set = await doneToday();
    const gone = [...set].filter((x) => x.startsWith(p)).sort();
    let found = gone.map((x) => done.seals.get(x) ?? null);
    if (!gone.length && (Date.now() / 1000) % 86400 < GRACE) found = [...done.yesterday].filter(([x]) => x.startsWith(p)).sort().map(([, s]) => s);
    if (!found.length && done.told.has(cid)) return true;   // told already today, and no finish of it since: not told again
    if (found.length) seals = found;
  }
  for (const s of seals) {
    if (s !== null && queue.has(s)) {                        // still in the queue: never sent, never billed
      queue.delete(s);
      await write({ dequeued: { time_ms: Date.now(), seal: s, why: "joined(" + (conversationId ?? "") + ") before STK signed it" } });
    } else await postJoined("joined(" + (conversationId ?? "") + ")", s);   // throws if STK cannot be told: call it again
    for (const book of [done.seals, done.yesterday]) for (const [x, v] of [...book]) if (s !== null && v === s) { book.delete(x); done.set.delete(x); }
    if (s === null && cid !== null) for (const x of [...done.set]) if (x.startsWith(cid + "\u0000")) done.set.delete(x);
  }
  if (cid !== null) done.told.add(cid);
  return true;
}

async function postJoined(why, seal = null) {   // POST /v1/joined (with the seal: it counts for that permission's day), and a line for it
  const a = await http("POST", "/v1/joined", seal ? { seal } : {});
  await write({ joined: { time_ms: Date.now(), day: a.day ?? null, seal, why } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length < 3) { console.error("node stk.mjs <intent> [trigger]   (decides from STK's public rules; sends nothing)"); process.exit(1); }
  const r = await rules();
  console.log(decide(r.text, process.argv[2], process.argv[3] || "unknown"), "(rules " + r.version.slice(0, 12) + ")");
}
