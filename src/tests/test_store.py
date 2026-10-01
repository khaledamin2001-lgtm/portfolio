#!/usr/bin/env python3
"""Unit + real-data tests for src/jobs/store.py. Prints test names and pass/fail only -- never document data or keys.

    python3 -m unittest -v src/tests/test_store.py     (from the repository root)

Most tests use a THROWAWAY key pair (fast PBKDF2) and synthetic docs. The RealExports tests use the two real exports and
the real keys (local-only setup key files) and are skipped when those files are absent (e.g. in public CI)."""
import os, sys, glob, json, copy, base64, shutil, hashlib, tempfile, unittest, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
A = os.path.dirname(HERE)
SP = os.path.dirname(os.path.dirname(A))
# store.py is in ../jobs (src/tests -> src/jobs)
JOBS = next(p for p in (os.path.join(A, "src", "jobs"), os.path.join(A, "jobs")) if os.path.exists(os.path.join(p, "store.py")))
sys.path.insert(0, JOBS)
import store  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from cryptography.hazmat.primitives import serialization, hashes  # noqa: E402
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC  # noqa: E402
from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402

STORE_PY = os.path.join(JOBS, "store.py")
VECTORS = os.path.join(JOBS, "merge_vectors.json")
ENCRYPT_FILE_PY = next((p for p in ("/home/user/portfolio/tools/encrypt_file.py", os.path.join(SP, "tools", "encrypt_file.py")) if os.path.exists(p)), None)


def _latest_export(pid):
    """env <PID>_EXPORT, else the newest SP/sync-*/export-<pid> (the spec's exports; no dated path literal in this file)."""
    env = os.environ.get(f"{pid.upper()}_EXPORT")
    if env:
        return env
    c = sorted(glob.glob(os.path.join(SP, "sync-*", f"export-{pid}")))
    return c[-1] if c else os.path.join(SP, "missing-export")


REAL = [("khaled", _latest_export("khaled"), os.path.join(SP, "site", "secret", "setup_key.txt")),
        ("yassin", _latest_export("yassin"), os.path.join(SP, "site", "secret", "yassin", "setup_key.txt"))]
TEST_SETUP_KEY = "TEST-KEY0-NOT-REAL-0001"
b64 = lambda b: base64.b64encode(b).decode()


def make_test_keys(setup_key=TEST_SETUP_KEY, iters=1000):
    """Same shape as SP/site/make_keys.py, with a throwaway key and few iterations."""
    priv = ec.generate_private_key(ec.SECP256R1())
    pub = priv.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    pk8 = priv.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    salt, iv = os.urandom(16), os.urandom(12)
    kek = PBKDF2HMAC(hashes.SHA256(), 32, salt, iters).derive(setup_key.replace("-", "").upper().encode())
    ct = AESGCM(kek).encrypt(iv, pk8, b"portfolio-key-v1")
    return {"v": 3, "pub": b64(pub), "wrap": {"kdf": "PBKDF2-SHA256", "iter": iters, "salt": b64(salt), "iv": b64(iv), "ct": b64(ct)}}, pk8


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def tree_hashes(d):
    out = {}
    for r, _, fs in os.walk(d):
        for f in fs:
            p = os.path.join(r, f)
            out[os.path.relpath(p, d)] = sha(p)
    return out


def seed(engine, keys, docs):
    """docs {"c/d": {"version", "data"}} -> encrypted files."""
    for k, v in docs.items():
        c, d = k.split("/")
        store._atomic_write(store.doc_path(engine, c, d), store.encode_doc(keys, d, v["version"], v["data"], "2026-01-01T00:00:00Z"))


