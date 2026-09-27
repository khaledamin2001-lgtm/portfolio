#!/usr/bin/env python3
"""Encrypt any file for the live site with the same scheme as export.py (site public key only).
   python3 encrypt_file.py <in file> <keys.json> <out .enc.json>"""
import sys, os, json, base64
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
src, keys, out = sys.argv[1:4]
plain = open(src, "rb").read()
k = json.load(open(keys))
site = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), base64.b64decode(k["pub"]))
eph = ec.generate_private_key(ec.SECP256R1())
epk = eph.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
key = HKDF(hashes.SHA256(), 32, epk, b"portfolio-file-v1").derive(eph.exchange(ec.ECDH(), site))
iv = os.urandom(12)
ct = AESGCM(key).encrypt(iv, plain, b"portfolio-file-v1")
b = lambda x: base64.b64encode(x).decode()
json.dump({"v": 1, "name": os.path.basename(src), "bytes": len(plain), "epk": b(epk), "iv": b(iv), "ct": b(ct)}, open(out, "w"))
print(json.dumps({"ok": True, "out": out, "bytes": len(plain)}))
