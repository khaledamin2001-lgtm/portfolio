#!/usr/bin/env python3
"""Build the two desk pages from app.html + engine.js + engine2.js + statement.js + app2.js (placeholders /*ENGINE*/
/*ENGINE2*/ /*STATEMENT*/ /*APP2*/). Run `python3 build.py` from any directory: inputs are read next to this file.
Writes portfolio-desk.html (Khaled) and yassin-desk.html (same page, Yassin's <title>) with a build stamp
<meta name="pd-build" content="<12 hex of sha256 over the five inputs> <UTC YYYY-MM-DD HH:MM>"> right after the title."""
import os, hashlib, datetime
H = os.path.dirname(os.path.abspath(__file__))
rd = lambda f: open(os.path.join(H, f), encoding="utf-8").read()
inputs = ["app.html", "engine.js", "engine2.js", "statement.js", "app2.js"]
src = {f: rd(f) for f in inputs}
stamp = hashlib.sha256("".join(src[f] for f in inputs).encode("utf-8")).hexdigest()[:12] + " " + datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M")
page = src["app.html"]
for ph, f in [("/*ENGINE*/", "engine.js"), ("/*ENGINE2*/", "engine2.js"), ("/*STATEMENT*/", "statement.js"), ("/*APP2*/", "app2.js")]:
    assert page.count(ph) == 1, f"placeholder {ph} not found exactly once in app.html"
    page = page.replace(ph, src[f])
title = "<title>Khaled Portfolio Desk</title>"
assert page.count(title) == 1, "app.html must start with the Khaled <title> line"
page = page.replace(title, title + '\n<meta name="pd-build" content="' + stamp + '">', 1)
for out, t in [("portfolio-desk.html", title), ("yassin-desk.html", "<title>Yassin Portfolio Desk</title>")]:
    s = page.replace(title, t, 1)
    open(os.path.join(H, out), "w", encoding="utf-8").write(s)
    print(f"{out} {len(s)} bytes")
print("pd-build", stamp)