def state(engine, keys, priv):
    return {k: {"version": v["version"], "data": v["data"]} for k, v in store.read_all(engine, keys, priv).items()}


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.keys, cls.pk8 = make_test_keys()
        cls.priv = store.unlock(cls.keys, TEST_SETUP_KEY)

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="store-test-", dir=SP if os.path.isdir(SP) else None)
        self.eng = os.path.join(self.tmp, "engine")
        os.makedirs(self.eng)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class Keys(Base):
    def test_unlock_accepts_dashes_and_case(self):
        p = store.unlock(self.keys, TEST_SETUP_KEY.lower().replace("-", ""))
        self.assertEqual(p.private_numbers(), self.priv.private_numbers())

    def test_wrong_setup_key_raises(self):
        with self.assertRaises(store.StoreError):
            store.unlock(self.keys, "WRONG-KEY0-0000-0000")

    def test_unwrapped_key_must_match_pub(self):
        other, _ = make_test_keys()
        k = dict(self.keys, pub=other["pub"])
        with self.assertRaises(store.StoreError):
            store.unlock(k, TEST_SETUP_KEY)

    def test_wrong_private_key_cannot_decrypt(self):
        other, _ = make_test_keys()
        seed(self.eng, self.keys, {"sync/state": {"version": 1, "data": {"a": 1}}})
        with self.assertRaises(store.StoreError):
            store.read_doc(self.eng, other, store.unlock(other, TEST_SETUP_KEY), "sync", "state")


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

    @unittest.skipUnless(ENCRYPT_FILE_PY, "tools/encrypt_file.py not found")
    def test_same_format_as_tools_encrypt_file(self):
        """A file written by the site's own encrypt_file.py decrypts with store.unseal, and vice versa by field set."""
        src = os.path.join(self.tmp, "doc.json")
        plain = json.dumps({"version": 2, "updatedAt": "2026-09-29T00:00:00Z", "data": {"k": [1, 2]}}).encode()
        with open(src, "wb") as f:
            f.write(plain)
        kp, out = os.path.join(self.tmp, "keys.json"), os.path.join(self.tmp, "doc.enc.json")
        with open(kp, "w") as f:
            json.dump(self.keys, f)
        subprocess.run([sys.executable, ENCRYPT_FILE_PY, src, kp, out], check=True, capture_output=True)
        with open(out, "rb") as f:
            raw = f.read()
        self.assertEqual(store.unseal(self.priv, raw), plain)
        self.assertEqual(set(json.loads(raw)), set(json.loads(store.encode_doc(self.keys, "doc", 1, {}, "t"))))
        self.assertEqual(store.decode_doc(self.priv, raw)["data"], {"k": [1, 2]})

    def test_browser_webcrypto_reads_and_writes_the_format(self):
        """node WebCrypto (same calls as lock.js / the site editor) decrypts a store.py file, and store.py decrypts a
        document the browser path encrypted with only the public key."""
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
        # and a browser-written file is a normal store doc: apply_writes can continue from it
        store._atomic_write(store.doc_path(self.eng, "portfolio", "marks"), json.dumps(out["envelope"]).encode())
        r2 = store.apply_writes(self.eng, self.keys, [{"op": "update", "collection": "portfolio", "doc_id": "marks",
                                                       "data": {"n": "x"}, "if_version": 5}], self.priv)
        self.assertEqual(r2["results"][0]["version"], 6)


class Vectors(Base):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with open(VECTORS, encoding="utf-8") as f:
            cls.V = json.load(f)

    def test_vectors_file_is_substantial(self):
        self.assertGreaterEqual(len(self.V["merge"]), 25)
        self.assertGreaterEqual(len(self.V["batches"]), 15)
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

    def test_batch_vectors_against_real_files(self):
        for i, t in enumerate(self.V["batches"]):
            with self.subTest(t["name"]):
                eng = os.path.join(self.tmp, f"b{i}")
                os.makedirs(eng)
                seed(eng, self.keys, t["docs"])
                before = tree_hashes(eng)
                if "expectError" in t:
                    x = t["expectError"]
                    exc = store.VersionConflict if x["type"] == "version_conflict" else store.StoreError
                    with self.assertRaises(exc) as cm:
                        store.apply_writes(eng, self.keys, t["writes"], self.priv)
                    if x["type"] == "version_conflict":
                        e = cm.exception
                        self.assertEqual((e.collection, e.doc_id, e.expected, e.actual), (x["collection"], x["doc_id"], x["expected"], x["actual"]))
                    else:
                        self.assertNotIsInstance(cm.exception, store.VersionConflict)
                    self.assertEqual(tree_hashes(eng), before, "a failed batch must not touch any file")
                else:
                    r = store.apply_writes(eng, self.keys, t["writes"], self.priv, now="2026-09-29T00:00:00Z")
                    self.assertEqual([{"status": x["status"], "version": x["version"]} for x in r["results"]], t["expect"]["results"])
                    self.assertEqual(state(eng, self.keys, self.priv), t["expect"]["docs"])

    def test_javascript_reference_passes_the_same_vectors(self):
        r = subprocess.run(["node", os.path.join(HERE, "js_compat.mjs"), "vectors", VECTORS], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout[-500:] + r.stderr[-300:])
        self.assertTrue(json.loads(r.stdout)["ok"])


