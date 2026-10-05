#!/usr/bin/env python3
"""Writing to the public site repository from a job: run_shared_market.py (m/market.enc.json) and run_account_mail.py
(a/<hash>/exports/: each account's month-end files) clone the site's main branch over HTTPS with SITE_TOKEN, sent as an
HTTP header (never in a URL or a log), change only their own files, check each is an encrypted envelope, commit and
push (their own retry loops re-clone when someone pushed meanwhile)."""
import os, re, json, time, base64, shutil, subprocess

import jobs_common as jc

ENC_KEYS = {"v", "at", "name", "bytes", "epk", "iv", "ct"}
B64 = re.compile(r"^[A-Za-z0-9+/_-]+=*$")


def is_envelope(path):
    """True when the file is one of our encrypted envelopes (store.py seal / site/lock.js seal) and nothing else."""
    try:
        with open(path, encoding="utf-8") as f:
            e = json.load(f)
    except Exception:
        return False
    return (isinstance(e, dict) and {"v", "epk", "iv", "ct"} <= set(e) and set(e) <= ENC_KEYS
            and all(isinstance(e[k], str) and B64.match(e[k]) for k in ("epk", "iv", "ct")) and len(e["ct"]) >= 16)


def _auth_env():
    tok = os.environ.get("SITE_TOKEN", "").strip()
    if not tok:
        return {}
    hdr = "AUTHORIZATION: basic " + base64.b64encode(f"x-access-token:{tok}".encode()).decode()
    # GIT_CONFIG_* passes the header to git without it appearing on a command line or in .git/config
    return {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader", "GIT_CONFIG_VALUE_0": hdr}


def clone(remote, dest):
    """A shallow clone of the site's main branch at dest. Returns the env (the auth header) to push with."""
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    env = _auth_env() if remote.startswith("https://github.com/") else {}
    if remote.startswith("https://github.com/") and not env:
        raise jc.JobError("publish", "SITE_TOKEN is not set")
    last = ""
    for wait in (0, 2, 4, 8):
        if wait:
            time.sleep(wait)
        r = subprocess.run(["git", "clone", "-q", "--depth", "30", "--branch", "main", remote, dest], capture_output=True,
                           text=True, env=dict(os.environ, GIT_TERMINAL_PROMPT="0", **env))
        if r.returncode == 0:
            return env
        last = r.stderr.strip()
        shutil.rmtree(dest, ignore_errors=True)
    raise jc.JobError("publish", "could not clone the site repository: " + jc.redact(last)[-300:])
