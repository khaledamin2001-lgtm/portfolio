#!/usr/bin/env python3
"""Encrypted document store for a portfolio ENGINE repository (one private repo per portfolio).

The engine repo mirrors the old Claude page database 1:1, one encrypted file per document:

    config.json                      plain: {portfolioId, name, siteRepo, siteFolder, timezone}
    db/<collection>/<doc>.enc.json   one "portfolio-file-v1" envelope per document

======================================================================================================================
API CONTRACT (Tracks B and C code to this; keep it stable)
======================================================================================================================
Envelope (the bytes on disk), exactly what tools/encrypt_file.py writes, as one line of compact JSON plus "\\n":
    {"v":1,"name":"<doc>.json","bytes":<plaintext length>,"epk":b64,"iv":b64,"ct":b64}
    epk = ephemeral P-256 public key, X9.62 uncompressed (65 bytes); shared = ECDH(eph, site pub from keys.json "pub");
    key = HKDF-SHA256(ikm=shared, salt=epk, info="portfolio-file-v1", 32 bytes); ct = AES-256-GCM(key, iv 12 bytes,
    aad="portfolio-file-v1") of the plaintext. (Same as lock.js unseal(e, 'portfolio-file-v1').)
Plaintext: UTF-8 JSON {"version": <int >= 1>, "updatedAt": "<ISO-8601 UTC, e.g. 2026-09-29T10:00:00Z>", "data": {...}}.
    Python writes it with ensure_ascii=False, separators=(",", ":"); readers must only rely on JSON.parse, never bytes.
Private key: keys.json "wrap" unwrapped with the setup key (dashes removed, uppercased) via PBKDF2-SHA256(wrap.iter,
    wrap.salt) -> AES-256-GCM(wrap.iv, aad "portfolio-key-v1") -> PKCS8 DER. unlock() also checks it matches keys.pub.

Names: collection and doc id must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ (e.g. portfolio/settings, ledger/y2026,
    history/2026-09). Anything else raises StoreError (no path tricks).

Python API (every `secret` argument is a setup-key string OR a private key returned by unlock(); unlock once and pass
the key around to avoid repeating the 600k-iteration PBKDF2; `keys_json` is a path to keys.json or the parsed dict):
    unlock(keys_json, setup_key)                          -> private key (raises StoreError on a wrong key)
    deep_merge(base, patch)                               -> new object; inputs untouched (see "update" below)
    read_doc(engine_dir, keys_json, secret, coll, doc)    -> {"version", "updatedAt", "data"} or None when absent
    read_all(engine_dir, keys_json, secret)               -> {"<coll>/<doc>": {"version", "updatedAt", "data"}}
    list_docs(engine_dir)                                 -> sorted [(coll, doc)]
    materialize(engine_dir, keys_json, secret, out_dir, clean=False)
        writes out_dir/<coll>/<doc>.json = {"id": doc, "version": N, "updatedAt": "...", "data": {...}} (0600 files,
        0700 dirs) so sync.js / weekly.js / excel.js / factsheet.js / export.py run unchanged on out_dir (they all read
        `d.data || d`). out_dir must be empty or absent unless clean=True (then only its <coll>/*.json files are removed
        first). Returns {"docs": n, "collections": {coll: n}}.
    apply_writes(engine_dir, keys_json, writes, secret, now=None, dry_run=False)
        writes = [{"op": "set"|"update"|"delete", "collection": c, "doc_id": d, "data": {...}, "if_version": N?}, ...]
        ("doc" or "id" are accepted for doc_id). Applied IN ORDER, all-or-nothing: every write is checked and computed
        in memory first; if any raises (bad op/name, VersionConflict) nothing is written.
          set     data replaces the document ({"__delete__": true} markers inside it are dropped).
          update  deep merge into the current data: objects merge recursively, arrays and scalars (incl. null) replace,
                  a value that is an object with "__delete__": true removes that key (a no-op if absent). Updating a
                  missing doc creates it from {}.
          delete  removes the file (status "absent" if it was not there).
          if_version  optional; the doc's current version must equal it (0 = "must not exist"), else VersionConflict.
                  Within one batch a second write to the same doc sees the version the first one produced.
        A write that changes the data bumps version by 1 (a new doc gets 1) and stamps updatedAt=now. A write whose
        result equals the current data (canonical JSON, so 1 vs 1.0 vs true differ) is "unchanged": no version bump,
        file untouched. Only changed docs are re-encrypted; every other file keeps its exact bytes (minimal git diff).
        Returns {"ok": True, "changed": [repo-relative paths written or removed], "results": [{"collection", "doc_id",
        "op", "status": created|updated|deleted|unchanged|absent, "version"}]}  -- no document data in it.
    migrate(export_dir, engine_dir, keys_json, config=None, overwrite=False, now=None, skip=("tools",))
        ArtifactData export (<coll>/<doc>.json, raw data or {..., "data": {...}, "version"?}) -> db/ files. Version is
        the export's own "version" when the file is wrapped and has one, else 1. Only the PUBLIC key is used. Refuses a
        non-empty db/ unless overwrite=True. config (dict) is written to config.json when given.
    verify(engine_dir, keys_json, secret, against=None)
        decrypts every doc and checks envelope + plaintext shape; with against=<export dir> also checks the same doc set
        and identical data doc-by-doc. Returns {"ok", "docs", "problems": [...]} (problems name docs, never values).
Exceptions: StoreError (bad input/format/key), VersionConflict(StoreError) with .collection .doc_id .expected .actual.
Lower-level helpers (stable too): load_keys, encode_doc(keys, doc_id, version, data, updated_at) -> envelope bytes,
    decode_doc(priv, raw) -> {"version", "updatedAt", "data"}, seal/unseal, strip_markers, doc_relpath, doc_path, read_export,
    config_for(export_dir, ...) -> config.json dict.

Write semantics are pinned by src/jobs/merge_vectors.json (merge / set / batch vectors). The site editor's JavaScript
copy must pass the same file; compare with order-insensitive deep equality (JS reorders integer-like keys) and do not
rely on 1 vs 1.0 (JSON numbers are doubles in JS; Python's canonical form would call that a change, which only costs a
harmless version bump). Envelopes are written as compact JSON + "\\n" (encrypt_file.py writes json.dump's spaced form
without a newline; same fields, same crypto -- every reader parses JSON, so both are valid store files). A browser
writer should produce the same six fields with name "<doc>.json" and bytes = UTF-8 plaintext length.

CLI (setup key from env SETUP_KEY, or --setup-key-file; keys.json from --keys, or env KEYS_JSON, or
<--site DIR>/<config.siteFolder>/keys.json). Output is ONE JSON line of counts/statuses, never data or secrets.
    python3 store.py materialize --engine DIR --out DIR [--clean]
    python3 store.py apply       --engine DIR --writes FILE|-  [--dry-run]     (FILE = JSON list or {"writes": [...]})
    python3 store.py verify      --engine DIR [--against EXPORT_DIR]
    python3 store.py migrate     --export DIR --engine DIR [--portfolio-id ID] [--name NAME] [--site-repo R]
                                 [--site-folder F] [--timezone TZ] [--no-config] [--overwrite]
Exit codes: 0 ok, 1 error, 3 version conflict (apply), 2 verify found problems.
Needs: python 3.9+, cryptography.
"""
import os, re, sys, json, base64, datetime, argparse, tempfile, shutil

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