class ApplyWrites(Base):
    DOCS = {"portfolio/settings": {"version": 3, "data": {"name": "T", "factsheetEmail": "x@example.com"}},
            "portfolio/marks": {"version": 5, "data": {"months": {"2026-08": {"AAA": 1}}}},
            "ledger/y2026": {"version": 12, "data": {"rows": [{"d": "2026-01-02", "q": 1}]}},
            "sync/state": {"version": 40, "data": {"seen": ["a"], "plan": {"gmailAfter": "2026/09/01"}}}}

    def setUp(self):
        super().setUp()
        seed(self.eng, self.keys, self.DOCS)

    def test_unchanged_docs_keep_exact_bytes(self):
        before = tree_hashes(self.eng)
        r = store.apply_writes(self.eng, self.keys, [{"op": "update", "collection": "portfolio", "doc_id": "marks",
                                                      "data": {"months": {"2026-09": {"AAA": 2}}}, "if_version": 5}], self.priv)
        after = tree_hashes(self.eng)
        self.assertEqual(r["changed"], ["db/portfolio/marks.enc.json"])
        changed = {k for k in before if before[k] != after.get(k)}
        self.assertEqual(changed, {os.path.join("db", "portfolio", "marks.enc.json")})
        self.assertEqual(set(before), set(after))

    def test_noop_writes_touch_no_file(self):
        before = tree_hashes(self.eng)
        mt = os.stat(store.doc_path(self.eng, "sync", "state")).st_mtime_ns
        r = store.apply_writes(self.eng, self.keys, [
            {"op": "update", "collection": "sync", "doc_id": "state", "data": {"plan": {"gmailAfter": "2026/09/01"}}},
            {"op": "set", "collection": "portfolio", "doc_id": "settings", "data": copy.deepcopy(self.DOCS["portfolio/settings"]["data"])},
            {"op": "update", "collection": "ledger", "doc_id": "y2026", "data": {}},
            {"op": "delete", "collection": "market", "doc_id": "latest"}], self.priv)
        self.assertEqual(r["changed"], [])
        self.assertEqual([x["status"] for x in r["results"]], ["unchanged", "unchanged", "unchanged", "absent"])
        self.assertEqual(tree_hashes(self.eng), before)
        self.assertEqual(os.stat(store.doc_path(self.eng, "sync", "state")).st_mtime_ns, mt)

    def test_change_then_revert_in_one_batch_still_bumps(self):
        r = store.apply_writes(self.eng, self.keys, [
            {"op": "update", "collection": "sync", "doc_id": "state", "data": {"x": 1}},
            {"op": "update", "collection": "sync", "doc_id": "state", "data": {"x": {"__delete__": True}}}], self.priv)
        self.assertEqual([x["version"] for x in r["results"]], [41, 42])
        self.assertEqual(store.read_doc(self.eng, self.keys, self.priv, "sync", "state")["data"], self.DOCS["sync/state"]["data"])

    def test_updated_at_stamped_only_on_change(self):
        store.apply_writes(self.eng, self.keys, [{"op": "update", "collection": "portfolio", "doc_id": "marks", "data": {"z": 1}},
                                                 {"op": "update", "collection": "ledger", "doc_id": "y2026", "data": {}}],
                           self.priv, now="2026-09-29T10:00:00Z")
        self.assertEqual(store.read_doc(self.eng, self.keys, self.priv, "portfolio", "marks")["updatedAt"], "2026-09-29T10:00:00Z")
        self.assertEqual(store.read_doc(self.eng, self.keys, self.priv, "ledger", "y2026")["updatedAt"], "2026-01-01T00:00:00Z")

    def test_version_conflict_writes_nothing(self):
        before = tree_hashes(self.eng)
        with self.assertRaises(store.VersionConflict) as cm:
            store.apply_writes(self.eng, self.keys, [
                {"op": "set", "collection": "market", "doc_id": "latest", "data": {"a": 1}},
                {"op": "update", "collection": "portfolio", "doc_id": "marks", "data": {"z": 1}, "if_version": 4}], self.priv)
        self.assertEqual((cm.exception.expected, cm.exception.actual), (4, 5))
        self.assertEqual(tree_hashes(self.eng), before)
        self.assertFalse(os.path.exists(store.doc_path(self.eng, "market", "latest")))

    def test_dry_run_reports_but_writes_nothing(self):
        before = tree_hashes(self.eng)
        r = store.apply_writes(self.eng, self.keys, [{"op": "delete", "collection": "sync", "doc_id": "state"},
                                                     {"op": "set", "collection": "market", "doc_id": "latest", "data": {"a": 1}}],
                               self.priv, dry_run=True)
        self.assertEqual(r["changed"], ["db/market/latest.enc.json", "db/sync/state.enc.json"])
        self.assertEqual(tree_hashes(self.eng), before)

    def test_delete_removes_file(self):
        r = store.apply_writes(self.eng, self.keys, [{"op": "delete", "collection": "sync", "doc_id": "state", "if_version": 40}], self.priv)
        self.assertEqual(r["changed"], ["db/sync/state.enc.json"])
        self.assertFalse(os.path.exists(store.doc_path(self.eng, "sync", "state")))

    def test_result_carries_no_document_data(self):
        r = store.apply_writes(self.eng, self.keys, [{"op": "update", "collection": "portfolio", "doc_id": "settings",
                                                      "data": {"secretish": "VALUE-MUST-NOT-APPEAR"}}], self.priv)
        self.assertNotIn("VALUE-MUST-NOT-APPEAR", json.dumps(r))

    def test_names_are_validated(self):
        for c, d in (("..", "x"), ("sync", "../state"), ("sync", "a/b"), ("sync", ""), ("", "x"), ("sync", ".hidden"),
                     ("sync", "x" * 65), ("sync", "state.json"), ("sync", None), ("sync", 5)):
            with self.subTest((c, d)):
                with self.assertRaises(store.StoreError):
                    store.apply_writes(self.eng, self.keys, [{"op": "set", "collection": c, "doc_id": d, "data": {}}], self.priv)

    def test_bad_if_version_types(self):
        for iv in (-1, "3", True, 1.0):
            with self.subTest(iv):
                with self.assertRaises(store.StoreError):
                    store.apply_writes(self.eng, self.keys, [{"op": "set", "collection": "sync", "doc_id": "state", "data": {},
                                                              "if_version": iv}], self.priv)

    def test_doc_alias_keys_and_wrapped_list(self):
        r = store.apply_writes(self.eng, self.keys, {"writes": [{"op": "update", "collection": "sync", "doc": "state", "data": {"y": 1}},
                                                                {"op": "update", "collection": "sync", "id": "state", "data": {"z": 1}}]}, self.priv)
        self.assertEqual([x["version"] for x in r["results"]], [41, 42])

    def test_accepts_setup_key_string_as_secret(self):
        r = store.apply_writes(self.eng, self.keys, [{"op": "update", "collection": "sync", "doc_id": "state", "data": {"y": 1}}], TEST_SETUP_KEY)
        self.assertEqual(r["results"][0]["status"], "updated")


