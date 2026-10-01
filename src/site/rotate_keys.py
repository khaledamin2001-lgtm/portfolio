#!/usr/bin/env python3
"""Key rotation runbook for one live-site portfolio.

Usage: python3 rotate_keys.py <portfolio id> <old secret dir> <new secret dir> <repo dir> <export dir> <password-hint or ->

Steps (all inside <repo dir>, nothing is committed or pushed — review `git status` and publish afterwards):
 1. Generates a NEW P-256 key pair + 20-character setup key with make_keys.make_keys() into <new secret dir>
    (setup_key.txt, private.pk8) and a v3 keys.json (public key + private key wrapped by the setup key, NO password hash).
 2. Re-encrypts <repo>/p/<id>/data.enc.json from <export dir> with <repo>/tools/export.py and the new public key.
 3. For every workbook listed in <repo>/p/<id>/exports/index.json: decrypts the published *.enc.json with the OLD private key
    (<old secret dir>/private.pk8 — the inverse of tools/encrypt_file.py: ECDH → HKDF-SHA256(salt = ephemeral public key,
    info 'portfolio-file-v1') → AES-256-GCM, additional data 'portfolio-file-v1') and re-encrypts it with the new public key
    via tools/encrypt_file.py, keeping the file's name.
 4. Only then replaces keys.json, data.enc.json and the export files in the repo (each new file is written next to the old
    one and renamed into place, so a failure half-way leaves the repo untouched).
 5. Verifies: data.enc.json and every export decrypt with the NEW private key and do NOT decrypt with the old one.
 6. Prints what it rewrote and reminds the operator that every device must enter the new setup key.

<password-hint or -> is only echoed back in the summary for the operator's notes: since device store v3 the site keeps no
password anywhere in the repo — each device chooses its own password after entering the setup key (see lock.js).
The old secret dir is never modified or deleted; move it out of the way yourself once every device has re-entered the key.
Needs: pip install cryptography. Uses only the standard tools already in the repo (tools/export.py, tools/encrypt_file.py)."""
import os, sys, json, base64, gzip, subprocess, tempfile, shutil
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_keys import make_keys  # noqa: E402

DATA_LABEL, FILE_LABEL = b"portfolio-data-v1", b"portfolio-file-v1"
ub64 = base64.b64decode


def load_private(secret_dir):
    return serialization.load_der_private_key(open(os.path.join(secret_dir, "private.pk8"), "rb").read(), None)


def unseal(priv, env, label):
    """Inverse of export.py / encrypt_file.py: env = {epk, iv, ct}; label = b'portfolio-data-v1' | b'portfolio-file-v1'."""
    epk = ub64(env["epk"])
    peer = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), epk)
    key = HKDF(hashes.SHA256(), 32, epk, label).derive(priv.exchange(ec.ECDH(), peer))
    return AESGCM(key).decrypt(ub64(env["iv"]), ub64(env["ct"]), label)


def decrypt_data(priv, path):
    """Returns the decrypted {exportedAt, docs} bundle of a data.enc.json."""
    return json.loads(gzip.decompress(unseal(priv, json.load(open(path)), DATA_LABEL)))


def decrypts(priv, path, label):
    try:
        unseal(priv, json.load(open(path)), label); return True
    except Exception:
        return False


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(" ".join(cmd) + ": " + (r.stderr.strip() or r.stdout.strip()))
    return r.stdout


