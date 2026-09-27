# Portfolio

Personal portfolio site, served by GitHub Pages.

All portfolio figures are in `data.enc.json`, encrypted (ECDH P-256 → HKDF-SHA256 → AES-256-GCM) to the public key in
`keys.json`. The matching private key is published only in wrapped form (PBKDF2-SHA256, 600,000 rounds, AES-256-GCM),
and it can be unwrapped only with the owner's setup key, which is not stored anywhere in this repository. Without that key
the page shows only its lock screen.

`data.enc.json` is refreshed by an automated daily job with `tools/export.py`, which uses only the public key.
