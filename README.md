# Portfolio

Private portfolio site for two people, served by GitHub Pages from one page (`index.html`). `portfolios.json` lists the
portfolios; each one lives under `p/<id>/`:

- `keys.json` — the portfolio's public key, its private key wrapped by the owner's one-time setup key (PBKDF2-SHA256,
  600,000 rounds, AES-256-GCM), and the hash of the owner's password. The setup key is not stored anywhere in this repository.
- `data.enc.json` — all figures, encrypted (ECDH P-256 → HKDF-SHA256 → AES-256-GCM) to that public key.
- `exports/` — month-end Excel workbooks, encrypted the same way, listed in `exports/index.json`.

Without a portfolio's setup key the page shows only its lock screen for that portfolio. One device can hold both
portfolios (each entered once with its own key); Face ID / fingerprint is enrolled once per device.

`tools/export.py` refreshes a `data.enc.json` from a database export and `tools/encrypt_file.py` encrypts a workbook;
both use only the public key. Automated jobs run them daily.