class MaterializeMigrate(Base):
    def make_export(self):
        exp = os.path.join(self.tmp, "export")
        docs = {"portfolio/settings": {"portfolioId": "t1", "name": "Test Portfolio"},
                "portfolio/assets": {"id": "assets", "version": 7, "data": {"items": {"A": {"n": 1}}}},   # wrapped with a version
                "history/2026-09": {"id": "2026-09", "data": {"d": {"2026-09-01": 1}}},                   # wrapped, no version
                "tools/sync": {"code": "..."}}                                                            # skipped collection
        for k, v in docs.items():
            c, d = k.split("/")
            os.makedirs(os.path.join(exp, c), exist_ok=True)
            with open(os.path.join(exp, c, d + ".json"), "w") as f:
                json.dump(v, f)
        return exp

    def test_migrate_versions_config_and_verify(self):
        exp = self.make_export()
        cfg = store.config_for(exp)
        self.assertEqual(cfg, {"portfolioId": "t1", "name": "Test Portfolio", "siteRepo": "khaledamin2001-lgtm/portfolio",
                               "siteFolder": "p/t1", "timezone": "Africa/Cairo"})
        r = store.migrate(exp, self.eng, self.keys, cfg)
        self.assertEqual(r["docs"], 3)
        self.assertEqual(store.list_docs(self.eng), [("history", "2026-09"), ("portfolio", "assets"), ("portfolio", "settings")])
        s = state(self.eng, self.keys, self.priv)
        self.assertEqual(s["portfolio/assets"], {"version": 7, "data": {"items": {"A": {"n": 1}}}})
        self.assertEqual(s["history/2026-09"]["version"], 1)
        self.assertEqual(s["portfolio/settings"]["version"], 1)
        v = store.verify(self.eng, self.keys, self.priv, against=exp)
        self.assertTrue(v["ok"], v["problems"])
        self.assertEqual(v["compared"], 3)
        with open(os.path.join(self.eng, "config.json")) as f:
            self.assertEqual(json.load(f), cfg)

    def test_migrate_refuses_non_empty_db(self):
        exp = self.make_export()
        store.migrate(exp, self.eng, self.keys)
        with self.assertRaises(store.StoreError):
            store.migrate(exp, self.eng, self.keys)
        self.assertEqual(store.migrate(exp, self.eng, self.keys, overwrite=True)["docs"], 3)

    def test_verify_detects_differences_and_strays(self):
        exp = self.make_export()
        store.migrate(exp, self.eng, self.keys)
        store.apply_writes(self.eng, self.keys, [{"op": "update", "collection": "portfolio", "doc_id": "assets", "data": {"x": 1}}], self.priv)
        with open(os.path.join(self.eng, "db", "portfolio", "notes.json"), "w") as f:
            f.write("{}")
        v = store.verify(self.eng, self.keys, self.priv, against=exp)
        self.assertFalse(v["ok"])
        self.assertTrue(any("portfolio/assets" in p and "differs" in p for p in v["problems"]))
        self.assertTrue(any("stray file" in p for p in v["problems"]))
        self.assertNotIn('"x"', json.dumps(v))

    def test_materialize_shape_and_guards(self):
        exp = self.make_export()
        store.migrate(exp, self.eng, self.keys)
        out = os.path.join(self.tmp, "mat")
        r = store.materialize(self.eng, self.keys, self.priv, out)
        self.assertEqual(r, {"docs": 3, "collections": {"history": 1, "portfolio": 2}})
        with open(os.path.join(out, "portfolio", "assets.json")) as f:
            m = json.load(f)
        self.assertEqual((m["id"], m["version"], m["data"]), ("assets", 7, {"items": {"A": {"n": 1}}}))
        self.assertEqual(os.stat(os.path.join(out, "portfolio", "assets.json")).st_mode & 0o777, 0o600)
        with self.assertRaises(store.StoreError):
            store.materialize(self.eng, self.keys, self.priv, out)
        # clean: a doc deleted from the store disappears from the materialized dir
        store.apply_writes(self.eng, self.keys, [{"op": "delete", "collection": "history", "doc_id": "2026-09"}], self.priv)
        r = store.materialize(self.eng, self.keys, self.priv, out, clean=True)
        self.assertEqual(r["docs"], 2)
        self.assertFalse(os.path.exists(os.path.join(out, "history")))