LABEL = b"portfolio-file-v1"
WRAP_AAD = b"portfolio-key-v1"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
SUFFIX = ".enc.json"
ENVELOPE_KEYS = {"v", "name", "bytes", "epk", "iv", "ct"}
DEFAULT_SITE_REPO = "khaledamin2001-lgtm/portfolio"
DEFAULT_TZ = "Africa/Cairo"


class StoreError(Exception):
    pass


class VersionConflict(StoreError):
    def __init__(self, collection, doc_id, expected, actual):
        super().__init__(f"version conflict on {collection}/{doc_id}: expected {expected}, found {actual}")
        self.collection, self.doc_id, self.expected, self.actual = collection, doc_id, expected, actual


b64e = lambda b: base64.b64encode(b).decode()
b64d = base64.b64decode


def _now_iso():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _check_name(kind, s):
    if not isinstance(s, str) or not NAME_RE.match(s):
        raise StoreError(f"invalid {kind} name {s!r}" if isinstance(s, str) and len(s) < 80 else f"invalid {kind} name")
    return s


def _canon(x):
    return json.dumps(x, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


# ---------------------------------------------------------------- keys
def load_keys(keys_json):
    if isinstance(keys_json, dict):
        k = keys_json
    else:
        with open(keys_json) as f:
            k = json.load(f)
    if not isinstance(k, dict) or not isinstance(k.get("pub"), str):
        raise StoreError("keys.json has no public key")
    return k


def _pub(keys):
    return ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), b64d(keys["pub"]))


