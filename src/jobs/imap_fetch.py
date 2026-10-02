#!/usr/bin/env python3
"""Fetch new Thndr emails from Gmail over IMAP (read-only) into an inbox folder for tools/sync.js.

    python3 imap_fetch.py --after YYYY/MM/DD --out <inbox dir> [--state <sync/state.json>]

The search, as Gmail's own X-GM-RAW search over All Mail:
    from:no-reply@system.thndr.app (subject:Invoice OR subject:E-statement) -subject:"US Market" after:<after>
keeping only subjects that start with "Your Thndr Invoice", "Your requested E-statement" or "Your monthly E-statement"
and whose id is not already a key of sync/state.seen. Unlike a thread search, IMAP returns every message, so later
messages in a thread are never missed.

Writes (the inbox folder sync.js and history_seed.js read):
    <out>/<id>.json      {"id", "raw": base64url RFC 822 bytes, "internalDate": "<ms since epoch>"}
    <out>/manifest.json  [{"id", "subject", "date": internalDate}]   ([] when nothing is new)
The id is the Gmail API message id = lowercase hex of IMAP X-GM-MSGID, so the ids already in sync/state.seen match.
The mailbox is opened with EXAMINE (select readonly) and bodies are fetched with BODY.PEEK: nothing is marked read,
moved or changed. Login: env GMAIL_ADDRESS and GMAIL_APP_PASSWORD, or the address / app password passed to fetch() (a
site account's own Gmail, run_account_mail.py); IMAP_HOST / IMAP_PORT / IMAP_SSL=0 for tests.
Prints one JSON line of counts; never a subject, address or secret."""
import os, re, sys, ssl, json, base64, imaplib, argparse, datetime, email
from email import policy

QUERY = 'from:no-reply@system.thndr.app (subject:Invoice OR subject:E-statement) -subject:"US Market" after:{after}'
# only the monthly statements (the history import looks for its starting point first, without downloading every invoice)
QUERY_MONTHLY = 'from:no-reply@system.thndr.app {{subject:"monthly E-statement" subject:"requested E-statement"}} -subject:"US Market" after:{after}'
KEEP = ("Your Thndr Invoice", "Your requested E-statement", "Your monthly E-statement")
ALL_MAIL = '"[Gmail]/All Mail"'


class FetchError(Exception):
    pass