class Cli(Base):
    def run_cli(self, *args, env_extra=None, stdin=None):
        env = dict(os.environ, SETUP_KEY=TEST_SETUP_KEY)
        env.pop("KEYS_JSON", None)
        env.update(env_extra or {})
        r = subprocess.run([sys.executable, STORE_PY, *args], capture_output=True, text=True, env=env, input=stdin)
        lines = r.stdout.strip().splitlines()
        self.assertEqual(len(lines), 1, "the CLI prints exactly one JSON line")
        self.assertNotIn(TEST_SETUP_KEY.replace("-", ""), r.stdout.replace("-", "") + r.stderr.replace("-", ""))
        return r.returncode, json.loads(lines[0])

    def test_cli_end_to_end(self):
        kp = os.path.join(self.tmp, "keys.json")
        with open(kp, "w") as f:
            json.dump(self.keys, f)
        exp = MaterializeMigrate.make_export(self)
        rc, o = self.run_cli("migrate", "--export", exp, "--engine", self.eng, "--keys", kp)
        self.assertEqual((rc, o["ok"], o["docs"], o["config"]), (0, True, 3, True))
        rc, o = self.run_cli("verify", "--engine", self.eng, "--keys", kp, "--against", exp)
        self.assertEqual((rc, o["ok"], o["compared"]), (0, True, 3))
        w = json.dumps([{"op": "update", "collection": "portfolio", "doc_id": "assets", "data": {"items": {"B": {"n": 2}}}, "if_version": 7}])
        rc, o = self.run_cli("apply", "--engine", self.eng, "--keys", kp, "--writes", "-", stdin=w)
        self.assertEqual((rc, o["ok"], o["results"][0]["version"]), (0, True, 8))
        rc, o = self.run_cli("apply", "--engine", self.eng, "--keys", kp, "--writes", "-", stdin=w)       # stale pin
        self.assertEqual((rc, o["ok"], o["error"], o["expected"], o["actual"]), (3, False, "version_conflict", 7, 8))
        rc, o = self.run_cli("verify", "--engine", self.eng, "--keys", kp, "--against", exp)
        self.assertEqual((rc, o["ok"]), (2, False))
        out = os.path.join(self.tmp, "mat")
        rc, o = self.run_cli("materialize", "--engine", self.eng, "--keys", kp, "--out", out)
        self.assertEqual((rc, o["docs"]), (0, 3))
        # keys.json found through --site <public checkout>/<config.siteFolder>/keys.json; setup key from a file
        site = os.path.join(self.tmp, "site")
        os.makedirs(os.path.join(site, "p", "t1"))
        shutil.copy(kp, os.path.join(site, "p", "t1", "keys.json"))
        kf = os.path.join(self.tmp, "setup.txt")
        with open(kf, "w") as f:
            f.write(TEST_SETUP_KEY + "\n")
        rc, o = self.run_cli("verify", "--engine", self.eng, "--site", site, "--setup-key-file", kf, env_extra={"SETUP_KEY": ""})
        self.assertEqual((rc, o["docs"]), (0, 3))

    def test_cli_wrong_or_missing_key(self):
        kp = os.path.join(self.tmp, "keys.json")
        with open(kp, "w") as f:
            json.dump(self.keys, f)
        rc, o = self.run_cli("verify", "--engine", self.eng, "--keys", kp, env_extra={"SETUP_KEY": "WRONG-0000"})
        self.assertEqual((rc, o["ok"]), (1, False))
        rc, o = self.run_cli("verify", "--engine", self.eng, "--keys", kp, env_extra={"SETUP_KEY": ""})
        self.assertEqual((rc, o["ok"]), (1, False))


