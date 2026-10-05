#!/usr/bin/env python3
"""The encryption every portfolio document uses, and the merge rules of an "update" (no storage of its own any more:
every portfolio lives in its owner's site account, run_account_mail.py reads and writes it there).

Envelope, as one line of compact JSON plus "\\n":
    {"v":1,"name":"<doc>.json","bytes":<plaintext length>,"epk":b64,"iv":b64,"ct":b64}
    epk = ephemeral P-256 public key, X9.62 uncompressed (65 bytes); shared = ECDH(eph, the recipient's public key);
    key = HKDF-SHA256(ikm=shared, salt=epk, info=label, 32 bytes); ct = AES-256-GCM(key, iv 12 bytes, aad=label) of the
    plaintext. Documents use the label "portfolio-file-v1" (the same as site/lock.js unseal(e, 'portfolio-file-v1')).
Plaintext of a document: UTF-8 JSON {"version": <int >= 1>, "updatedAt": "<ISO-8601 UTC>", "data": {...}}.
Private key from a keys.json (keys/mail.json): "wrap" unwrapped with the setup key (dashes removed, uppercased) via
    PBKDF2-SHA256(wrap.iter, wrap.salt) -> AES-256-GCM(wrap.iv, aad "portfolio-key-v1") -> PKCS8 DER; unlock() also
    checks it matches keys.pub.

    unlock(keys_json, setup_key) -> private key          load_keys(path or dict) -> keys
    seal(keys_json, plain, name) / unseal(priv, raw)    encode_doc(keys, doc_id, version, data, updated_at) / decode_doc(priv, raw)
    deep_merge(base, patch): objects merge recursively, arrays and scalars (incl. null) replace, a value that is an
        object with "__delete__": true removes that key; strip_markers(v) drops such markers (a "set").
The merge rules are pinned by src/jobs/merge_vectors.json; the site's JavaScript copy (site/store.js) passes the same file.
Needs: python 3.9+, cryptography.
"""
import os, re, json, base64, datetime

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

LABEL = b"portfolio-file-v1"
WRAP_AAD = b"portfolio-key-v1"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
ENVELOPE_KEYS = {"v", "name", "bytes", "epk", "iv", "ct"}


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
    """'update' semantics (as the page's database uses them). Objects merge recursively; arrays, scalars and null replace; an object value with
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