def imap_quote(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def all_mail_box(M):
    """The All Mail folder by its \\All special-use flag (its name is localised), else the English name."""
    typ, data = M.list()
    if typ == "OK":
        for line in data or []:
            if not isinstance(line, bytes):
                continue
            m = re.match(rb'^\((?P<flags>[^)]*)\)\s+(?:"[^"]*"|NIL)\s+(?P<name>.+)$', line)
            if m and b"\\all" in m.group("flags").lower():
                return m.group("name").decode("utf-8", "replace")
    return ALL_MAIL


def internal_ms(s):
    """IMAP INTERNALDATE '31-Dec-2025 08:32:02 +0000' -> milliseconds since the epoch, as a string (Gmail API internalDate)."""
    dt = datetime.datetime.strptime(s.strip(), "%d-%b-%Y %H:%M:%S %z")
    return str(int(dt.timestamp()) * 1000)


def _meta(blob):
    b = blob.decode("latin-1") if isinstance(blob, bytes) else blob
    uid = re.search(r"\bUID (\d+)", b)
    gm = re.search(r"\bX-GM-MSGID (\d+)", b)
    idate = re.search(r'\bINTERNALDATE "([^"]+)"', b)
    return (uid and uid.group(1)), (gm and int(gm.group(1))), (idate and idate.group(1))


def connect(addr=None, pw=None):
    host = os.environ.get("IMAP_HOST", "imap.gmail.com")
    port = int(os.environ.get("IMAP_PORT", "993"))
    addr = (addr if addr is not None else os.environ.get("GMAIL_ADDRESS", "")).strip()
    pw = (pw if pw is not None else os.environ.get("GMAIL_APP_PASSWORD", "")).replace(" ", "").strip()
    if not addr or not pw:
        raise FetchError("GMAIL_ADDRESS / GMAIL_APP_PASSWORD are not set")
    try:
        M = (imaplib.IMAP4_SSL(host, port, ssl_context=ssl.create_default_context(), timeout=60)
             if os.environ.get("IMAP_SSL", "1") != "0" else imaplib.IMAP4(host, port, timeout=60))
    except OSError as e:
        raise FetchError(f"cannot reach the IMAP server: {type(e).__name__}") from None
    try:
        M.login(addr, pw)
    except imaplib.IMAP4.error:
        raise FetchError("Gmail refused the app password (IMAP login)") from None
    return M


def fetch(after, seen, out_dir, addr=None, pw=None, query=None):
    """-> counts dict. `seen`: set of ids already processed. Writes out_dir/<id>.json + manifest.json.
    addr / pw: the Gmail login (default: env GMAIL_ADDRESS / GMAIL_APP_PASSWORD). query: QUERY (default) or QUERY_MONTHLY."""
    if not re.match(r"^\d{4}/\d{2}/\d{2}$", after or ""):
        raise FetchError("--after must be YYYY/MM/DD")
    os.makedirs(out_dir, exist_ok=True)
    M = connect(addr, pw)
    counts = {"found": 0, "kept": 0, "seen": 0, "otherSubject": 0}
    manifest = []
    try:
        typ, _ = M.select(all_mail_box(M), readonly=True)
        if typ != "OK":
            raise FetchError("cannot open All Mail")
        typ, data = M.uid("SEARCH", "X-GM-RAW", imap_quote((query or QUERY).format(after=after)))
        if typ != "OK":
            raise FetchError("Gmail search failed")
        uids = (data[0] or b"").split()
        counts["found"] = len(uids)
        heads = []
        for i in range(0, len(uids), 100):
            chunk = b",".join(uids[i:i + 100]).decode()
            typ, data = M.uid("FETCH", chunk, "(UID X-GM-MSGID INTERNALDATE BODY.PEEK[HEADER.FIELDS (SUBJECT)])")
            if typ != "OK":
                raise FetchError("header fetch failed")
            for part in data:
                if not isinstance(part, tuple):
                    continue
                uid, gm, idate = _meta(part[0])
                if not (uid and gm and idate):
                    raise FetchError("the server returned a message without UID / X-GM-MSGID / INTERNALDATE")
                subj = email.message_from_bytes(part[1], policy=policy.default).get("subject", "")
                heads.append((uid, format(gm, "x"), internal_ms(idate), " ".join(str(subj).split())))
        for uid, mid, ims, subj in heads:
            if mid in seen:
                counts["seen"] += 1
                continue
            if not subj.startswith(KEEP):
                counts["otherSubject"] += 1
                continue
            typ, data = M.uid("FETCH", uid, "(UID X-GM-MSGID BODY.PEEK[])")
            raw = next((p[1] for p in (data or []) if isinstance(p, tuple)), None)
            if typ != "OK" or raw is None:
                raise FetchError("message fetch failed")
            _, gm2, _ = _meta(next(p[0] for p in data if isinstance(p, tuple)))
            if gm2 is not None and format(gm2, "x") != mid:
                raise FetchError("the server returned a different message than asked for")
            doc = {"id": mid, "raw": base64.urlsafe_b64encode(raw).decode(), "internalDate": ims}
            with open(os.path.join(out_dir, f"{mid}.json"), "w") as f:
                json.dump(doc, f)
            manifest.append({"id": mid, "subject": subj, "date": ims})
            counts["kept"] += 1
    finally:
        try:
            M.logout()
        except Exception:
            pass
    manifest.sort(key=lambda m: (int(m["date"]), m["id"]))
    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f)
    return counts


def skip_ids(seen, assets):
    """The seen ids a fetch skips: all of them, except the invoices while a stock is still stored without a ticker
    (sync.js reads those again for their ISIN codes and fills the ticker in). seen: sync/state seen {id: {kind}},
    assets: portfolio/assets items {name: asset}."""
    seen = seen or {}
    loose = any(isinstance(a, dict) and not a.get("fund") and not a.get("symbol") and not a.get("watch")
                and not str(a.get("name") or n).lower().startswith("thndr") for n, a in (assets or {}).items())
    return {k for k, v in seen.items() if not (loose and isinstance(v, dict) and v.get("kind") == "invoice")}


def seen_ids(state_path):
    if not state_path or not os.path.exists(state_path):
        return set()
    with open(state_path, encoding="utf-8") as f:
        x = json.load(f)
    x = x.get("data", x) if isinstance(x, dict) and isinstance(x.get("data"), dict) else x
    return set((x or {}).get("seen") or {})


def main(argv=None):
    ap = argparse.ArgumentParser(description="Fetch new Thndr emails over IMAP (read-only).")
    ap.add_argument("--after", required=True, help="YYYY/MM/DD (plan.js gmailAfter)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--state", help="sync/state.json (materialized) - its seen ids are skipped")
    a = ap.parse_args(argv)
    try:
        c = fetch(a.after, seen_ids(a.state), a.out)
        print(json.dumps({"ok": True, **c}))
        return 0
    except FetchError as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
