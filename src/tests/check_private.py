#!/usr/bin/env python3
"""Private-data guard for the PUBLIC repository. Fails (exit 1) when a file that would be published looks like it carries
private portfolio data. It checks PATTERNS only - this file holds no real name, figure or account code, so it can live in
the public repository and run in CI.

    python3 src/tests/check_private.py [repo dir]         (default: the repository this file sits in)

What is scanned: every file git tracks plus every untracked file git would add (`git ls-files` + `--others
--exclude-standard`), or every file under the directory when it is not a git checkout. Not content-scanned: the encrypted
files (m/market.enc.json, the accounts' a/<hash>/exports/*.enc.json - their SHAPE is checked instead), keys/mail.json
(shape checked: public key + wrapped private key only), fonts and other binary files.

Hits (each printed as  path:line  kind  with the value masked):
  path       a file that must never be committed: seed.json / expected.json (private test fixtures), a database export
             or sync folder (export-*/, sync-*/, synct/, inv/, private/, secret/, fixN/ scratch output), a plain
             workbook / PDF / e-mail / .b64 dump, a private key (private.pk8, *.pem, *.key), anything under a/ that is not
             a/<24 hex>/exports/<name>.enc.json, anything under keys/ but keys/mail.json
  shape      an .enc.json under m/ or a/ that is not {v, at?, name?, bytes?, epk, iv, ct} with base64 ciphertext;
             keys/mail.json that is not {v, pub, wrap:{kdf, iter, salt, iv, ct}}
  email      an e-mail address outside ALLOW_EMAILS / ALLOW_EMAIL_DOMAINS
  digits     a standalone run of 7+ digits (Thndr Unified Codes, phone numbers, national IDs, card/IBAN numbers) that is not
             in ALLOW_NUMBERS; also 4x4 card-number groups and EG IBANs
  figure     a money-looking literal: digits grouped by commas with 2 decimals, 4+ integer digits with exactly 2 decimals,
             or comma-grouped digits followed by EGP that are not a round thousand - the shape real balances, rebates and
             P/L take when they are pasted into a test or doc
  marker     'Unified Code' / unifiedCode followed by a number, a non-demo account-holder string literal (the holder key), PEM private
             keys, JWK private components, API tokens (GitHub, Anthropic, AWS, Google, Slack, Resend)
  private    (local only) a line containing one of the markers listed in the file named by $PRIVATE_MARKERS - one marker
             per line, e.g. the holders' full names and real headline figures. That file must live OUTSIDE the repository;
             hits never print the marker itself. CI does not set it.

A line that holds a deliberate synthetic value can carry the comment  private-scan: synthetic  to be skipped (keep it rare;
the review of that line is the real check). Exit 0 = clean."""
import os, re, sys, json, subprocess

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))

# public addresses the code legitimately mentions: the broker's sender address (sender verification) and a placeholder
ALLOW_EMAILS = {'no-reply@system.thndr.app', 'no-reply@mail.thndr.app', 'you@gmail.com', 'noreply@anthropic.com', 'noreply@github.com'}
ALLOW_EMAIL_DOMAINS = ('example.com', 'example.org', 'example.net', 'users.noreply.github.com')
ALLOW_EMAIL_TLDS = ('.example', '.test', '.invalid', '.localhost')
# numbers verified as not private: ms per day; the made-up CSV-import example in app.html (a TMG Holding line that is
# not in any ledger)
ALLOW_NUMBERS = {'86400000': 'milliseconds per day', '8905.12': 'made-up CSV import example (app.html)'}
ALLOW_HOLDERS = {'', 'demo holder'}
SKIP_LINE = 'private-scan: synthetic'
# public by design, not secrets: the Firebase web config's API key only names the project (src/site/lock.js FB.apiKey);
# the Firestore rules (src/cloud/firestore.rules) are what protect the data
ALLOW_TOKENS = {'AIzaSyAYvh69A5VWAgmhKXt07RTgLpB_1hYBjA8': 'Firebase web API key (public)'}

BINARY_EXT = {'.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.woff', '.woff2', '.ttf', '.otf', '.xlsx', '.xls', '.pdf', '.zip', '.gz'}
ENC_KEYS = {'v', 'at', 'name', 'bytes', 'epk', 'iv', 'ct'}
B64 = re.compile(r'^[A-Za-z0-9+/_-]+=*$')