_UNLOCKED = {}


def unlock(keys_json, setup_key):
    """Setup key -> site private key (checked against keys.pub). Cached per (pub, setup key) for the process."""
    keys = load_keys(keys_json)
    if isinstance(setup_key, ec.EllipticCurvePrivateKey):
        return setup_key
    if not isinstance(setup_key, str) or not setup_key.strip():
        raise StoreError("setup key missing")
    norm = setup_key.strip().replace("-", "").upper()
    ck = (keys["pub"], norm)
    if ck in _UNLOCKED:
        return _UNLOCKED[ck]
    w = keys.get("wrap") or {}
    try:
        kek = PBKDF2HMAC(hashes.SHA256(), 32, b64d(w["salt"]), int(w["iter"])).derive(norm.encode())
        pk8 = AESGCM(kek).decrypt(b64d(w["iv"]), b64d(w["ct"]), WRAP_AAD)
        priv = serialization.load_der_private_key(pk8, None)
    except Exception:
        raise StoreError("setup key does not unlock this keys.json") from None
    pub = priv.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    if b64e(pub) != keys["pub"]:
        raise StoreError("unwrapped private key does not match keys.json pub")
    _UNLOCKED[ck] = priv
    return priv


def _priv(keys_json, secret):
    return secret if isinstance(secret, ec.EllipticCurvePrivateKey) else unlock(keys_json, secret)


# ---------------------------------------------------------------- envelope
def seal(keys_json, plain, name):
    """Encrypt bytes for the site public key -> envelope bytes (compact JSON + newline)."""
    site = _pub(load_keys(keys_json))
    eph = ec.generate_private_key(ec.SECP256R1())
    epk = eph.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    key = HKDF(hashes.SHA256(), 32, epk, LABEL).derive(eph.exchange(ec.ECDH(), site))
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, plain, LABEL)
    env = {"v": 1, "name": name, "bytes": len(plain), "epk": b64e(epk), "iv": b64e(iv), "ct": b64e(ct)}
    return (json.dumps(env, separators=(",", ":")) + "\n").encode()


def unseal(priv, raw):
    """Envelope bytes/dict -> plaintext bytes."""
    try:
        e = json.loads(raw) if isinstance(raw, (bytes, str)) else raw
        if not isinstance(e, dict) or e.get("v") != 1 or not all(k in e for k in ("epk", "iv", "ct")):
            raise ValueError
        epk = b64d(e["epk"])
        peer = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), epk)
        key = HKDF(hashes.SHA256(), 32, epk, LABEL).derive(priv.exchange(ec.ECDH(), peer))
        return AESGCM(key).decrypt(b64d(e["iv"]), b64d(e["ct"]), LABEL)
    except Exception:
        raise StoreError("cannot decrypt document (wrong key or damaged file)") from None