def _real_available():
    return all(os.path.isdir(e) and os.path.exists(k) for _, e, k in REAL) and all(os.path.exists(f"/home/user/portfolio/p/{p}/keys.json") for p, _, _ in REAL)


@unittest.skipUnless(_real_available(), "real exports / setup keys not present (local-only test)")
class RealExports(unittest.TestCase):
    """Both real exports: decrypt(encrypt(x)) == x doc by doc, and the delivered out/<pid> engine folders match."""

    @classmethod
    def setUpClass(cls):
        cls.ctx = {}
        for pid, exp, kf in REAL:
            keys = store.load_keys(f"/home/user/portfolio/p/{pid}/keys.json")
            with open(kf) as f:
                cls.ctx[pid] = (exp, keys, store.unlock(keys, f.read().strip()))

    def test_round_trip_every_doc(self):
        for pid, (exp, keys, priv) in self.ctx.items():
            docs = store.read_export(exp)
            self.assertGreater(len(docs), 10)
            for (c, d), (data, ver) in docs.items():
                with self.subTest(f"{pid}:{c}/{d}"):
                    raw = store.encode_doc(keys, d, ver, data, "2026-09-29T00:00:00Z")
                    back = store.decode_doc(priv, raw)
                    self.assertTrue(back["data"] == data and back["version"] == ver, "round trip differs")
                    self.assertEqual(json.dumps(back["data"], ensure_ascii=False), json.dumps(data, ensure_ascii=False), "key order changed")

    def test_other_portfolio_key_cannot_read(self):
        (_, kk, pk), (_, ky, py) = self.ctx["khaled"], self.ctx["yassin"]
        raw = store.encode_doc(kk, "x", 1, {"a": 1}, "t")
        with self.assertRaises(store.StoreError):
            store.decode_doc(py, raw)

    def test_delivered_engine_folders(self):
        for pid, (exp, keys, priv) in self.ctx.items():
            eng = os.path.join(A, "out", pid)
            with self.subTest(pid):
                self.assertTrue(os.path.isdir(eng), "out/<pid> missing")
                v = store.verify(eng, keys, priv, against=exp)
                self.assertTrue(v["ok"], "; ".join(v["problems"][:5]))
                self.assertEqual(v["compared"], len(store.read_export(exp)))
                with open(os.path.join(eng, "config.json")) as f:
                    cfg = json.load(f)
                self.assertEqual(cfg["portfolioId"], pid)
                self.assertEqual(cfg["siteFolder"], f"p/{pid}")
                # only config.json + db/<coll>/<doc>.enc.json, nothing plaintext
                for r, _, fs in os.walk(eng):
                    for f in fs:
                        rel = os.path.relpath(os.path.join(r, f), eng).replace(os.sep, "/")
                        self.assertTrue(rel == "config.json" or (rel.startswith("db/") and rel.endswith(".enc.json")), rel)


if __name__ == "__main__":
    unittest.main(verbosity=2)