BAD_NAMES = {'seed.json': 'private test fixture', 'expected.json': 'private test fixture', 'private.pk8': 'private key',
             'setup.key': 'setup key', '.env': 'environment secrets', 'secrets.env': 'environment secrets'}
BAD_DIRS = [(re.compile(r'^(export|sync)-'), 'database export / sync run'), (re.compile(r'^(synct|inv|private|secret|secrets)$'), 'private folder'),
            (re.compile(r'^fix\d*$'), 'scratch output of the private test runs')]
BAD_EXT = {'.xlsx': 'plain workbook', '.xls': 'plain workbook', '.pdf': 'plain PDF', '.eml': 'raw e-mail', '.b64': 'base64 dump',
           '.pem': 'key file', '.key': 'key file', '.pk8': 'key file', '.p12': 'key file'}

EMAIL = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}')
DIGITS = re.compile(r'(?<![\w.])\d{7,}(?![\w])')
CARD = re.compile(r'(?<!\d)\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}(?!\d)')
IBAN = re.compile(r'\bEG\d{2}(?:[ ]?\d{4}){5,}')
FIG_GROUPED_DEC = re.compile(r'(?<![\w.,])\d{1,3}(?:,\d{3})+\.\d{2}(?![\d.])')
FIG_PLAIN_DEC = re.compile(r'(?<![\w.,])\d{4,}\.\d{2}(?![\d.])')
FIG_GROUPED_EGP = re.compile(r'(?<![\w.,])(\d{1,3}(?:,\d{3})+)(?:\.\d+)?\s*(?:EGP|LE\b|جنيه)')
UCODE = [re.compile(r'unified\s*code\W{0,6}\d{4,}', re.I), re.compile(r'unifiedCode["\']?\s*[:=]\s*["\']?\d{4,}')]
HOLDER = re.compile(r'''["']?\bholder["']?\s*:\s*(["'])([^"'`$\\{}]*)\1''')
TOKENS = [(re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----'), 'PEM private key'),
          (re.compile(r'"d"\s*:\s*"[A-Za-z0-9_-]{40,}"'), 'JWK private component'),
          (re.compile(r'\bgh[pousr]_[A-Za-z0-9]{36,}\b'), 'GitHub token'), (re.compile(r'\bgithub_pat_[A-Za-z0-9_]{40,}'), 'GitHub token'),
          (re.compile(r'\bsk-ant-[A-Za-z0-9_-]{20,}'), 'Anthropic key'), (re.compile(r'\bAKIA[0-9A-Z]{16}\b'), 'AWS key'),
          (re.compile(r'\bAIza[0-9A-Za-z_-]{35}\b'), 'Google API key'), (re.compile(r'\bxox[abprs]-[A-Za-z0-9-]{10,}'), 'Slack token'),
          (re.compile(r'\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}\b'), 'Resend key')]

def mask(s):
    s = str(s)
    return s[:2] + '…(%d chars)' % len(s) if len(s) > 4 else '…'

def files():
    try:
        out = subprocess.run(['git', '-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], capture_output=True, check=True).stdout
        fs = sorted({f for f in out.decode('utf-8', 'replace').split('\0') if f})
        return [f for f in fs if os.path.isfile(os.path.join(ROOT, f))]   # deleted-but-not-staged files drop out
    except Exception:
        fs = []
        for r, ds, names in os.walk(ROOT):
            ds[:] = [d for d in ds if d not in ('.git', 'node_modules')]
            fs += [os.path.relpath(os.path.join(r, n), ROOT) for n in names]
        return sorted(fs)

def private_markers():
    p = os.environ.get('PRIVATE_MARKERS')
    if not p: return []
    p = os.path.abspath(p)
    if p.startswith(ROOT + os.sep): sys.exit(f'check_private: $PRIVATE_MARKERS must point OUTSIDE the repository ({ROOT})')
    return [m.strip().lower() for m in open(p, encoding='utf-8') if m.strip() and not m.startswith('#')]

def main():
    hits = []
    hit = lambda f, i, kind, what: hits.append(f'{f}:{i}  {kind}  {what}')
    markers = private_markers()
    scanned = 0
    for f in files():
        parts = f.split('/'); base = parts[-1]; ext = os.path.splitext(base)[1].lower()
        full = os.path.join(ROOT, f)
        # ---- paths ----
        if base in BAD_NAMES: hit(f, 0, 'path', BAD_NAMES[base])
        for d in parts[:-1]:
            for rx, why in BAD_DIRS:
                if rx.search(d): hit(f, 0, 'path', f'{why} ({d}/)')
        in_enc = len(parts) >= 2 and parts[0] in ('a', 'm')
        if ext in BAD_EXT and not (in_enc and base.endswith('.enc.json')): hit(f, 0, 'path', BAD_EXT[ext])
        if parts[0] == 'a' and not (len(parts) == 4 and re.fullmatch(r'[0-9a-f]{24}', parts[1]) and parts[2] == 'exports' and base.endswith('.enc.json')):
            hit(f, 0, 'path', 'only a/<24 hex>/exports/<name>.enc.json belongs under a/')
        if parts[0] == 'keys' and f != 'keys/mail.json': hit(f, 0, 'path', 'only keys/mail.json belongs under keys/')
        # ---- shapes of the encrypted / key files (not content-scanned) ----
        if in_enc and base.endswith('.enc.json'):
            try:
                x = json.load(open(full))
                bad = not isinstance(x, dict) or not {'v', 'epk', 'iv', 'ct'} <= set(x) or set(x) - ENC_KEYS or not isinstance(x['ct'], str) or len(x['ct']) < 32 or not B64.match(x['ct'])
            except Exception: bad = True
            if bad: hit(f, 0, 'shape', 'not an encrypted envelope {v, epk, iv, ct}')
            continue
        if f == 'keys/mail.json':
            try:
                x = json.load(open(full)); w = x.get('wrap') or {}
                bad = set(x) != {'v', 'pub', 'wrap'} or set(w) != {'kdf', 'iter', 'salt', 'iv', 'ct'} or '-----BEGIN' in json.dumps(x)
            except Exception: bad = True
            if bad: hit(f, 0, 'shape', 'keys/mail.json must hold only {v, pub, wrap:{kdf, iter, salt, iv, ct}}')
            continue
        # ---- content ----
        if ext in BINARY_EXT or 'fonts' in parts[:-1] or 'vendor' in parts[:-1]: continue   # vendor/: third-party builds (pdf.js)
        raw = open(full, 'rb').read()
        if b'\0' in raw[:8192]: continue
        text = raw.decode('utf-8', 'replace'); scanned += 1
        for i, line in enumerate(text.split('\n'), 1):
            if SKIP_LINE in line: continue
            for m in EMAIL.finditer(line):
                e = m.group(0).lower(); dom = e.split('@', 1)[1]
                if e in ALLOW_EMAILS or dom in ALLOW_EMAIL_DOMAINS or dom.endswith(ALLOW_EMAIL_TLDS): continue
                hit(f, i, 'email', mask(e))
            for m in DIGITS.finditer(line):
                if m.group(0) not in ALLOW_NUMBERS: hit(f, i, 'digits', mask(m.group(0)))
            for rx in (CARD, IBAN):
                for m in rx.finditer(line): hit(f, i, 'digits', mask(m.group(0)))
            for rx in (FIG_GROUPED_DEC, FIG_PLAIN_DEC):
                for m in rx.finditer(line):
                    if m.group(0).replace(',', '') not in ALLOW_NUMBERS: hit(f, i, 'figure', mask(m.group(0)))
            for m in FIG_GROUPED_EGP.finditer(line):
                if not re.fullmatch(r'\d{1,3}(?:,000)+', m.group(1)): hit(f, i, 'figure', mask(m.group(0)))
            if any(rx.search(line) for rx in UCODE): hit(f, i, 'marker', 'Unified Code with a number')
            for m in HOLDER.finditer(line):
                if m.group(2).strip().lower() not in ALLOW_HOLDERS: hit(f, i, 'marker', 'account holder literal ' + mask(m.group(2)))
            for rx, why in TOKENS:
                if any(m.group(0) not in ALLOW_TOKENS for m in rx.finditer(line)): hit(f, i, 'marker', why)
            if markers:
                low = line.lower()
                for k, mk in enumerate(markers, 1):
                    if mk in low: hit(f, i, 'private', f'marker #{k} from $PRIVATE_MARKERS')
    for h in hits: print(h)
    print(f'check_private: {scanned} text files scanned under {ROOT}, {len(hits)} hit(s)' + (f', {len(markers)} local private markers' if markers else ''))
    return 1 if hits else 0

if __name__ == '__main__':
    sys.exit(main())