def encode_doc(keys_json, doc_id, version, data, updated_at):
    plain = json.dumps({"version": version, "updatedAt": updated_at, "data": data},
                       ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return seal(keys_json, plain, f"{doc_id}.json")


def decode_doc(priv, raw):
    try:
        p = json.loads(unseal(priv, raw).decode("utf-8"))
    except StoreError:
        raise
    except Exception:
        raise StoreError("document plaintext is not JSON") from None
    if not isinstance(p, dict) or not isinstance(p.get("version"), int) or p["version"] < 1 or not isinstance(p.get("data"), dict):
        raise StoreError("document plaintext has the wrong shape")
    return {"version": p["version"], "updatedAt": p.get("updatedAt"), "data": p["data"]}


# ---------------------------------------------------------------- layout
def doc_relpath(collection, doc_id):
    return f"db/{_check_name('collection', collection)}/{_check_name('doc', doc_id)}{SUFFIX}"


def doc_path(engine_dir, collection, doc_id):
    return os.path.join(engine_dir, *doc_relpath(collection, doc_id).split("/"))


def list_docs(engine_dir):
    db = os.path.join(engine_dir, "db")
    out = []
    if not os.path.isdir(db):
        return out
    for c in sorted(os.listdir(db)):
        cd = os.path.join(db, c)
        if not os.path.isdir(cd) or not NAME_RE.match(c):
            continue
        for f in sorted(os.listdir(cd)):
            if f.endswith(SUFFIX) and NAME_RE.match(f[: -len(SUFFIX)]):
                out.append((c, f[: -len(SUFFIX)]))
    return out


def read_doc(engine_dir, keys_json, secret, collection, doc_id):
    p = doc_path(engine_dir, collection, doc_id)
    if not os.path.exists(p):
        return None
    with open(p, "rb") as f:
        raw = f.read()
    try:
        return decode_doc(_priv(keys_json, secret), raw)
    except StoreError as e:
        raise StoreError(f"{collection}/{doc_id}: {e}") from None


def read_all(engine_dir, keys_json, secret):
    priv = _priv(keys_json, secret)
    return {f"{c}/{d}": read_doc(engine_dir, keys_json, priv, c, d) for c, d in list_docs(engine_dir)}


# ---------------------------------------------------------------- merge
def is_delete_marker(v):
    return isinstance(v, dict) and v.get("__delete__") is True


def _copy(v):
    return json.loads(json.dumps(v))


def strip_markers(v):
    """Copy of v with delete-marker keys removed from every (nested) object; arrays are copied verbatim."""
    if isinstance(v, dict):
        return {k: strip_markers(x) for k, x in v.items() if not is_delete_marker(x)}
    return _copy(v)


def deep_merge(base, patch):
    """ArtifactData 'update' semantics. Objects merge recursively; arrays, scalars and null replace; an object value with
    "__delete__": true removes the key. A non-object patch replaces base; a patch object over a non-object starts from {}."""
    if not isinstance(patch, dict):
        return _copy(patch)
    out = _copy(base) if isinstance(base, dict) else {}
    for k, v in patch.items():
        if is_delete_marker(v):
            out.pop(k, None)
        elif isinstance(v, dict):
            out[k] = deep_merge(out.get(k), v)
        else:
            out[k] = _copy(v)
    return out


# ---------------------------------------------------------------- file writing
def _atomic_write(path, data, mode=0o644):
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-", suffix=".part")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


# ---------------------------------------------------------------- materialize
def materialize(engine_dir, keys_json, secret, out_dir, clean=False):
    priv = _priv(keys_json, secret)
    docs = list_docs(engine_dir)
    if os.path.isdir(out_dir) and os.listdir(out_dir):
        if not clean:
            raise StoreError("materialize: out_dir is not empty (pass clean=True / --clean)")
        for c in os.listdir(out_dir):
            cd = os.path.join(out_dir, c)
            if os.path.isdir(cd) and NAME_RE.match(c):
                for f in os.listdir(cd):
                    if f.endswith(".json"):
                        os.unlink(os.path.join(cd, f))
                if not os.listdir(cd):
                    os.rmdir(cd)
    decoded = [(c, d, read_doc(engine_dir, keys_json, priv, c, d)) for c, d in docs]   # decrypt all before writing any
    os.makedirs(out_dir, mode=0o700, exist_ok=True)
    per = {}
    for c, d, doc in decoded:
        cd = os.path.join(out_dir, c)
        os.makedirs(cd, mode=0o700, exist_ok=True)
        body = json.dumps({"id": d, "version": doc["version"], "updatedAt": doc["updatedAt"], "data": doc["data"]},
                          ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        _atomic_write(os.path.join(cd, d + ".json"), body, 0o600)
        per[c] = per.get(c, 0) + 1
    return {"docs": len(decoded), "collections": per}


# ---------------------------------------------------------------- apply
def _norm_write(w, i):
    if not isinstance(w, dict):
        raise StoreError(f"write #{i} is not an object")
    op = w.get("op")
    if op not in ("set", "update", "delete"):
        raise StoreError(f"write #{i}: op must be set, update or delete")
    c = _check_name("collection", w.get("collection"))
    d = _check_name("doc", w.get("doc_id", w.get("doc", w.get("id"))))
    data = w.get("data")
    if op != "delete" and not isinstance(data, dict):
        raise StoreError(f"write #{i} ({c}/{d}): data must be an object")
    iv = w.get("if_version")
    if iv is not None and (not isinstance(iv, int) or isinstance(iv, bool) or iv < 0):
        raise StoreError(f"write #{i} ({c}/{d}): if_version must be a non-negative integer")
    return op, c, d, data, iv


def apply_writes(engine_dir, keys_json, writes, secret, now=None, dry_run=False):
    if isinstance(writes, dict) and "writes" in writes:
        writes = writes["writes"]
    if not isinstance(writes, list):
        raise StoreError("writes must be a list")
    priv = _priv(keys_json, secret)
    ts = now or _now_iso()
    norm = [_norm_write(w, i) for i, w in enumerate(writes)]
    state = {}        # (c, d) -> {"version", "data", "updatedAt"} or None (absent); current in-memory view
    orig = {}         # (c, d) -> canonical json of data at start (None = absent), to decide what to write
    results = []
    for op, c, d, data, if_version in norm:
        k = (c, d)
        if k not in state:
            doc = read_doc(engine_dir, keys_json, priv, c, d)
            state[k] = doc
            orig[k] = (doc["version"], _canon(doc["data"])) if doc else None
        cur = state[k]
        cur_ver = cur["version"] if cur else 0
        if if_version is not None and if_version != cur_ver:
            raise VersionConflict(c, d, if_version, cur_ver)
        if op == "delete":
            if cur is None:
                results.append({"collection": c, "doc_id": d, "op": op, "status": "absent", "version": 0})
            else:
                state[k] = None
                results.append({"collection": c, "doc_id": d, "op": op, "status": "deleted", "version": cur_ver})
            continue
        new = strip_markers(data) if op == "set" else deep_merge(cur["data"] if cur else {}, data)
        if cur is not None and _canon(new) == _canon(cur["data"]):
            results.append({"collection": c, "doc_id": d, "op": op, "status": "unchanged", "version": cur_ver})
            continue
        state[k] = {"version": cur_ver + 1, "updatedAt": ts, "data": new}
        results.append({"collection": c, "doc_id": d, "op": op, "status": "created" if cur is None else "updated",
                        "version": cur_ver + 1})
    # decide file actions: a doc whose final state equals its starting state (same version and data) is left alone
    plan = []
    for k, doc in state.items():
        o = orig[k]
        if doc is None:
            if o is not None:
                plan.append(("rm", k, None))
        elif o is None or o != (doc["version"], _canon(doc["data"])):
            plan.append(("put", k, doc))
    changed = sorted(doc_relpath(*k) for _, k, _ in plan)
    if not dry_run:
        blobs = [(a, k, encode_doc(keys_json, k[1], doc["version"], doc["data"], doc["updatedAt"]) if a == "put" else None)
                 for a, k, doc in plan]        # encrypt everything before touching any file
        for a, k, blob in blobs:
            p = doc_path(engine_dir, *k)
            if a == "put":
                _atomic_write(p, blob)
            elif os.path.exists(p):
                os.unlink(p)
    return {"ok": True, "dryRun": bool(dry_run), "changed": changed, "results": results}


# ---------------------------------------------------------------- migrate
def _unwrap_export(x):
    """Export file content -> (data, version). Mirrors the tools' `d.data || d` for wrapped files."""
    if isinstance(x, dict) and isinstance(x.get("data"), dict):
        v = x.get("version")
        return x["data"], (v if isinstance(v, int) and not isinstance(v, bool) and v >= 1 else 1)
    if isinstance(x, dict):
        return x, 1
    raise StoreError("export document is not a JSON object")


def read_export(export_dir, skip=("tools",)):
    """-> {(coll, doc): (data, version)} for every <coll>/<doc>.json in an ArtifactData export."""
    out = {}
    for c in sorted(os.listdir(export_dir)):
        cd = os.path.join(export_dir, c)
        if not os.path.isdir(cd) or c in skip:
            continue
        _check_name("collection", c)
        for f in sorted(os.listdir(cd)):
            if not f.endswith(".json"):
                continue
            d = _check_name("doc", f[:-5])
            with open(os.path.join(cd, f), encoding="utf-8") as fh:
                try:
                    out[(c, d)] = _unwrap_export(json.load(fh))
                except StoreError as e:
                    raise StoreError(f"{c}/{d}: {e}") from None
    return out


def migrate(export_dir, engine_dir, keys_json, config=None, overwrite=False, now=None, skip=("tools",)):
    docs = read_export(export_dir, skip)
    if not docs:
        raise StoreError("migrate: the export has no documents")
    db = os.path.join(engine_dir, "db")
    if list_docs(engine_dir):
        if not overwrite:
            raise StoreError("migrate: db/ already has documents (pass overwrite=True / --overwrite)")
        shutil.rmtree(db)
    ts = now or _now_iso()
    per = {}
    for (c, d), (data, ver) in docs.items():
        _atomic_write(doc_path(engine_dir, c, d), encode_doc(keys_json, d, ver, data, ts))
        per[c] = per.get(c, 0) + 1
    if config is not None:
        _atomic_write(os.path.join(engine_dir, "config.json"), (json.dumps(config, indent=2, ensure_ascii=False) + "\n").encode())
    return {"docs": len(docs), "collections": per, "config": config is not None}


def config_for(export_dir, portfolio_id=None, name=None, site_repo=None, site_folder=None, timezone=None):
    s = {}
    p = os.path.join(export_dir, "portfolio", "settings.json")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            s = _unwrap_export(json.load(f))[0]
    pid = portfolio_id or s.get("portfolioId")
    if not pid:
        raise StoreError("portfolio id unknown (pass --portfolio-id)")
    return {"portfolioId": pid, "name": name or s.get("name") or pid, "siteRepo": site_repo or DEFAULT_SITE_REPO,
            "siteFolder": site_folder or f"p/{pid}", "timezone": timezone or DEFAULT_TZ}


# ---------------------------------------------------------------- verify
def verify(engine_dir, keys_json, secret, against=None):
    priv = _priv(keys_json, secret)
    problems = []
    db = os.path.join(engine_dir, "db")
    if os.path.isdir(db):     # stray files the store would ignore
        for root, dirs, files in os.walk(db):
            for f in files:
                rel = os.path.relpath(os.path.join(root, f), engine_dir).replace(os.sep, "/")
                parts = rel.split("/")
                if len(parts) != 3 or not f.endswith(SUFFIX) or not NAME_RE.match(parts[1]) or not NAME_RE.match(f[: -len(SUFFIX)]):
                    problems.append(f"stray file {rel}")
    got = {}
    for c, d in list_docs(engine_dir):
        p = doc_path(engine_dir, c, d)
        try:
            with open(p, "rb") as f:
                raw = f.read()
            env = json.loads(raw)
            if set(env) != ENVELOPE_KEYS:
                problems.append(f"{c}/{d}: envelope keys {sorted(env)}")
            doc = decode_doc(priv, raw)
            if env.get("bytes") != len(unseal(priv, raw)):
                problems.append(f"{c}/{d}: envelope byte count mismatch")
            if not isinstance(doc["updatedAt"], str):
                problems.append(f"{c}/{d}: updatedAt missing")
            got[(c, d)] = doc
        except (StoreError, ValueError) as e:
            problems.append(f"{c}/{d}: {e}")
    if os.path.exists(os.path.join(engine_dir, "config.json")):
        try:
            with open(os.path.join(engine_dir, "config.json")) as f:
                cfg = json.load(f)
            miss = [k for k in ("portfolioId", "name", "siteRepo", "siteFolder", "timezone") if k not in cfg]
            if miss:
                problems.append(f"config.json missing {miss}")
        except ValueError:
            problems.append("config.json is not JSON")
    compared = 0
    if against:
        exp = read_export(against)
        for k in sorted(set(exp) - set(got)):
            problems.append(f"{k[0]}/{k[1]}: in the export, not in db/")
        for k in sorted(set(got) - set(exp)):
            problems.append(f"{k[0]}/{k[1]}: in db/, not in the export")
        for k in sorted(set(got) & set(exp)):
            compared += 1
            a, b = got[k]["data"], exp[k][0]
            # identical = same canonical JSON AND same key order (what export.py would serialise)
            if _canon(a) != _canon(b) or json.dumps(a, ensure_ascii=False) != json.dumps(b, ensure_ascii=False):
                problems.append(f"{k[0]}/{k[1]}: data differs from the export")
    return {"ok": not problems, "docs": len(got), "compared": compared, "problems": problems}


# ---------------------------------------------------------------- CLI
def _cli_keys(a):
    if a.keys:
        return load_keys(a.keys)
    if os.environ.get("KEYS_JSON"):
        return load_keys(os.environ["KEYS_JSON"])
    if a.site:
        with open(os.path.join(a.engine, "config.json")) as f:
            folder = json.load(f)["siteFolder"]
        return load_keys(os.path.join(a.site, *folder.split("/"), "keys.json"))
    raise StoreError("keys.json unknown (pass --keys, set KEYS_JSON, or pass --site <public repo checkout>)")


def _cli_secret(a, keys):
    s = None
    if getattr(a, "setup_key_file", None):
        with open(a.setup_key_file) as f:
            s = f.read().strip()
    else:
        s = os.environ.get("SETUP_KEY", "").strip()
    if not s:
        raise StoreError("setup key missing (env SETUP_KEY or --setup-key-file)")
    return unlock(keys, s)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="store.py", description="Encrypted engine-repo document store.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p, secret=True):
        p.add_argument("--engine", required=True, help="engine repo checkout (has db/ and config.json)")
        p.add_argument("--keys", help="site keys.json (public)")
        p.add_argument("--site", help="public repo checkout; keys.json = <site>/<config.siteFolder>/keys.json")
        if secret:
            p.add_argument("--setup-key-file", help="file holding the setup key (default: env SETUP_KEY)")

    p = sub.add_parser("materialize"); common(p); p.add_argument("--out", required=True); p.add_argument("--clean", action="store_true")
    p = sub.add_parser("apply"); common(p); p.add_argument("--writes", required=True); p.add_argument("--dry-run", action="store_true")
    p = sub.add_parser("verify"); common(p); p.add_argument("--against")
    p = sub.add_parser("migrate"); common(p, secret=False); p.add_argument("--export", required=True)
    for o in ("--portfolio-id", "--name", "--site-repo", "--site-folder", "--timezone"):
        p.add_argument(o)
    p.add_argument("--no-config", action="store_true"); p.add_argument("--overwrite", action="store_true")
    a = ap.parse_args(argv)
    out = lambda d: print(json.dumps(d, ensure_ascii=False))
    try:
        if a.cmd == "migrate":
            keys = load_keys(a.keys) if a.keys else load_keys(os.environ["KEYS_JSON"]) if os.environ.get("KEYS_JSON") else None
            cfg = None if a.no_config else config_for(a.export, a.portfolio_id, a.name, a.site_repo, a.site_folder, a.timezone)
            if keys is None:
                if not a.site or not cfg:
                    raise StoreError("keys.json unknown (pass --keys or --site)")
                keys = load_keys(os.path.join(a.site, *cfg["siteFolder"].split("/"), "keys.json"))
            out({"ok": True, "cmd": "migrate", **migrate(a.export, a.engine, keys, cfg, a.overwrite)})
            return 0
        keys = _cli_keys(a)
        priv = _cli_secret(a, keys)
        if a.cmd == "materialize":
            out({"ok": True, "cmd": "materialize", **materialize(a.engine, keys, priv, a.out, a.clean)})
        elif a.cmd == "apply":
            src = sys.stdin if a.writes == "-" else open(a.writes, encoding="utf-8")
            with src:
                writes = json.load(src)
            r = apply_writes(a.engine, keys, writes, priv, dry_run=a.dry_run)
            out({"cmd": "apply", **r})
        elif a.cmd == "verify":
            r = verify(a.engine, keys, priv, a.against)
            out({"cmd": "verify", **r})
            return 0 if r["ok"] else 2
        return 0
    except VersionConflict as e:
        out({"ok": False, "error": "version_conflict", "collection": e.collection, "doc_id": e.doc_id,
             "expected": e.expected, "actual": e.actual})
        return 3
    except StoreError as e:
        out({"ok": False, "error": str(e)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
