"""Generate a portfolio's site key pair (keys.json v3). Usage: python3 make_keys.py <out keys.json> <secret dir>
Writes keys.json — the P-256 public key plus the PKCS8 private key wrapped by AES-256-GCM under a key derived from a fresh
20-character setup key (PBKDF2-SHA256, 600,000 iterations, additional data 'portfolio-key-v1') — and, in <secret dir>,
setup_key.txt and private.pk8. The secret dir must never be committed.
v3 (site device store v3): keys.json carries NO password hash. Each device chooses its own password after entering the setup
key; that password only ever wraps the private key inside the device (lock.js), so nothing published lets anyone check a
guess. A third argument (the old `<password>`) is accepted and ignored so older command lines keep working; a v2 keys.json
(with its `pw` field) stays valid — lock.js ignores `pw`. rotate_keys.py reuses make_keys() to issue a replacement pair."""
import os, sys, json, base64, secrets
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"  # no 0/O, 1/I/L, U
SETUP_ITER = 600000
b64 = lambda b: base64.b64encode(b).decode()


def make_keys(out, sec):
    """Generate a key pair + setup key; write <out> (keys.json v3) and <sec>/{setup_key.txt,private.pk8}. Returns a summary dict."""
    setup = "-".join("".join(secrets.choice(ALPHABET) for _ in range(4)) for _ in range(5))
    priv = ec.generate_private_key(ec.SECP256R1())
    pk8 = priv.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    pub = priv.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    salt, iv = os.urandom(16), os.urandom(12)
    k = PBKDF2HMAC(hashes.SHA256(), 32, salt, SETUP_ITER).derive(setup.replace("-", "").encode())
    ct = AESGCM(k).encrypt(iv, pk8, b"portfolio-key-v1")
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True); os.makedirs(sec, exist_ok=True)
    keys = {"v": 3, "pub": b64(pub), "wrap": {"kdf": "PBKDF2-SHA256", "iter": SETUP_ITER, "salt": b64(salt), "iv": b64(iv), "ct": b64(ct)}}
    json.dump(keys, open(out, "w"), indent=1)
    open(os.path.join(sec, "setup_key.txt"), "w").write(setup + "\n")
    open(os.path.join(sec, "private.pk8"), "wb").write(pk8)
    os.chmod(os.path.join(sec, "setup_key.txt"), 0o600); os.chmod(os.path.join(sec, "private.pk8"), 0o600)
    return {"keys": out, "secret_dir": sec, "pub": keys["pub"]}


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__.splitlines()[0])
    if len(sys.argv) > 3:
        print("note: the password argument is ignored since v3 — each device chooses its own password", file=sys.stderr)
    print("ok", make_keys(sys.argv[1], sys.argv[2])["keys"])
