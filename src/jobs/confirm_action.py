#!/usr/bin/env python3
"""Confirm (or dismiss) a corporate action in the shared market data, by hand: the engine workflow "Confirm corporate
action" (confirm-action.yml) runs it with what the owner typed in the GitHub app.

    python3 confirm_action.py --engine DIR --symbol ORHD --date 2026-10-07 --kind bonus [--ratio 3.2288508184] [--no-push]

The action is the bench.json actions entry for that stock within 7 days of --date (the market job adds one as kind
'detected', run_shared_market.detect_actions); without one, a new entry is made.
  --kind bonus | split   the free shares are booked: the next email run gives every account holding the stock a Bonus
                         row of floor(shares × (ratio − 1)) on --date (sync.js applyCorporateActions). --ratio = shares
                         after ÷ shares before (1-for-2 bonus: 1.5; 2-for-1 split: 2); left out, the detected one is used.
  --kind rights          new shares are bought, not given: nothing is booked; the Checks warning goes away.
  --kind ignore          not a corporate action (a data error, a real fall): the detected entry is removed.
Commits shared/bench.json to the engine repository and pushes it. Prints one line; exit 1 on a bad input."""
import os, sys, json, argparse, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import jobs_common as jc  # noqa: E402
import run_shared_market as rsm  # noqa: E402

KINDS = ("bonus", "split", "rights", "ignore")


def label(kind, ratio):
    if kind == "bonus":
        return f"{ratio - 1:.6g}-for-1 bonus"
    if kind == "split":
        return f"{ratio:.6g}-for-1 split"
    return f"rights issue (price factor {ratio:.6g})" if ratio else "rights issue"


def confirm(bench, symbol, date, kind, ratio=None, today=None):
    """Applies the decision to the bench dict in place. Returns a one-line summary; raises ValueError on a bad input."""
    symbol = (symbol or "").strip().upper()
    if not symbol.isalnum() or len(symbol) > 8:
        raise ValueError(f"symbol {symbol!r}: type the EGX code, e.g. ORHD")
    try:
        day = datetime.date.fromisoformat((date or "").strip())
    except ValueError:
        raise ValueError(f"date {date!r}: type it as YYYY-MM-DD (the ex-day, the first session at the lower price)") from None
    if kind not in KINDS:
        raise ValueError(f"kind {kind!r}: one of {', '.join(KINDS)}")
    acts = bench.setdefault("actions", [])
    near = [a for a in acts if a.get("s") == symbol and abs((datetime.date.fromisoformat(a.get("date", "1970-01-01")) - day).days) <= 7]
    had = next((a for a in near if a.get("kind") == "detected"), near[0] if near else None)
    if kind == "ignore":
        if not had:
            raise ValueError(f"no {symbol} action within 7 days of {day} to remove")
        acts.remove(had)
        return f"{symbol} {had['date']}: removed (not a corporate action)"
    if ratio is None and had:
        ratio = had.get("ratio")
    if kind in ("bonus", "split") and not (isinstance(ratio, (int, float)) and 1 < ratio <= 50):
        raise ValueError(f"ratio {ratio!r}: shares after ÷ shares before, above 1 (a 1-for-2 bonus is 1.5)")
    entry = had if had is not None else {"s": symbol}
    if had is None:
        acts.append(entry)
    entry.update({"date": day.isoformat(), "kind": kind, "label": label(kind, ratio), "confirmedAt": today or jc.cairo_today()})
    if ratio is not None:
        entry["ratio"] = round(float(ratio), 10)
    acts.sort(key=lambda a: (a.get("date", ""), a.get("s", "")))
    return f"{symbol} {day}: {entry['label']}" + (" (was detected)" if had is not None and had is entry and "detectedAt" in entry else "")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--engine", required=True)
    ap.add_argument("--symbol", required=True)
    ap.add_argument("--date", required=True)
    ap.add_argument("--kind", required=True, choices=KINDS)
    ap.add_argument("--ratio", default="")
    ap.add_argument("--no-push", action="store_true")
    a = ap.parse_args(argv)
    try:
        ratio = float(a.ratio) if str(a.ratio).strip() else None
    except ValueError:
        print(f"ratio {a.ratio!r} is not a number")
        return 1
    eng = rsm.Engine(a.engine)
    path = os.path.join(eng.engine, "shared", "bench.json")
    for attempt in range(3):
        if not a.no_push:
            jc.engine_refresh(eng)
        bench = rsm.load(path, {})
        try:
            msg = confirm(bench, a.symbol, a.date, a.kind, ratio)
        except ValueError as e:
            print(f"not changed: {e}")
            return 1
        rsm.dump(path, bench)
        if a.no_push:
            break
        jc.git(eng.engine, "add", "--", "shared/bench.json")
        if not jc.git(eng.engine, "diff", "--cached", "--name-only").stdout.strip():
            msg += " (already so)"
            break
        jc.git(eng.engine, *jc.author_args("ENGINE_COMMIT_AUTHOR", jc.ENGINE_AUTHOR), "commit", "-q", "-m", f"Corporate action: {msg}")
        if not jc.has_origin(eng.engine) or jc.git(eng.engine, "push", "-q", "origin", "HEAD:main", check=False).returncode == 0:
            break
        if attempt == 2:
            print("not saved: the push to the engine repository kept failing")
            return 1
    print(msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
