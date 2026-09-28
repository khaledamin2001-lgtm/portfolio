#!/usr/bin/env python3
"""CI smoke test for the site's encryption tools, on synthetic data and a THROWAWAY key (generated here, never saved
outside the temp dir, unrelated to any real portfolio key).
    python3 crypto_roundtrip.py <repo dir> <synthetic export dir> <any file to encrypt> <work dir>
Runs tools/export.py (the daily data publish) and tools/encrypt_file.py (the month-end workbook) exactly as the jobs do,
then decrypts both outputs with the throwaway private key using the scheme the site's lock.js implements
(ECDH P-256 -> HKDF-SHA256(salt = ephemeral public key, info = 'portfolio-data-v1' / 'portfolio-file-v1') -> AES-256-GCM
with the same string as additional data) and checks the plaintext: every export document round-trips unchanged, the file
bytes round-trip unchanged. Needs: pip install cryptography. Exit 0 and one JSON line when everything matches."""
import sys, os, json, gzip, base64, subprocess
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

repo, export, infile, work = sys.argv[1:5]
os.makedirs(work, exist_ok=True)
priv = ec.generate_private_key(ec.SECP256R1())
pub = priv.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
keys = os.path.join(work, 'keys.json')
json.dump({'v': 1, 'pub': base64.b64encode(pub).decode()}, open(keys, 'w'))   # only the public half is written

def run(*a):
    r = subprocess.run([sys.executable, *a], capture_output=True, text=True)
    if r.returncode: sys.exit(f'{os.path.basename(a[0])} failed (exit {r.returncode}): {r.stderr.strip() or r.stdout.strip()}')
    return json.loads(r.stdout.strip().splitlines()[-1])

def open_env(path, info):
    e = json.load(open(path)); d = lambda k: base64.b64decode(e[k])
    site = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), d('epk'))
    key = HKDF(hashes.SHA256(), 32, d('epk'), info).derive(priv.exchange(ec.ECDH(), site))
    return e, AESGCM(key).decrypt(d('iv'), d('ct'), info)

data_out, file_out = os.path.join(work, 'data.enc.json'), os.path.join(work, 'file.enc.json')
r1 = run(os.path.join(repo, 'tools', 'export.py'), export, keys, data_out)
r2 = run(os.path.join(repo, 'tools', 'encrypt_file.py'), infile, keys, file_out)
env, plain = open_env(data_out, b'portfolio-data-v1')
docs = json.loads(gzip.decompress(plain))['docs']
want = {}
for c in sorted(os.listdir(export)):
    for f in sorted(os.listdir(os.path.join(export, c))):
        if f.endswith('.json'): x = json.load(open(os.path.join(export, c, f))); want[f'{c}/{f[:-5]}'] = x.get('data', x) if isinstance(x, dict) else x
assert set(env) == {'v', 'at', 'epk', 'iv', 'ct'}, f'data envelope keys {sorted(env)}'
assert docs == want, 'export.py: decrypted documents differ from the export: ' + ', '.join(sorted(k for k in set(docs) | set(want) if docs.get(k) != want.get(k)))
envf, fb = open_env(file_out, b'portfolio-file-v1')
assert fb == open(infile, 'rb').read() and envf['bytes'] == len(fb) and envf['name'] == os.path.basename(infile), 'encrypt_file.py: round trip differs'
print(json.dumps({'ok': True, 'exportDocs': r1['docs'], 'dataBytes': r1['bytes'], 'fileBytes': r2['bytes']}))
