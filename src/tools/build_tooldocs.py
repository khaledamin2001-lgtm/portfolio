#!/usr/bin/env python3
"""Build the tools/<id> documents that each portfolio page keeps in its database so the scheduled jobs can fetch their
code. Usage: python3 tools/build_tooldocs.py [--live <dir with tools/<id>.json as ArtifactData saves them>] [--out <dir>]
Writes <out>/<id>.json = {filename, content, sha256, builtAt} for engine_js, engine2_js, statement, sync, excel_js,
excel_py, factsheet, plan, weekly (sources: the .js/.py files next to this script, or one directory up for engine.js, engine2.js and
statement.js when tools/ holds no copy), prints a manifest table and, with --live, marks which live documents differ.
Exit code 0 always; the manifest is for the owner to read before saving the documents with ArtifactData "set"."""
import os, sys, json, hashlib, datetime, argparse

IDS = [("engine_js", "engine.js"), ("engine2_js", "engine2.js"), ("statement", "statement.js"), ("sync", "sync.js"),
       ("excel_js", "excel.js"), ("excel_py", "excel.py"), ("factsheet", "factsheet.js"), ("plan", "plan.js"),
       ("weekly", "weekly.js")]
HERE = os.path.dirname(os.path.abspath(__file__))

def source(filename):
    here, up = os.path.join(HERE, filename), os.path.join(os.path.dirname(HERE), filename)
    if os.path.isfile(here) and os.path.isfile(up) and open(here, "rb").read() != open(up, "rb").read():
        print(f"WARNING: tools/{filename} differs from ../{filename} - the tools/ copy is what gets published; re-copy it", file=sys.stderr)
    for p in (here, up):
        if os.path.isfile(p): return p
    raise FileNotFoundError(f"{filename} not found in {HERE} or its parent")

def unwrap(doc):  # ArtifactData sometimes saves {id, version, data: {...}}
    return doc["data"] if "content" not in doc and isinstance(doc.get("data"), dict) else doc

def sha(s): return hashlib.sha256(s.encode("utf-8")).hexdigest()

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--live", metavar="DIR", help="directory holding tools/<id>.json as saved by ArtifactData (compare content)")
    ap.add_argument("--out", metavar="DIR", default="tooldocs", help="where to write <id>.json (default ./tooldocs)")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    built = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    rows, differ = [], []
    for id_, fn in IDS:
        p = source(fn); content = open(p, encoding="utf-8").read()
        doc = {"filename": fn, "content": content, "sha256": sha(content), "builtAt": built}
        json.dump(doc, open(os.path.join(a.out, id_ + ".json"), "w", encoding="utf-8"), ensure_ascii=False)
        status = ""
        if a.live:
            lp = os.path.join(a.live, "tools", id_ + ".json")
            if not os.path.isfile(lp): status = "live: missing"
            else:
                live = unwrap(json.load(open(lp, encoding="utf-8")))
                same = live.get("content") == content
                status = "live: same" if same else f"live: DIFFERS ({len(live.get('content') or '')} bytes, {sha(live.get('content') or '')[:12]})"
                if not same: differ.append(id_)
        rows.append((id_, fn, doc["sha256"][:12], len(content.encode("utf-8")), status))
    w = max(len(r[0]) for r in rows)
    print(f"{'id':<{w}}  {'filename':<13} {'sha256':<12} {'bytes':>7}  {'live' if a.live else ''}")
    for r in rows: print(f"{r[0]:<{w}}  {r[1]:<13} {r[2]:<12} {r[3]:>7}  {r[4]}")
    print(f"wrote {len(rows)} documents to {a.out} (builtAt {built})" + (f"; differ from live: {', '.join(differ) or 'none'}" if a.live else ""))

if __name__ == "__main__":
    main()
