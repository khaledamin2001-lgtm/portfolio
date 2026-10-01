#!/usr/bin/env python3
"""Encrypt a portfolio database export for the live site.
Usage: python3 export.py <export dir> <keys.json> <out data.enc.json>
<export dir> holds one folder per collection (portfolio, ledger, market, history, bench, imports), each with <doc id>.json
files (a plain export folder, as the jobs materialize it). Only the site's PUBLIC key is used: this script can encrypt but never decrypt.
Scheme: ephemeral ECDH P-256 with the site key -> HKDF-SHA256 -> AES-256-GCM over gzipped JSON. Needs: pip install cryptography"""
import sys, os, json, gzip, base64, datetime
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

COLLECTIONS = ["portfolio", "ledger", "market", "history", "bench", "imports", "sync"]
REQUIRED = ["portfolio/settings", "portfolio/marks", "portfolio/assets", "market/latest"]

def main(src, keys, out):
    docs = {}
    for c in COLLECTIONS:
        d = os.path.join(src, c)
        if not os.path.isdir(d): continue
        for f in sorted(os.listdir(d)):
            if not f.endswith(".json"): continue
            x = json.load(open(os.path.join(d, f)))
            docs[f"{c}/{f[:-5]}"] = x.get("data", x) if isinstance(x, dict) else x
    missing = [p for p in REQUIRED if p not in docs]
    if missing: sys.exit("export is incomplete, missing: " + ", ".join(missing))
    if not any(p.startswith("ledger/") for p in docs): sys.exit("export is incomplete, no ledger documents")
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    plain = gzip.compress(json.dumps({"exportedAt": now, "docs": docs}, separators=(",", ":")).encode(), 9)
    k = json.load(open(keys))
    site = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), base64.b64decode(k["pub"]))
    eph = ec.generate_private_key(ec.SECP256R1())
    epk = eph.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    key = HKDF(hashes.SHA256(), 32, epk, b"portfolio-data-v1").derive(eph.exchange(ec.ECDH(), site))
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, plain, b"portfolio-data-v1")
    b = lambda x: base64.b64encode(x).decode()
    json.dump({"v": 1, "at": now, "epk": b(epk), "iv": b(iv), "ct": b(ct)}, open(out, "w"))
    print(json.dumps({"ok": True, "docs": len(docs), "bytes": os.path.getsize(out), "at": now}))

if __name__ == "__main__":
    main(*sys.argv[1:4])
