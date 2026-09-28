// Excel-parity check: runs the engine over the private fixture seed.json (Khaled's ledger as extracted from the original
// workbook) and compares the headline figures with the workbook's, which live in the private fixture expected.json
// ({stats:{twr,...}, mvTotal, unreal, sameDay}). Both files hold real portfolio data and are NOT in the repository:
// put copies next to this file (src/tests/seed.json, src/tests/expected.json - gitignored) or point SEED_JSON /
// EXPECTED_JSON at them. Without them this prints one line and exits 0; with them, exit 1 on any mismatch.
const fs = require('fs'), path = require('path');
const PE = require('../engine.js');
const seedPath = process.env.SEED_JSON || path.join(__dirname, 'seed.json'), expPath = process.env.EXPECTED_JSON || path.join(__dirname, 'expected.json');
const absent = [seedPath, expPath].filter((p) => !fs.existsSync(p));
if (absent.length) { console.log('seed.json not present — the Excel-parity fixture is private (set SEED_JSON and EXPECTED_JSON to run it). Nothing checked, exit 0. Missing: ' + absent.map((p) => path.basename(p)).join(', ')); process.exit(0); }
const seed = JSON.parse(fs.readFileSync(seedPath)), X = JSON.parse(fs.readFileSync(expPath));
const marks={}; seed.marks.forEach(m=>{const {month,...r}=m; for(const k in r) if(r[k]===null) delete r[k]; marks[month]=r;});
const assets={}; seed.assets.forEach(a=>{const r={...a}; for(const k in r) if(r[k]===null) delete r[k]; assets[a.name]=r;});
const data={settings:seed.settings,marks,assets,tx:seed.tx};
// Workbook conventions so the parity figures stay exact: flowTiming:'start' = every flow on day 1 (the page defaults to Modified
// Dietz); sameDay:'ledger' = rows kept in statement order inside a day (the workbook books a same-day sell before its buy; the
// page orders buys first, which shifts realized/closedPL for that name); closedTrades:'name' = the workbook's one-row-per-stock
// closed-trade stats (the page defaults to round trips, cash-like funds excluded).
const R=PE.run(data,{type:'Since Inception',asOf:'2026-08'},{today:'2026-09-27',live:false,flowTiming:'start',sameDay:'ledger',closedTrades:'name'});
const S=R.stats;
const exp=X.stats;
let bad=0; for(const k in exp){const d=Math.abs(S[k]-exp[k]); const ok=d<1e-6*Math.max(1,Math.abs(exp[k])); if(!ok){bad++;} console.log(ok?'ok ':'BAD',k.padEnd(14),S[k],exp[k]);}
console.log('best',S.best,'worst',S.worst,'mdd',S.maxDDMonth,'risk',S.risk,'label',S.label);
const unreal=R.pos.open.reduce((s,r)=>s+r.unreal,0);
for (const [label, got, want] of [['MV', R.pos.mvTotal, X.mvTotal], ['unreal', unreal, X.unreal]]) { const ok = Math.abs(got - want) < 0.005; if (!ok) bad++; console.log(ok?'ok ':'BAD', label.padEnd(14), got, want); }
console.log(R.conc, R.sectors.map(s=>s.sector+' '+s.weight.toFixed(4)).join(' | '));
console.log(R.checks); console.log('BAD',bad);
process.exit(bad ? 1 : 0);
