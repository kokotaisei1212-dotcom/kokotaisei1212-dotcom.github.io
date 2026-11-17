"""The site's copy of STK's public keys (keys.json), append-only: a key once in it stays, with the same public
key; a key made invalid gets its note added. The record is in Stripe, read through /v1/rules?keys=1; this copy is the
second place, so a key deleted or changed there still checks (the engine puts it back from here when it starts).
python3 scripts/keys_copy.py   -> prints "changed" or "same"; exit 0. An API that does not answer changes nothing."""
import json, pathlib, sys, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEST = ROOT / "keys.json"
API = "https://api.stk-evidence.com/v1/rules?keys=1"


def merge(old: list[dict], new: list[dict]) -> list[dict]:
    by = {k["kid"]: dict(k) for k in old}
    for k in new:
        o = by.get(k["kid"])
        if o is None:
            by[k["kid"]] = dict(k)
        elif k.get("invalid") and not o.get("invalid"):        # only this may change: a key made invalid
            o["invalid"], o["invalid_note"] = k["invalid"], k.get("invalid_note")
    return sorted(by.values(), key=lambda k: (k.get("day") or "", k["kid"]))


def update(fetch=None) -> bool:
    old = json.loads(DEST.read_text())["keys"] if DEST.exists() else []
    try:
        new = (fetch or (lambda: json.load(urllib.request.urlopen(urllib.request.Request(API, headers={"User-Agent": "stk-site"}), timeout=20))))()["keys"]
    except Exception as e:
        print("API not read:", type(e).__name__, file=sys.stderr)
        return False
    got = merge(old, new)
    if got == old:
        return False
    DEST.write_text(json.dumps({"keys": got}, indent=1) + "\n")
    return True


if __name__ == "__main__":
    print("changed" if update() else "same")
