/* Thndr e-statement reader: raw email → PDF attachments → text lines → transactions, month-end marks
   and a holdings snapshot, then reconciled against the ledger. Nothing is written here; the page
   shows the proposal and the user approves it. */
(function (root) {
  'use strict';

  // ---------- MIME ----------
  function b64ToBytes(b64) {
    const s = b64.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/=]/g, '');
    const bin = typeof atob === 'function' ? atob(s + '='.repeat((4 - (s.length % 4)) % 4)) : Buffer.from(s, 'base64').toString('binary');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const bytesToLatin1 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return s; };
  function parseMime(text) {
    const cut = text.search(/\r?\n\r?\n/);
    const head = cut < 0 ? text : text.slice(0, cut), body = cut < 0 ? '' : text.slice(cut).replace(/^\r?\n\r?\n/, '');
    const headers = {};
    head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).forEach((l) => { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); });
    return { headers, body };
  }
  // ---------- sender verification ----------
  // Top-level headers of the RAW message only (they end at the first blank line; continuation lines are unfolded).
  // dkim is 'pass' only when an Authentication-Results header written by the receiving host (the topmost one; any
  // later header with the same authserv-id counts too, headers other hosts stamped earlier do not) reports dkim=pass
  // for a signing domain (header.i / header.d) aligned with the From domain or its parent (thndr.app for
  // system.thndr.app); 'fail' when the receiver reports another dkim result; 'none' when it reports no DKIM at all.
  // ok = the From address is at system.thndr.app (or another *.thndr.app host) AND dkim === 'pass'. A display
  // name that merely looks like the Thndr address ("no-reply@system.thndr.app" <x@elsewhere>) never passes.
  function topHeaders(rawB64url) {
    const text = bytesToLatin1(b64ToBytes(rawB64url));
    const cut = text.search(/\r?\n\r?\n/);
    const head = (cut < 0 ? text : text.slice(0, cut)).replace(/\r?\n[ \t]+/g, ' ');
    const list = [];
    head.split(/\r?\n/).forEach((l) => { const i = l.indexOf(':'); if (i > 0) list.push({ name: l.slice(0, i).trim().toLowerCase(), value: l.slice(i + 1).trim() }); });
    return list;
  }
  function authCheck(rawB64url) {
    const hs = topHeaders(rawB64url);
    const get = (n) => hs.filter((h) => h.name === n).map((h) => h.value);
    const fromRaw = get('from')[0] || '';
    const am = fromRaw.match(/<([^<>\s]+@[^<>\s]+)>\s*$/) || fromRaw.match(/([^\s"<>,]+@[^\s"<>,]+)/);
    const from = am ? am[1].trim() : fromRaw.trim();
    const fromDomain = from.includes('@') ? from.slice(from.lastIndexOf('@') + 1).toLowerCase().replace(/[>\s]+$/, '') : '';
    const parent = fromDomain.split('.').length > 2 ? fromDomain.slice(fromDomain.indexOf('.') + 1) : null;
    const aligned = (d) => { d = (d || '').toLowerCase().replace(/^@/, ''); return !!d && [fromDomain, parent].some((x) => x && (d === x || d.endsWith('.' + x))); };
    const results = get('authentication-results');
    // only the topmost header counts: it is the one the receiving host (Gmail) added last; a later header that merely
    // repeats the same authserv-id could have been written by the sender
    const own = results.length ? [results[0]] : [];
    let dkim = 'none', spf = 'none';
    own.forEach((r) => {
      r.split(';').forEach((clause) => {
        const m = clause.trim().match(/^dkim=(\w+)(.*)$/i);
        if (m) {
          const props = m[2]; const dom = (props.match(/header\.i=\s*([^\s;]+)/i) || [])[1], sd = (props.match(/header\.d=\s*([^\s;]+)/i) || [])[1];
          const ok = /^pass$/i.test(m[1]) && (aligned(dom) || aligned(sd));
          if (ok) dkim = 'pass'; else if (dkim !== 'pass') dkim = 'fail';
        }
        const s = clause.trim().match(/^spf=(\w+)/i);
        if (s && spf === 'none') spf = s[1].toLowerCase();
      });
    });
    const ok = !!fromDomain && (fromDomain === 'system.thndr.app' || fromDomain.endsWith('.thndr.app')) && dkim === 'pass';
    return { from, fromDomain, dkim, spf, results, ok };
  }

  function attachments(rawB64url) {
    const text = bytesToLatin1(b64ToBytes(rawB64url));
    const out = [];
    (function walk(part) {
      const { headers, body } = parseMime(part);
      const ct = headers['content-type'] || '';
      const bm = ct.match(/boundary="?([^";]+)"?/i);
      if (/^multipart\//i.test(ct) && bm) {
        body.split('--' + bm[1]).slice(1).forEach((p) => { if (!/^--/.test(p)) walk(p.replace(/^\r?\n/, '')); });
        return;
      }
      const disp = headers['content-disposition'] || '';
      const nm = (disp.match(/filename\*?="?([^";]+)"?/i) || ct.match(/name="?([^";]+)"?/i) || [])[1];
      if (nm && /pdf/i.test(ct + nm)) {
        const enc = (headers['content-transfer-encoding'] || '').toLowerCase();
        out.push({ filename: nm, bytes: enc === 'base64' ? b64ToBytes(body) : b64ToBytes(btoa(body)) });
      }
    })(text);
    return out;
  }

  // ---------- PDF → lines (pdf.js text items grouped by baseline) ----------
  async function pdfLines(pdfjsLib, bytes) {
    const doc = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true }).promise;
    const lines = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      const rows = [];
      tc.items.forEach((it) => {
        if (!it.str || !it.str.trim()) return;
        const y = it.transform[5], x = it.transform[4];
        let r = rows.find((r) => Math.abs(r.y - y) < 2.5);
        if (!r) { r = { y, items: [] }; rows.push(r); }
        r.items.push({ x, s: it.str, w: it.width });
      });
      rows.sort((a, b) => b.y - a.y).forEach((r) => {
        r.items.sort((a, b) => a.x - b.x);
        let s = '', end = null;
        r.items.forEach((it) => { if (s && (end == null || it.x - end > 0.8) && !/\s$/.test(s) && !/^\s/.test(it.s)) s += ' '; s += it.s; end = it.x + it.w; });
        lines.push(s.replace(/\s+/g, ' ').trim());
      });
    }
    return lines;
  }

  // ---------- parsing ----------
  const num = (s) => (s == null ? null : parseFloat(String(s).replace(/,/g, '')));
  const dmy = (s) => { const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };
  const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

  function accountRows(lines) {
    const recs = [];
    lines.forEach((l) => {
      if (/^\d{1,2}\/\d{1,2}\/\d{4} /.test(l)) recs.push(l);
      else if (recs.length && !/^(Date Description|End Balance|Non objection|all transactions|more information|\d+\/\d+$)/.test(l) && !/[؀-ۿﹰ-﻿]/.test(l)) recs[recs.length - 1] += ' ' + l;
    });
    return recs.map((r) => {
      const date = dmy(r.split(' ')[0]);
      let rest = r.slice(r.indexOf(' ') + 1);
      const trade = rest.match(/\(\s*([\d,]+(?:\.\d+)?)\s*@\s*([\d,]+(?:\.\d+)?)\s*(?:EGP)?\s*\)?/);
      if (trade) rest = rest.replace(trade[0], ' ');
      const nums = [...rest.matchAll(/(?:^|\s)(-?[\d,]+(?:\.\d+)?)(?=\s|$)/g)].map((m) => ({ v: num(m[1]), i: m.index, end: m.index + m[0].length }));
      if (nums.length < 2) return { date, desc: rest.trim(), bad: true };
      const val = nums[nums.length - 2], bal = nums[nums.length - 1];
      let desc = (rest.slice(0, val.i) + ' ' + rest.slice(bal.end)).replace(/\s+/g, ' ').trim();
      while (/\)$/.test(desc) && (desc.match(/\)/g) || []).length > (desc.match(/\(/g) || []).length) desc = desc.slice(0, -1).trim();
      return { date, desc, value: val.v, balance: bal.v, qty: trade ? num(trade[1]) : null, price: trade ? num(trade[2]) : null, raw: r };
    });
  }

  function parseDoc(lines) {
    const t = lines.join('\n');
    if (/Position Snapshot/i.test(t)) {
      const dm = t.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s*(\d{4})/i);
      const asOf = dm ? `${dm[3]}-${String(MONTHS[dm[1].toLowerCase()]).padStart(2, '0')}-${dm[2].padStart(2, '0')}` : null;
      const holdings = []; let section = 'stock';
      const recs = [];
      lines.forEach((l) => { if (/Mutual funds holdings/i.test(l)) section = 'fund'; if (/Stocks holdings/i.test(l)) section = 'stock'; recs.push({ l, section }); });
      for (let i = 0; i < recs.length; i++) {
        let { l, section: sec } = recs[i];
        let m = l.match(/^([A-Za-z0-9.]+) (.*?)\s*EGP ([\d,]+(?:\.\d+)?) ([\d,]+(?:\.\d+)?) ([\d,]+(?:\.\d+)?)\s*(Thndr.*)?$/);
        if (!m && recs[i + 1]) { const j = l + ' ' + recs[i + 1].l; const m2 = j.match(/^([A-Za-z0-9.]+) (.*?)\s*EGP ([\d,]+(?:\.\d+)?) ([\d,]+(?:\.\d+)?) ([\d,]+(?:\.\d+)?)\s*(Thndr.*)?$/); if (m2 && /^[A-Z0-9]{3,}\s/.test(l) && !/^Ticker/.test(l)) { m = m2; i++; } }
        if (!m || /^Ticker/.test(l)) continue;
        const label = m[2].trim();
        holdings.push({ ticker: m[1], name: /^EGS/.test(label) ? '' : label, isin: /^EGS\w+$/.test(label) ? label : '', qty: num(m[3]), price: num(m[4]), value: num(m[5]), kind: sec });
      }
      return { kind: 'snapshot', asOf, holdings, total: holdings.reduce((s, h) => s + h.value, 0) };
    }
    const period = t.match(/From (\d{1,2}\/\d{1,2}\/\d{4}) To (\d{1,2}\/\d{1,2}\/\d{4})/);
    const start = t.match(/Start Balance (-?[\d,]+(?:\.\d+)?)/), end = t.match(/End Balance (-?[\d,]+(?:\.\d+)?)/);
    const rows = accountRows(lines);
    const isMF = rows.some((r) => r.raw && /@\s*[\d.,]+\s*EGP\s*\)/.test(r.raw)) || rows.some((r) => /^Transfer (from|to) main account/i.test(r.desc) || (/^Transfer to Mutual Funds Account$/i.test(r.desc) && r.value > 0));
    return { kind: isMF ? 'mf' : 'cash', from: period ? dmy(period[1]) : null, to: period ? dmy(period[2]) : null, start: start ? num(start[1]) : null, end: end ? num(end[1]) : null, rows,
      head: lines.slice(0, 6).join(' ') };
  }

  // classify one cash-account row
  function classify(r) {
    const d = r.desc;
    let m;
    if ((m = d.match(/^Commission Kickback/i)) || /^Client Incentive/i.test(d)) return { t: 'Rebate', amt: r.value, note: d };
    const clean = (n) => n.replace(/^(Same Day|T\+\d|Instant)\s+/i, '').trim();
    if ((m = d.match(/^Buy (.+)$/))) return { t: 'Buy', name: clean(m[1]), q: r.qty, p: r.price, amt: r.value };
    if ((m = d.match(/^Sell (.+)$/))) return { t: 'Sell', name: clean(m[1]), q: r.qty, p: r.price, amt: r.value };
    // bonus shares / stock dividend / free shares: no cash moves, the share count goes up. Thndr's exact wording is not
    // known yet, so "Bonus", "Bonus Shares -", "Bonus Issue:", "Stock Dividend", "Free Shares" and the Arabic منحة are all
    // accepted; the quantity comes from the "(n @ 0 EGP)" trade bracket, or failing that from "n shares" in the text.
    if ((m = d.match(/^(?:Bonus(?:\s+(?:Shares?|Issue))?|Stock\s+Dividends?|Free\s+Shares?|منحة(?:\s+(?:أسهم|اسهم))?)(?=[\s\-:–—]|$)\s*[-:–—]?\s*(.*)$/i))) {
      let rest = m[1].trim(), q = r.qty, ticker = null, isin = null, mm;
      if ((mm = rest.match(/^(\S+)\s+-\s+(\S+)\s+-\s+([\d.,]+)\s+shares?/i))) { isin = mm[1]; ticker = mm[2]; if (q == null) q = num(mm[3]); rest = ''; }
      else if (q == null && (mm = rest.match(/([\d,]+(?:\.\d+)?)\s*(?:shares?|أسهم|اسهم|سهم)/i))) { q = num(mm[1]); rest = rest.replace(mm[0], ' '); }
      if (!(q > 0)) return { t: '?', amt: r.value, note: d, hint: 'bonus' };
      const o = { t: 'Bonus', name: clean(rest).replace(/\s*\([^()]*$/, '').replace(/[\s\-:–—(),]+$/, '').trim(), q, amt: 0 };
      if (ticker) { o.ticker = ticker; o.isin = isin; }
      return o;
    }
    if (/^Deposit/i.test(d)) return { t: 'Deposit', amt: r.value };
    if (/^Transfer Bank/i.test(d) || /^Withdraw/i.test(d)) return { t: r.value < 0 ? 'Withdrawal' : 'Deposit', amt: r.value };
    if (/^Transfer (To Mutual Funds Account|from main account)/i.test(d)) return { t: 'MFOut', amt: r.value };
    if (/^Transfer (From Mutual Funds Account|to main account)/i.test(d)) return { t: 'MFIn', amt: r.value };
    if ((m = d.match(/^Cash Dividends? - (\S+) - (\S+) - ([\d.,]+) shares/i))) return { t: 'Dividend', ticker: m[2], isin: m[1], amt: r.value };
    if ((m = d.match(/^Cash Deduction - (.+)$/i))) return { t: 'Fee', name: m[1].replace(/_/g, ' ').replace(/\b(\w)(\w*)/g, (a, b, c) => b + c.toLowerCase()), amt: r.value };
    if (/Fees?\b/i.test(d)) return { t: 'Fee', name: d, amt: r.value };
    return { t: '?', amt: r.value, note: d };
  }

  // Parse all PDFs of one statement email.
  function parseStatement(docs) {
    const out = { cash: null, mf: null, snapshot: null, unknown: [] };
    const acct = [];
    docs.forEach((d) => { const p = parseDoc(d.lines); p.filename = d.filename; if (p.kind === 'snapshot') out.snapshot = p; else acct.push(p); });
    // the brokerage cash account carries deposits, kickbacks and share trades; the fund account carries fund-unit trades
    const score = (p) => p.rows.filter((r) => /^(Commission Kickback|Deposit|Cash Dividends|Transfer To Mutual|Transfer From Mutual)/i.test(r.desc || '') || (r.raw && /@\s*[\d.,]+\s*\)/.test(r.raw) && !/EGP\s*\)/.test(r.raw))).length;
    // in a quiet month neither scores (no deposits, trades or transfers): then the one whose header or file name says
    // mutual funds is the fund account, whatever order the PDFs came in
    const fundish = (p) => (/mutual\s*funds?|\bmf[-_ ]/i.test(((p.head || '') + ' ' + (p.filename || ''))) ? 1 : 0);
    acct.sort((a, b) => (score(b) - score(a)) || (fundish(a) - fundish(b)));
    if (acct[0]) { out.cash = acct[0]; out.cash.kind = 'cash'; }
    if (acct[1]) { out.mf = acct[1]; out.mf.kind = 'mf'; }
    if (!out.cash) return out;
    out.from = out.cash.from; out.to = out.cash.to; out.month = out.cash.to ? out.cash.to.slice(0, 7) : null;
    // a month is final only when the statement covers the whole calendar month: from the 1st to its last day
    // (a requested statement to the 28th/29th is a part-month statement)
    out.fullMonth = !!(out.from && out.to && out.from.endsWith('-01') && out.to === eom(out.to));
    return out;
  }
  // last calendar day of the month of a YYYY-MM(-DD) string, as YYYY-MM-DD
  function eom(d) { const y = +d.slice(0, 4), m = +d.slice(5, 7); return `${d.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; }

  // ---------- reconciliation against the ledger ----------
  const days = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 864e5);
  function reconcile(st, tx, assets, marks) {
    const A = Object.values(assets || {});
    const byLower = {}; A.forEach((a) => { byLower[a.name.toLowerCase()] = a; });
    const bySym = {}; A.forEach((a) => { if (a.symbol) bySym[a.symbol.toUpperCase()] = a; });
    const ledgerNames = {}; tx.forEach((t) => { if (t.a) ledgerNames[t.a.toLowerCase()] = t.a; });
    const snapNames = {}; (st.snapshot ? st.snapshot.holdings : []).forEach((h) => { if (h.name) snapNames[h.name.toLowerCase()] = h.ticker; });
    const resolveName = (n) => { const k = n.toLowerCase(); if (byLower[k]) return { name: byLower[k].name, known: true }; if (ledgerNames[k]) return { name: ledgerNames[k], known: true }; return { name: n, known: false, ticker: snapNames[k] || null }; };
    const from = st.from, to = st.to;
    const inWin = (d) => d >= from && d <= to;
    const cand = [];
    const unknown = [];
    const mfOut = [], mfIn = [];
    let kick = 0;
    st.cash.rows.filter((r) => r.date && inWin(r.date)).forEach((r) => {
      if (r.bad) { unknown.push(r); return; }
      const c = classify(r);
      if (c.t === 'Rebate') { kick += c.amt; return; }
      if (c.t === 'MFOut') { mfOut.push({ d: r.date, amt: c.amt, used: false }); return; }
      if (c.t === 'MFIn') { mfIn.push({ d: r.date, amt: c.amt, used: false }); return; }
      if (c.t === '?') { unknown.push(c.hint ? Object.assign({}, r, { hint: c.hint }) : r); return; }
      const row = { d: r.date, t: c.t, amt: Math.round(c.amt * 100) / 100, acc: 'Main', src: 'statement' };
      if (c.t === 'Buy' || c.t === 'Sell') { const n = resolveName(c.name); row.a = n.name; row.q = c.q; row.p = c.p; if (!n.known) row.newAsset = { name: c.name, ticker: n.ticker }; }
      if (c.t === 'Bonus') { // free shares: q only, amt 0
        const a = c.ticker && bySym[c.ticker.toUpperCase()]; const n = a ? { name: a.name, known: true } : resolveName(c.name);
        row.a = n.name; row.q = c.q; row.amt = 0; if (!n.known) row.newAsset = { name: c.name, ticker: c.ticker || n.ticker || null };
      }
      if (c.t === 'Dividend') { const a = bySym[c.ticker.toUpperCase()]; row.a = a ? a.name : c.ticker; row.ticker = c.ticker; }
      if (c.t === 'Fee') row.a = c.name;
      cand.push(row);
    });
    // mutual-fund trades: units and NAV from the fund account, cost from the matching cash transfer (includes the subscription fee).
    // One convention for every fund (thndrgold, thndrsavings, thndrmonthlysavings, ...): q = Thndr units and p = NAV per unit,
    // exactly as the statement prints them in its "(units @ NAV EGP)" bracket. Nothing here converts to grams or ounces or
    // special-cases the gold fund; the engine owns fund pricing and the conversion of old gram-denominated rows.
    if (st.mf) st.mf.rows.filter((r) => r.date && inWin(r.date) && /^(Buy|Sell) /.test(r.desc)).forEach((r) => {
      const buy = /^Buy /.test(r.desc); const name = r.desc.replace(/^(Buy|Sell) /, '').trim();
      const pool = buy ? mfOut : mfIn;
      const hit = pool.filter((x) => !x.used && days(x.d, r.date) <= 6 && Math.abs(Math.abs(x.amt) - Math.abs(r.value)) <= Math.max(1, Math.abs(r.value) * 0.02))
        .sort((a, b) => Math.abs(Math.abs(a.amt) - Math.abs(r.value)) - Math.abs(Math.abs(b.amt) - Math.abs(r.value)))[0];
      if (hit) hit.used = true;
      const n = resolveName(name);
      const amt = hit ? hit.amt : (buy ? -1 : 1) * Math.abs(r.value);
      const row = { d: r.date, t: buy ? 'Buy' : 'Sell', a: n.name, q: r.qty, p: r.price, amt: Math.round(amt * 100) / 100, acc: 'MF', src: 'statement' };
      if (!n.known) row.newAsset = { name, ticker: null };
      cand.push(row);
    });
    // transfers with no itemised fund trade are the savings wallet (thndrsavings, priced at 1)
    mfOut.concat(mfIn).filter((x) => !x.used).forEach((x) => { const a = Math.round(x.amt * 100) / 100; cand.push({ d: x.d, t: a < 0 ? 'Buy' : 'Sell', a: 'thndrsavings', q: Math.abs(a), p: 1, amt: a, acc: 'MF', src: 'statement' }); });
    // match against existing ledger rows (the ledger may come from the app export, so allow small date/amount differences).
    // Opening rows (t.opening: the holdings and cash typed at sign-up) stand for everything before tracking started; they
    // are never matched, corrected or removed by a statement, only counted in the holdings and cash checks.
    // A row just outside this statement's dates is only a candidate while no other statement has confirmed it (a deposit on
    // 29 Aug that the August statement posted is never "this September's 2 Sep deposit").
    const used = new Set();
    const inside = (d) => d >= from && d <= to;
    const pool = tx.filter((t) => !t.opening && t.d >= addDays(from, -6) && t.d <= addDays(to, 6)
      && (inside(t.d) || !/^(stmt-|history-|invoice-)/.test(t.src || '')));
    const same = (t, r) => {
      if (t.t !== r.t || used.has(t)) return false;
      const dd = days(t.d, r.d);
      if (r.t === 'Buy' || r.t === 'Sell') return (t.a || '').toLowerCase() === (r.a || '').toLowerCase() && dd <= 4 && (Math.abs((t.q || 0) - (r.q || 0)) < 0.01 || Math.abs(t.amt - r.amt) <= Math.max(1, Math.abs(r.amt) * 0.015));
      if (r.t === 'Bonus') return (t.a || '').toLowerCase() === (r.a || '').toLowerCase() && dd <= 4 && Math.abs((t.q || 0) - (r.q || 0)) < 0.01;
      if (r.t === 'Dividend') return dd <= 10 && Math.abs(t.amt - r.amt) <= 0.05;
      return dd <= 4 && Math.abs(t.amt - r.amt) <= 0.05;
    };
    const fresh = [], matched = [], conflicts = [];
    // the best match, not the first: a row inside the statement's dates first, then the nearest date, then the nearest amount
    const best = (r) => pool.filter((t) => same(t, r)).sort((a, b) => (inside(b.d) - inside(a.d)) || (days(a.d, r.d) - days(b.d, r.d))
      || (Math.abs(a.amt - r.amt) - Math.abs(b.amt - r.amt)))[0];
    cand.forEach((r) => { const hit = best(r); if (hit) { used.add(hit); matched.push({ stmt: r, ledger: hit }); } else fresh.push(r); });
    // same amount and date but booked to a different asset: flag, never auto-post
    for (let i = fresh.length - 1; i >= 0; i--) {
      const r = fresh[i]; if (r.t !== 'Buy' && r.t !== 'Sell') continue;
      const alt = pool.find((t) => !used.has(t) && t.t === r.t && days(t.d, r.d) <= 4 && Math.abs(t.amt - r.amt) <= Math.max(1, Math.abs(r.amt) * 0.015));
      if (alt) { used.add(alt); conflicts.push({ stmt: r, ledger: alt }); fresh.splice(i, 1); }
    }
    // A typed Bonus row is only "not on the statement" when the statement itself prints Bonus lines for that stock; a cash
    // statement that shows no bonus line at all (no money moves) must not delete the owner's own Bonus rows.
    const stmtBonus = new Set(cand.filter((r) => r.t === 'Bonus').map((r) => (r.a || '').toLowerCase()));
    const ledgerOnly = pool.filter((t) => !used.has(t) && t.d >= from && t.d <= to && t.t !== 'Rebate' && (t.t !== 'Bonus' || stmtBonus.has((t.a || '').toLowerCase())));
    // kickbacks: compare the month's total with ledger rebates dated in the month; post only the difference
    const ledgerReb = tx.filter((t) => t.t === 'Rebate' && inWin(t.d)).reduce((s, t) => s + (t.amt || 0), 0);
    const trueUp = Math.round((kick - ledgerReb) * 100) / 100;
    if (st.fullMonth && Math.abs(trueUp) >= 0.05) fresh.push({ d: to, t: 'Rebate', amt: trueUp, acc: 'Main', src: 'statement', note: `Commission kickbacks true-up (statement ${kick.toFixed(2)} vs ledger ${ledgerReb.toFixed(2)})` });
    // holdings check at the snapshot date
    let holdings = null; const aliases = [];
    if (st.snapshot) {
      const sh = {};
      tx.concat(fresh).forEach((t) => { if (t.d <= to && t.a && (t.t === 'Buy' || t.t === 'Sell' || t.t === 'Bonus')) sh[t.a] = (sh[t.a] || 0) + (t.t === 'Sell' ? -1 : 1) * (t.q || 0); });
      holdings = st.snapshot.holdings.map((h) => {
        const a = bySym[h.ticker.toUpperCase()] || byLower[h.ticker.toLowerCase()] || (h.name && byLower[h.name.toLowerCase()]);
        const name = a ? a.name : h.ticker;
        const ledgerQty = sh[name] || 0;
        const o = { ticker: h.ticker, name, kind: h.kind, statementQty: h.qty, ledgerQty, value: h.value, ok: h.kind === 'fund' ? null : Math.abs(ledgerQty - h.qty) < 0.5 };
        if (!a) o.unresolved = true;
        if (o.ok === false) { const bh = bonusHint(h.qty, ledgerQty); if (bh) o.bonusHint = bh; }
        return o;
      });
      // A stock first seen on an invoice is booked under the invoice's wording with no ticker; the snapshot prints its
      // ticker and a different name. When a snapshot holding resolves to nothing and exactly one symbol-less ledger
      // stock holds the same share count on the snapshot date (and no other unresolved holding claims it), they are
      // the same security: the row is accepted and the alias is reported so the ticker can be recorded.
      const taken = new Set(holdings.filter((h) => !h.unresolved).map((h) => h.name));
      const loose = Object.keys(sh).filter((n) => { const a = byLower[n.toLowerCase()] || {}; return sh[n] > 0.5 && !taken.has(n) && !a.symbol && !a.fund && !a.proxy && !/^thndr/i.test(n); });
      const claims = {};
      holdings.forEach((h, i) => { if (h.unresolved && h.kind !== 'fund') { const c = loose.filter((n) => Math.abs(sh[n] - h.statementQty) < 0.5); if (c.length === 1) (claims[c[0]] = claims[c[0]] || []).push(i); } });
      Object.keys(claims).forEach((n) => {
        if (claims[n].length !== 1) return; // two snapshot rows would claim the same ledger stock: leave both unresolved
        const h = holdings[claims[n][0]], snapshotName = st.snapshot.holdings.find((x) => x.ticker === h.ticker).name || '';
        Object.assign(h, { name: n, ledgerQty: sh[n], ok: true, resolvedFrom: n }); delete h.bonusHint;
        aliases.push({ name: n, ticker: h.ticker, snapshotName });
      });
      holdings.forEach((h) => { delete h.unresolved; });
      Object.keys(sh).forEach((n) => { const a = byLower[n.toLowerCase()] || {}; if (sh[n] > 0.5 && !holdings.some((h) => h.name === n) && a.symbol !== 'SAVINGS' && !a.fund && !a.proxy) holdings.push({ ticker: a.symbol || n, name: n, kind: 'stock', statementQty: 0, ledgerQty: sh[n], value: 0, ok: false }); });
    }
    const month = st.month;
    const mk = (marks || {})[month] || {};
    // fund units are not on older snapshots: value them at their last traded NAV from the ledger / fund statement
    let fundValue = 0; const fundRows = [];
    const snapHasFunds = st.snapshot && st.snapshot.holdings.some((h) => h.kind === 'fund');
    if (st.snapshot && !snapHasFunds) {
      const u = {}, px = {};
      const superseded = new Set(conflicts.map((c) => c.ledger)); // the statement row replaces its mis-booked ledger twin
      PEsort(tx.filter((t) => !superseded.has(t)).concat(fresh).concat(conflicts.map((c) => c.stmt))).forEach((t) => {
        if (t.d > to || !t.a || (t.t !== 'Buy' && t.t !== 'Sell')) return;
        const a = byLower[t.a.toLowerCase()] || {};
        const isFund = t.acc === 'MF' || a.fund || a.proxy || /^thndr/i.test(t.a);
        if (!isFund) return;
        u[t.a] = (u[t.a] || 0) + (t.t === 'Buy' ? 1 : -1) * (t.q || 0); if (t.p) px[t.a] = t.p;
      });
      Object.keys(u).forEach((n) => { if (u[n] > 0.5 && px[n]) { fundRows.push({ name: n, units: u[n], nav: px[n], value: u[n] * px[n] }); fundValue += u[n] * px[n]; } });
    }
    const markProposal = st.fullMonth ? { month, cash: st.cash.end, securities: st.snapshot ? Math.round((st.snapshot.total + fundValue) * 100) / 100 : null, stocks: st.snapshot ? st.snapshot.total : null, fundValue, fundRows, fundsFromLedger: !!(st.snapshot && !snapHasFunds) } : null;
    return { month, from, to, fullMonth: st.fullMonth, fresh, matched, unknown, conflicts, ledgerOnly, trueUp, kick, holdings, aliases, markProposal,
      markDiff: markProposal ? { cash: mk.cash != null ? markProposal.cash - mk.cash : null, securities: mk.securities != null && markProposal.securities != null ? markProposal.securities - mk.securities : null, current: mk } : null,
      newAssets: fresh.filter((r) => r.newAsset).map((r) => r.newAsset) };
  }
  // A share count that is (n+1)/n (n = 1..50), 2 or 3 times the ledger's, within 0.1%, is what a bonus issue leaves behind.
  function bonusHint(statementQty, ledgerQty) {
    if (!(ledgerQty > 0) || !(statementQty > ledgerQty)) return null;
    const ratio = statementQty / ledgerQty, off = (x) => Math.abs(ratio / x - 1);
    // the closest candidate wins: for large n the neighbours (49/48, 51/50) are all within 0.1% of each other
    let kind = null, best = 0.001;
    for (let n = 1; n <= 50; n++) if (off((n + 1) / n) <= best) { best = off((n + 1) / n); kind = `1-for-${n}`; }
    if (off(3) <= best) { best = off(3); kind = '2-for-1'; }
    if (!kind) return null;
    const x = Math.round((statementQty - ledgerQty) * 10000) / 10000;
    return `looks like a ${kind} bonus issue: add a Bonus row of ${x} shares dated before the snapshot`;
  }
  function PEsort(rows) { return rows.map((t, i) => ({ t, i })).sort((a, b) => (a.t.d < b.t.d ? -1 : a.t.d > b.t.d ? 1 : a.i - b.i)).map((x) => x.t); }
  function addDays(d, k) { const t = new Date(Date.parse(d) + k * 864e5); return t.toISOString().slice(0, 10); }

  // ---------- account lock ----------
  // A Thndr document is used only when its header names THIS portfolio's account: statements and position snapshots carry
  // "Unified Code <customer number>" and the holder's name; invoices carry the holder's name on their first line.
  // settings.account = { unifiedCode, holder }. The code is definitive when both sides have one; otherwise the holder's
  // whole name must appear in the header as one contiguous phrase (whitespace-normalised, case-insensitive; the words
  // scattered around the header are not enough). Thndr's account statement prints the name in a left column with
  // "Start Balance n" / "Name" / "End Balance n" from the right column interleaved between its lines, so those fixed
  // labels are removed before the phrase test. A portfolio with neither set imports nothing.
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  // The holder name as typed matches when it is printed as it is, or (two words or more) when its words appear in the
  // header in the same order within a few words of each other: "Khaled Amin" matches "Khaled Samer Adel Amin", the full
  // legal name Thndr prints, since people type the short name they go by.
  function holderSeenIn(head, holder) {
    const h = norm(head.replace(/\b(Start|End) Balance\s*-?[\d,]+(?:\.\d+)?/gi, ' ').replace(/(^|\s)Name(?=\s|$)/g, ' '));
    const want = norm(holder);
    if (!want) return false;
    if ((' ' + h + ' ').includes(' ' + want + ' ')) return true;
    const w = want.split(' ').filter(Boolean), t = h.split(' ');
    if (w.length < 2) return false;
    for (let i = 0; i < t.length; i++) {
      if (t[i] !== w[0]) continue;
      let k = 1;
      for (let j = i + 1; j < t.length && j <= i + 7 && k < w.length; j++) if (t[j] === w[k]) k++;
      if (k === w.length) return true;
    }
    return false;
  }
  function accountOf(docs, holder) {
    const heads = (docs || []).map((d) => ((d && d.lines) || d || []).slice(0, 10).join(' ').replace(/\s+/g, ' '));
    const codes = [...new Set(heads.map((h) => (h.match(/Unified Code\s*(\d{4,})/i) || [])[1]).filter(Boolean))];
    const head = heads.join(' | ');
    return { codes, code: codes[0] || null, head, holderSeen: holderSeenIn(head, holder) };
  }
  function ownerCheck(docs, settings) {
    const acc = (settings && settings.account) || {};
    const code = String(acc.unifiedCode || '').trim(), holder = String(acc.holder || '').trim();
    const a = accountOf(docs, holder);
    const r = { code: a.code, holderSeen: a.holderSeen, error: null };
    if (!code && !holder) r.error = 'cannot be used: this portfolio has no Thndr account holder set (Inputs → Settings → Thndr account)';
    else if (a.codes.length > 1) r.error = `mixes Thndr accounts ${a.codes.join(' and ')}`;
    else if (code && a.code) { if (a.code !== code) r.error = `belongs to Thndr account ${a.code}, not this portfolio's account ${code}`; }
    else if (holder) {
      if (!a.holderSeen) {
        // the name Thndr printed: "... Currency EGP <name> Start Balance" (statement), "Invoice <name> Custodian:" (invoice)
        const other = [/Currency\s+[A-Z]{3}\s+(.+?)\s+Start Balance/i, /Invoice\s+(.+?)\s+Custodian/i, /Client Name\s+(.+?)\s+Unified Code/i]
          .map((re) => (a.head.match(re) || [])[1]).find(Boolean);
        r.error = `is not in the name of ${holder}` + (other && other.length <= 60 ? ` (it is in the name of ${other.trim()})` : ` (its header reads "${a.head.slice(0, 100)}")`);
      }
    }
    else r.error = 'has no Unified Code in its header, so the account could not be confirmed';
    return r;
  }

  // Tracking start (settings.trackFrom, set for accounts made on the site): the opening rows typed at sign-up stand for
  // everything up to and including that day, so a statement is used from the next day only (null when it ends before).
  function fromTrackStart(st, tf) {
    if (!tf || !st || !st.cash || st.from > tf) return st;
    if (st.to <= tf) return null;
    const d = new Date(Date.parse(tf + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10), keep = (r) => r.date && r.date >= d;
    return Object.assign({}, st, { from: d, cash: Object.assign({}, st.cash, { start: null, rows: st.cash.rows.filter(keep) }), mf: st.mf ? Object.assign({}, st.mf, { rows: st.mf.rows.filter(keep) }) : st.mf });
  }

  const api = { attachments, pdfLines, parseDoc, parseStatement, reconcile, classify, accountRows, accountOf, ownerCheck, authCheck, eom, fromTrackStart };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TS = api;
})(this);
