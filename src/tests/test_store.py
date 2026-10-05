#!/usr/bin/env python3
"""Unit tests for src/jobs/store.py: the key unwrap, the document envelope, its compatibility with the browser
(site/lock.js WebCrypto, via js_compat.mjs) and the merge rules (src/jobs/merge_vectors.json, which the site's
JavaScript store.js passes too). Throwaway keys (fast PBKDF2) and synthetic documents only. Prints test names and
pass/fail only -- never document data or keys.

    python3 -m unittest -v src/tests/test_store.py     (from the repository root)"""
import os, sys, json, copy, base64, unittest, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
JOBS = os.path.join(os.path.dirname(HERE), "jobs")
sys.path.insert(0, JOBS)
import store  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from cryptography.hazmat.primitives import serialization, hashes  # noqa: E402
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC  # noqa: E402
from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402

VECTORS = os.path.join(JOBS, "merge_vectors.json")
TEST_SETUP_KEY = "TEST-KEY0-NOT-REAL-0001"
b64 = lambda b: base64.b64encode(b).decode()


def make_test_keys(setup_key=TEST_SETUP_KEY, iters=1000):
    """Same shape as site/make_keys.py (keys/mail.json), with a throwaway key and few iterations."""
    priv = ec.generate_private_key(ec.SECP256R1())
    pub = priv.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    pk8 = priv.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    salt, iv = os.urandom(16), os.urandom(12)
    kek = PBKDF2HMAC(hashes.SHA256(), 32, salt, iters).derive(setup_key.replace("-", "").upper().encode())
    ct = AESGCM(kek).encrypt(iv, pk8, b"portfolio-key-v1")
    return {"v": 3, "pub": b64(pub), "wrap": {"kdf": "PBKDF2-SHA256", "iter": iters, "salt": b64(salt), "iv": b64(iv), "ct": b64(ct)}}, pk8


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.keys, cls.pk8 = make_test_keys()
        cls.priv = store.unlock(cls.keys, TEST_SETUP_KEY)


class Keys(Base):
    def test_unlock_accepts_dashes_and_case(self):
        p = store.unlock(self.keys, TEST_SETUP_KEY.lower().replace("-", ""))
        self.assertEqual(p.private_numbers(), self.priv.private_numbers())

    def test_wrong_setup_key_raises(self):
        with self.assertRaises(store.StoreError):
            store.unlock(self.keys, "WRONG-KEY0-0000-0000")

    def test_unwrapped_key_must_match_pub(self):
        other, _ = make_test_keys()
        with self.assertRaises(store.StoreError):
            store.unlock(dict(self.keys, pub=other["pub"]), TEST_SETUP_KEY)

    def test_wrong_private_key_cannot_decrypt(self):
        other, _ = make_test_keys()
        raw = store.encode_doc(self.keys, "state", 1, {"a": 1}, "t")
        with self.assertRaises(store.StoreError):
            store.decode_doc(store.unlock(other, TEST_SETUP_KEY), raw)


class Envelope(Base):
    def test_round_trip_and_shape(self):
        data = {"a": 1, "s": {"x": [1, 2.5, None, True]}, "u": "محفظة"}
        raw = store.encode_doc(self.keys, "state", 3, data, "2026-09-29T00:00:00Z")
        env = json.loads(raw)
        self.assertEqual(set(env), store.ENVELOPE_KEYS)
        self.assertEqual(env["v"], 1)
        self.assertEqual(env["name"], "state.json")
        self.assertEqual(len(base64.b64decode(env["epk"])), 65)
        self.assertEqual(len(base64.b64decode(env["iv"])), 12)
        plain = store.unseal(self.priv, raw)
        self.assertEqual(env["bytes"], len(plain))
        self.assertEqual(json.loads(plain), {"version": 3, "updatedAt": "2026-09-29T00:00:00Z", "data": data})
        self.assertEqual(store.decode_doc(self.priv, raw)["data"], data)

    def test_fresh_ephemeral_key_and_iv_each_time(self):
        a = json.loads(store.encode_doc(self.keys, "x", 1, {"a": 1}, "t"))
        b = json.loads(store.encode_doc(self.keys, "x", 1, {"a": 1}, "t"))
        self.assertNotEqual(a["epk"], b["epk"])
        self.assertNotEqual(a["ct"], b["ct"])

    def test_tampered_ciphertext_fails(self):
        env = json.loads(store.encode_doc(self.keys, "x", 1, {"a": 1}, "t"))
        ct = bytearray(base64.b64decode(env["ct"]))
        ct[0] ^= 1
        env["ct"] = b64(bytes(ct))
        with self.assertRaises(store.StoreError):
            store.unseal(self.priv, json.dumps(env))

    def test_plaintext_shape_checked(self):
        for bad in (b"[]", b'{"version":0,"data":{}}', b'{"version":1,"data":[]}', b'{"version":"1","data":{}}', b"not json"):
            with self.assertRaises(store.StoreError):
                store.decode_doc(self.priv, store.seal(self.keys, bad, "x.json"))

    def test_browser_webcrypto_reads_and_writes_the_format(self):
        """node WebCrypto (the same calls as site/lock.js) decrypts a store.py document, and store.py decrypts a document
        the browser path encrypted with only the public key."""
        plain = {"version": 4, "updatedAt": "2026-09-29T00:00:00Z", "data": {"months": {"2026-09": {"AAA": 1.5}}, "n": "é"}}
        raw = store.encode_doc(self.keys, "marks", plain["version"], plain["data"], plain["updatedAt"])
        inp = json.dumps({"pkcs8": b64(self.pk8), "pub": self.keys["pub"], "envelope": json.loads(raw), "plain": plain})
        r = subprocess.run(["node", os.path.join(HERE, "js_compat.mjs"), "crypto"], input=inp, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr[-300:])
        out = json.loads(r.stdout)
        self.assertTrue(out["readOk"])
        doc = store.decode_doc(self.priv, json.dumps(out["envelope"]))
        self.assertEqual(doc, out["wrote"])
        self.assertEqual(doc["data"]["edited"], {"by": "browser"})


class Vectors(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(VECTORS, encoding="utf-8") as f:
            cls.V = json.load(f)

    def test_vectors_file_is_substantial(self):
        self.assertGreaterEqual(len(self.V["merge"]), 25)
        names = [t["name"] for k in ("merge", "set", "batches") for t in self.V[k]]
        self.assertEqual(len(names), len(set(names)), "vector names must be unique")

    def test_merge_vectors(self):
        for t in self.V["merge"]:
            with self.subTest(t["name"]):
                base, patch = copy.deepcopy(t["base"]), copy.deepcopy(t["patch"])
                self.assertEqual(store.deep_merge(base, patch), t["expect"])
                self.assertEqual((base, patch), (t["base"], t["patch"]), "inputs must be untouched")

    def test_set_vectors(self):
        for t in self.V["set"]:
            with self.subTest(t["name"]):
                self.assertEqual(store.strip_markers(t["data"]), t["expect"])

    def test_javascript_store_passes_every_vector(self):
        """site/store.js (the page's saves): merge, set and the all-or-nothing batches."""
        r = subprocess.run(["node", os.path.join(HERE, "js_compat.mjs"), "vectors", VECTORS], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout[-500:] + r.stderr[-300:])
        self.assertTrue(json.loads(r.stdout)["ok"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
