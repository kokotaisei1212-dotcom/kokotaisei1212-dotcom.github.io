"""Is this row STK's? python3 stk_verify.py <file.jsonl> [keys.json]

Each line of the file: {"row": {...}, "sig": "..."} as stk.py keeps it. The public keys come from
https://api.stk-evidence.com/v1/rules?keys=1 (or from keys.json, a copy of it). A row is STK's when the public key of its
kid, not made invalid, checks its signature over the bytes: the row's fields in this order, as JSON with no spaces:
v, ask_id, time_ms, account, conversation_id, intent, trigger, rule_version, decision, clause, which_key, human_joined,
kid. No secret is needed, and no order of the rows: each one is checked alone.
Needs: pip install cryptography"""
import base64, json, sys, urllib.request

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

ROW = ("v", "ask_id", "time_ms", "account", "conversation_id", "intent", "trigger", "rule_version", "decision", "clause",
       "which_key", "human_joined", "kid")


def check(line, keys):
    row, sig = line["row"], line["sig"]
    k = keys.get(row.get("kid"))
    if not k:
        return "not STK's key"
    if k.get("invalid"):
        return "its key was made invalid on " + k["invalid"]
    body = json.dumps([row[f] for f in ROW], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    try:
        Ed25519PublicKey.from_public_bytes(base64.b64decode(k["public_key"])).verify(base64.b64decode(sig), body)
        return "STK's"
    except Exception:
        return "NOT STK's: the row or its signature was changed"


if __name__ == "__main__":
    src = sys.argv[2] if len(sys.argv) > 2 else None
    data = json.load(open(src)) if src else json.load(urllib.request.urlopen("https://api.stk-evidence.com/v1/rules?keys=1", timeout=20))
    keys = {k["kid"]: k for k in data["keys"]}
    bad = 0
    for n, text in enumerate(open(sys.argv[1], encoding="utf-8"), 1):
        if text.strip():
            r = check(json.loads(text), keys)
            bad += r != "STK's"
            print(n, r)
    sys.exit(1 if bad else 0)
