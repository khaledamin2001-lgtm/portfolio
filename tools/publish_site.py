#!/usr/bin/env python3
"""Publish fresh portfolio data to the live site in one deterministic step.
Usage: python3 publish_site.py [--khaled <export dir>] [--yassin <export dir>] [--exports] [--message "..."] [--no-push]
For each portfolio given, encrypts its ArtifactData export with tools/export.py into p/<id>/data.enc.json, then commits
exactly those files (plus p/*/exports/ when --exports is passed) and pushes to origin main, retrying the push on network
errors (waits 2, 4, 8, 16 s). Nothing else is ever added to git. Exit code 0 and a final {"ok": true, ...} line mean the
push landed and origin/main equals HEAD; any other outcome exits 1 with {"ok": false, "error": ...}.
The plain .xlsx workbooks under exports/ are never committed (only *.enc.json and index.json)."""
import sys, os, json, subprocess, time, argparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORT = os.path.join(ROOT, "tools", "export.py")

def sh(*cmd, check=True):
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)}: {r.stderr.strip() or r.stdout.strip()}")
    return r.stdout.strip()

def fail(msg):
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(1)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--khaled"); ap.add_argument("--yassin")
    ap.add_argument("--exports", action="store_true", help="also commit p/*/exports/*.enc.json and index.json")
    ap.add_argument("--message", default=None)
    ap.add_argument("--no-push", action="store_true")
    a = ap.parse_args()
    ports = [(pid, d) for pid, d in (("khaled", a.khaled), ("yassin", a.yassin)) if d]
    if not ports: fail("give --khaled and/or --yassin export directories")
    try:
        sh("git", "fetch", "-q", "origin", "main")
        sh("git", "pull", "-q", "--ff-only", "origin", "main")
    except RuntimeError as e:
        fail(f"could not update the clone: {e}")
    done, errors = {}, {}
    for pid, d in ports:
        keys = os.path.join(ROOT, "p", pid, "keys.json"); out = os.path.join(ROOT, "p", pid, "data.enc.json")
        if not os.path.isdir(d): errors[pid] = f"export dir missing: {d}"; continue
        r = subprocess.run([sys.executable, EXPORT, d, keys, out], capture_output=True, text=True)
        if r.returncode != 0 or '"ok": true' not in r.stdout: errors[pid] = (r.stderr or r.stdout).strip()[-400:]; continue
        done[pid] = json.loads(r.stdout.strip().splitlines()[-1])
    if not done: fail(f"no portfolio exported: {errors}")
    paths = [f"p/{pid}/data.enc.json" for pid in done]
    if a.exports:
        for pid in done:
            ed = os.path.join(ROOT, "p", pid, "exports")
            if os.path.isdir(ed):
                paths += [f"p/{pid}/exports/{f}" for f in sorted(os.listdir(ed)) if f.endswith(".enc.json") or f == "index.json"]
    sh("git", "add", "--", *paths)
    staged = sh("git", "diff", "--cached", "--name-only")
    if not staged:
        print(json.dumps({"ok": True, "committed": False, "pushed": False, "exported": done, "errors": errors, "head": sh("git", "rev-parse", "--short", "HEAD")}))
        return
    msg = a.message or f"Data update {time.strftime('%Y-%m-%d %H:%M')} UTC"
    sh("git", "commit", "-q", "-m", msg, "--only", "--", *paths)
    head = sh("git", "rev-parse", "HEAD")
    if a.no_push:
        print(json.dumps({"ok": True, "committed": True, "pushed": False, "exported": done, "errors": errors, "head": head[:7], "files": staged.split("\n")}))
        return
    last = None
    for i, wait in enumerate((0, 2, 4, 8, 16)):
        if wait: time.sleep(wait)
        r = subprocess.run(["git", "push", "-q", "origin", "HEAD:main"], cwd=ROOT, capture_output=True, text=True)
        if r.returncode == 0: last = None; break
        last = r.stderr.strip()[-300:]
        if "rejected" in last or "non-fast-forward" in last:
            # someone else pushed meanwhile: bring their commit in and try again
            subprocess.run(["git", "pull", "-q", "--rebase", "origin", "main"], cwd=ROOT, capture_output=True, text=True)
            head = sh("git", "rev-parse", "HEAD")
    if last is not None: fail(f"push failed after retries: {last}")
    sh("git", "fetch", "-q", "origin", "main")
    remote = sh("git", "rev-parse", "origin/main")
    if remote != head: fail(f"push did not land: origin/main {remote[:7]} != HEAD {head[:7]}")
    print(json.dumps({"ok": True, "committed": True, "pushed": True, "exported": done, "errors": errors, "head": head[:7], "files": staged.split("\n")}))

if __name__ == "__main__":
    try: main()
    except RuntimeError as e: fail(str(e))