def rotate(pid, old_sec, new_sec, repo, export_dir, hint="-"):
    pdir = os.path.join(repo, "p", pid)
    keys_path, data_path = os.path.join(pdir, "keys.json"), os.path.join(pdir, "data.enc.json")
    index_path = os.path.join(pdir, "exports", "index.json")
    export_py, encrypt_py = os.path.join(repo, "tools", "export.py"), os.path.join(repo, "tools", "encrypt_file.py")
    for p in (keys_path, export_py, encrypt_py):
        if not os.path.isfile(p): sys.exit(f"missing: {p}")
    if not os.path.isdir(export_dir): sys.exit(f"missing export dir: {export_dir}")
    if os.path.abspath(old_sec) == os.path.abspath(new_sec): sys.exit("the new secret dir must differ from the old one")
    if os.path.isdir(new_sec) and os.listdir(new_sec): sys.exit(f"new secret dir is not empty: {new_sec}")
    old_priv = load_private(old_sec)
    old_pub = json.load(open(keys_path))["pub"]
    if old_priv.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint) != ub64(old_pub):
        sys.exit(f"{old_sec}/private.pk8 does not match the public key in {keys_path}")
    exports = json.load(open(index_path)) if os.path.isfile(index_path) else []

    # 1. new pair + setup key; keys.json is staged in the new secret dir until everything else succeeded
    new_keys = os.path.join(new_sec, "keys.json")
    make_keys(new_keys, new_sec)
    new_priv = load_private(new_sec)
    staged, rewritten = [], []   # (tmp path, final path)
    try:
        # 2. data.enc.json from the export dir with the new public key
        tmp_data = data_path + ".rotating"
        out = run([sys.executable, export_py, export_dir, new_keys, tmp_data])
        info = json.loads(out.strip().splitlines()[-1])
        if not info.get("ok"): raise RuntimeError("export.py did not report ok: " + out)
        staged.append((tmp_data, data_path)); rewritten.append(f"p/{pid}/data.enc.json ({info['docs']} docs, {info['bytes']} bytes)")
        # 3. every published workbook: old private key -> plaintext -> new public key
        with tempfile.TemporaryDirectory(dir=new_sec) as td:
            os.chmod(td, 0o700)
            for x in exports:
                enc_path = os.path.join(pdir, x["file"])
                env = json.load(open(enc_path))
                plain = unseal(old_priv, env, FILE_LABEL)
                name = env.get("name") or x.get("name") or os.path.basename(x["file"]).replace(".enc.json", "")
                plain_path = os.path.join(td, name)
                open(plain_path, "wb").write(plain)
                tmp_enc = enc_path + ".rotating"
                run([sys.executable, encrypt_py, plain_path, new_keys, tmp_enc])
                os.remove(plain_path)
                staged.append((tmp_enc, enc_path)); rewritten.append(f"p/{pid}/{x['file']} ({len(plain)} bytes, {name})")
        # 4. everything encrypted: swap the files into place
        for tmp, final in staged:
            os.replace(tmp, final)
        shutil.copyfile(new_keys, keys_path)
        rewritten.insert(0, f"p/{pid}/keys.json (v3, no password hash)")
    except BaseException:
        for tmp, _ in staged:
            if os.path.exists(tmp): os.remove(tmp)
        raise
    # 5. verify with both keys
    bundle = decrypt_data(new_priv, data_path)
    checks = {"data.enc.json new key": True, "data.enc.json old key": decrypts(old_priv, data_path, DATA_LABEL)}
    for x in exports:
        p = os.path.join(pdir, x["file"])
        checks[x["file"] + " new key"] = decrypts(new_priv, p, FILE_LABEL)
        checks[x["file"] + " old key"] = decrypts(old_priv, p, FILE_LABEL)
    bad = [k for k, v in checks.items() if v != k.endswith("new key")]
    if bad: sys.exit("verification failed: " + ", ".join(bad))
    print(f"Rotated the keys of portfolio '{pid}' in {repo}:")
    for r in rewritten: print("  rewrote", r)
    print(f"  data bundle exportedAt {bundle['exportedAt']}, {len(bundle['docs'])} documents; verified: everything decrypts with the new key and nothing with the old one")
    print(f"  new setup key + private key: {new_sec}/setup_key.txt, {new_sec}/private.pk8 (keep them out of the repo)")
    print(f"  password hint for your notes: {hint}  (v3 stores no password; each device picks its own after the setup key)")
    print("NEXT: review `git status` in the repo, commit p/%s/ and push. Then EVERY device that opens this portfolio must enter" % pid)
    print("      the NEW setup key once (the old one and the old device setup no longer decrypt anything); the old secret dir")
    print(f"      ({old_sec}) can be archived once every device is done.")
    return {"pid": pid, "rewritten": rewritten, "checks": checks, "new_secret_dir": new_sec}


if __name__ == "__main__":
    if len(sys.argv) < 6:
        sys.exit(__doc__.splitlines()[2])
    rotate(*sys.argv[1:6], sys.argv[6] if len(sys.argv) > 6 else "-")
