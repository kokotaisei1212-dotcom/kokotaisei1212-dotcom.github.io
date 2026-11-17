"""STK: ask before your AI hands a conversation to a person. One call. https://stk-evidence.com/docs

    from stk import ask
    if ask(conversation_id, intent, trigger) == "finish":
        ...  # your AI goes on with the conversation
    else:
        ...  # hand it to a person, as your code does today

trigger: why your code is about to hand it over.
  unknown         your AI is not sure enough (the only one STK can answer finish)
  customer_asked  the customer asked for a person
  angry           the customer is angry
  out_of_scope    the request is outside what your AI may do
  authority       it needs a person's authority

Every answer comes with its row and STK's signature of it. STK keeps no row: this file keeps each one for you, as one
JSON line, in ROWS_DIR/<day>.jsonl (by default ./stk-rows); or give ON_ROW a function and it gets each one instead (a
place with no files you keep, like a serverless function: put them in your own store). If the folder cannot be
written, each line goes to standard output. Lose them and STK cannot give them back. Check one: stk_verify.py.

A conversation that got finish once today (UTC) gets finish again without asking STK: each ask STK answers finish is
billed, so this file does not ask twice. After a restart it reads today's file again; with ON_ROW it remembers only
while the process runs. Many servers each remember their own: the same conversation asked on two of them is two.

When a person joins a conversation after STK said finish, call ask(..., human_joined=True) for it: that conversation
is not billed, while its month is not closed (after the close STK refuses it with 409). STK never receives the words of
a conversation; this file sends nothing else than what is below.
Without an answer within 300 ms, or on any error, ask() returns "escalate": your code does what it was about to do.
The answer is still waited for in the background (10 s): when it comes, its row is kept, and if it said finish, STK is
told that a person has the conversation (human_joined), so it is not billed. Python 3.8 or later, nothing to install."""
import json, os, sys, threading, time, urllib.error, urllib.request

KEY = "stk_test_..."   # your test key from the email STK sent you; the live key in its place when you go live
URL = "https://api.stk-evidence.com/v1/ask"
TIMEOUT = 0.3
ROWS_DIR = os.environ.get("STK_ROWS_DIR", "stk-rows")
ON_ROW = None          # or a function(line: dict): each row and its signature, for your own store
_lock = threading.Lock()
_finished = {"day": None, "ids": set()}   # today's conversations STK answered finish


def _today():
    return time.strftime("%Y-%m-%d", time.gmtime())


def _remember(row):
    if row.get("decision") == "finish" and not row.get("human_joined"):
        d = time.strftime("%Y-%m-%d", time.gmtime(row["time_ms"] / 1000))
        with _lock:
            if d == _finished["day"]:
                _finished["ids"].add(row["conversation_id"])


def _finished_today():
    d = _today()
    with _lock:
        if _finished["day"] != d:                # a new day, or the first ask since this process started
            _finished["day"], _finished["ids"] = d, set()
            if ON_ROW is None:
                try:
                    with open(os.path.join(ROWS_DIR, d + ".jsonl"), encoding="utf-8") as f:
                        for text in f:
                            try:
                                r = json.loads(text)["row"]
                            except Exception:
                                continue
                            if r.get("decision") == "finish" and not r.get("human_joined"):
                                _finished["ids"].add(r["conversation_id"])
                except OSError:
                    pass
        return _finished["ids"]


def _keep(answer):
    if not answer.get("row"):
        return
    _remember(answer["row"])
    line = {"row": answer["row"], "sig": answer["sig"]}
    if ON_ROW is not None:
        ON_ROW(line)
        return
    text = json.dumps(line, ensure_ascii=False, separators=(",", ":"))
    try:
        os.makedirs(ROWS_DIR, exist_ok=True)
        day = time.strftime("%Y-%m-%d", time.gmtime(answer["row"]["time_ms"] / 1000))
        with _lock, open(os.path.join(ROWS_DIR, day + ".jsonl"), "a", encoding="utf-8") as f:
            f.write(text + "\n")
    except OSError:
        print(text, file=sys.stdout, flush=True)


def _post(body, timeout):
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "X-STK-Key": KEY})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def ask(conversation_id, intent, trigger, human_joined=False):
    if not human_joined and str(conversation_id) in _finished_today():
        return "finish"           # STK said finish to it today: not asked again, not billed again
    body = {"conversation_id": str(conversation_id), "intent": intent, "trigger": trigger}
    if human_joined:
        body["human_joined"] = True
    got, done, decided, late = {}, threading.Event(), threading.Event(), [False]

    def call():
        try:
            got["a"] = _post(body, 10)
        except Exception:
            got["e"] = True       # an error, or no answer: nothing was permitted
        done.set()
        a = got.get("a")
        if not a:
            return
        try:
            _keep(a)
        except Exception:
            pass
        decided.wait()            # what ask() returned is settled before this looks at it
        if late[0] and a.get("decision") == "finish" and not human_joined:
            try:                  # your code did not wait: a person has it, so STK is told
                _keep(_post(dict(body, human_joined=True), 10))
            except Exception:
                pass

    threading.Thread(target=call, daemon=True).start()
    on_time = done.wait(TIMEOUT)
    late[0] = not on_time
    decided.set()
    if not on_time:
        return "escalate"
    return (got.get("a") or {}).get("decision", "escalate")
