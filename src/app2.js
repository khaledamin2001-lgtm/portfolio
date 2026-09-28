// =====================================================================
// Analytics pages: daily valuation, attribution, income, factsheet, statements
// =====================================================================
const GMAIL = 'Gmail', REMOTE = 'Claude Code Remote';
// ---------- portfolio switcher (the page title): both pages belong to the same Claude account ----------
const PORTFOLIOS = [
  { id: 'khaled', name: 'Khaled Investment Portfolio', url: 'https://claude.ai/artifact/PNjUN5wQkvgtZDcTML1HFe' },
  { id: 'yassin', name: 'Yassin Investment Portfolio', url: 'https://claude.ai/artifact/6VL6yHnoUHkNqP1PdzRazc' },
];
function currentPortfolioId(){ return S.settings.portfolioId || (PORTFOLIOS.find(p=>p.name===S.settings.name)||{}).id || null; }
function renderSwitch(){
  const cur = currentPortfolioId(), m = $('#pf-menu'); if(!m) return;
  m.innerHTML = PORTFOLIOS.map(p=>{ const isCur = p.id===cur;
    if(window.pdSelect) return `<button type="button" data-pid="${p.id}" class="${isCur?'cur':''}" data-testid="switch-${p.id}">${esc(p.name)}<small>${isCur?'open now':'switch on this site'}</small></button>`;
    return isCur ? `<button type="button" class="cur" data-testid="switch-${p.id}">${esc(p.name)}<small>this page</small></button>`
                 : `<a href="${p.url}" data-testid="switch-${p.id}">${esc(p.name)}<small>opens its Claude page</small></a>`; }).join('');
}
document.addEventListener('click', e=>{
  const menu = $('#pf-menu'); if(!menu) return;
  if(e.target.closest('#pf-name')){ renderSwitch(); menu.hidden = !menu.hidden; $('#pf-name').setAttribute('aria-expanded', String(!menu.hidden)); return; }
  const b = e.target.closest('#pf-menu [data-pid]'); if(b){ menu.hidden = true; if(window.pdSelect) window.pdSelect(b.dataset.pid); return; }
  if(!e.target.closest('#pf-menu')){ menu.hidden = true; $('#pf-name').setAttribute('aria-expanded','false'); }
});
document.addEventListener('keydown', e=>{ if(e.key!=='Escape') return; const menu=$('#pf-menu'); if(!menu || menu.hidden) return; menu.hidden=true; const b=$('#pf-name'); if(b){ b.setAttribute('aria-expanded','false'); b.focus(); } });
let pbMemo = { h: null, pb: null };
function pbook(){ if(pbMemo.h !== S.history){ pbMemo = { h: S.history, pb: PA.priceBook(S.history) }; } return pbMemo.pb; }
const AN = { key: null, v: {} };
function an(name, fn){ if(AN.key !== S.R){ AN.key = S.R; AN.v = {}; } if(!(name in AN.v)){ try{ AN.v[name] = fn(); }catch(e){ console.error(name, e); AN.v[name] = null; } } return AN.v[name]; }
// recompute() already built the daily series for the engine (opts.daily); reuse it rather than valuing every session twice
const dailyA = () => an('daily', () => S.D !== undefined ? S.D : PA.daily(S.settings, S.R.ledger, S.assets, pbook(), S.marks, S.R.today));
const dailyS = () => an('dstats', () => PA.dailyStats(dailyA(), S.R.range));
const attrA = () => an('attr', () => PA.attribution(S.R.months, S.R.range, S.R.ledger, S.assets, pbook(), S.bench, S.R.today));
const activeA = () => an('active', () => PA.activeWeights(S.R.pos, S.bench, pbook(), S.R.liveCash ?? S.settings.cash));
const incomeA = () => an('income', () => PA.income(S.R.ledger, S.assets, S.R.pos, S.market, S.R.today));
const S3 = () => cssVar('--s3');
const dshort = (d) => { const [y,m,dd]=d.split('-'); return `${+dd} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m-1]}`; };
function hbars(items, fmt){ // diverging horizontal bars around zero
  const max = Math.max(1e-9, ...items.map(i=>Math.abs(i.v)));
  return `<div style="display:grid;gap:8px">${items.map(i=>`<div style="display:grid;grid-template-columns:minmax(110px,32%) 1fr auto;gap:10px;align-items:center"><span class="${i.bold?'':'ink2'}" style="${i.bold?'font-weight:600':''}">${esc(i.label)}</span>
    <div style="position:relative;height:12px;background:var(--surface-2);border-radius:3px"><span style="position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:var(--ink-3)"></span><i style="position:absolute;top:0;bottom:0;border-radius:3px;background:${i.v>=0?'var(--pos)':'var(--neg)'};${i.v>=0?`left:50%;width:${(i.v/max*50).toFixed(2)}%`:`right:50%;width:${(-i.v/max*50).toFixed(2)}%`}"></i></div>
    <span class="num ${sgn(i.v)}" style="min-width:64px;text-align:right;${i.bold?'font-weight:700':''}">${fmt(i.v)}</span></div>`).join('')}</div>`; }

// ---------- Performance: daily section ----------
function dailySection(){
  const D = dailyA(), ds = dailyS();
  if(!D || !ds) return `<div class="panel"><h2>Daily performance</h2><p class="muted">Daily closing prices are not available for this period yet.</p></div>`;
  const rows = ds.rows; const labels = rows.map(r=>dshort(r.d));
  const off = D.recon.filter(r=>Math.abs(r.pct)>0.01);
  return `
  <div class="panel"><div class="phead"><div><h2>Daily growth vs ${BENCH}</h2><div class="sub">Valued every EGX session from the ledger and closing prices · ${ds.n} sessions</div></div>
    <div class="legend"><span><i style="background:var(--s1)"></i>Portfolio ${pct(ds.twr)}</span><span><i style="background:var(--s2)"></i>EGX30 Capped ${pct(ds.bench)}</span></div></div>
    ${chartSlot('ch-daily',{kind:'line',title:'Daily cumulative return',labels,series:[{name:'Portfolio',color:C.s1(),values:rows.map(r=>r.cum)},{name:'EGX30 Capped',color:C.s2(),values:rows.map(r=>r.bcum)}],yFmt:pctAxis,minZero:false,tipLabel:i=>dfmt(rows[i].d),tipExtra:i=>`<div>Value <b>${egp(rows[i].value)} EGP</b></div>`},270)}
    ${chartSlot('ch-uw',{kind:'line',title:'Underwater chart',labels,series:[{name:'Drawdown',color:C.neg(),values:rows.map(r=>r.dd),area:true}],yFmt:pctAxis,tipLabel:i=>dfmt(rows[i].d)},150)}
    <div class="grid g3" style="margin-top:14px;gap:0 24px"><dl class="kv"><dt>Max drawdown (daily)</dt><dd class="neg">${pct(ds.maxDD)}</dd><dt>Peak → trough</dt><dd>${ds.ddPeak?dfmt(ds.ddPeak)+' → '+dfmt(ds.ddTrough):'—'}</dd><dt>Recovered</dt><dd>${ds.ddTrough?(ds.recovered?dfmt(ds.recovered):'Not yet'):'—'}</dd></dl>
      <dl class="kv"><dt>Volatility (annualized)</dt><dd>${pct(ds.volAnn,1,false)}</dd><dt>EGX30 Capped volatility</dt><dd>${pct(ds.benchVolAnn,1,false)}</dd><dt>Downside deviation</dt><dd>${pct(ds.downsideDevAnn,1,false)}</dd></dl>
      <dl class="kv"><dt>Best session</dt><dd class="pos">${pct(ds.best.r,2)} · ${dfmt(ds.best.d)}</dd><dt>Worst session</dt><dd class="neg">${pct(ds.worst.r,2)} · ${dfmt(ds.worst.d)}</dd><dt>Up sessions</dt><dd>${pct(ds.upDays,0,false)}</dd></dl></div>
    <p class="note" style="margin:10px 0 0">The official return above chain-links statement month-ends. This daily series revalues the ledger at each close, so it also shows drawdowns inside a month. Funds without a market quote are carried at their last traded NAV; gold funds move with the 24K gold price.</p></div>
  <div class="panel"><div class="phead"><div><h2>Month-end check: closing prices vs your marks</h2><div class="sub">Ledger holdings × closing prices + ledger cash, against the month-end values you entered</div></div>${off.length?`<span class="chip warn">${off.length} month${off.length>1?'s':''} differ by more than 1%</span>`:'<span class="chip ok">All within 1%</span>'}</div>
    <div class="tbl"><table data-testid="recon-table"><thead><tr><th>Month</th><th>Last session</th><th class="n">From prices</th><th class="n">Your mark</th><th class="n">Difference</th><th class="n">%</th></tr></thead><tbody>
    ${D.recon.map(r=>`<tr><td>${M(r.month)}</td><td>${dfmt(r.day)}</td><td class="n">${egp(r.model)}</td><td class="n">${egp(r.marks)}</td><td class="n ${Math.abs(r.pct)>0.01?'neg':''}">${egp(r.diff)}</td><td class="n">${Math.abs(r.pct)>0.01?`<span class="pill stale">${pct(r.pct,2)}</span>`:pct(r.pct,2)}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="note" style="margin:10px 0 0">Large gaps usually mean the month-end mark was typed as a round number. Posting the Thndr statement (Settings → Statements &amp; imports) replaces it with the exact figure from the positions snapshot.</p></div>`;
}

// ---------- Attribution ----------
function vAttribution(){
  const A = attrA(), AW = activeA();
  if(!S.bench) return `<div class="panel empty"><h2>Index data not loaded yet</h2></div>`;
  if(!A) return `<div class="panel empty"><h2>No attribution for this selection</h2><p>Attribution needs month-end closes for the months in the period.</p></div>`;
  // engine note on what the Trading residual holds (dividends, rebates and fees as well as intra-month trades); older engines have none
  const tNote = A.tradingNote || (typeof PA.TRADING_NOTE==='string' ? PA.TRADING_NOTE : null);
  const effects=[{label:'Sector allocation',v:A.alloc},{label:'Stock selection',v:A.sel},{label:tNote?'Trading and other':'Trading during the month',v:A.trading},{label:'Index model gap',v:A.replication},{label:'Active return',v:A.active,bold:true}];
  const labels=A.months.map(m=>Ms(m.month));
  const rms=A.trackingCheck;
  return `
  <div class="kpis">
    ${kpi('Active return', `<span class="${sgn(A.active)}">${pct(A.active)}</span>`, `Portfolio ${pct(A.R)} vs EGX30 Capped ${pct(A.B)}`,'hero')}
    ${kpi('Sector allocation', `<span class="${sgn(A.alloc)}">${pct(A.alloc,2)}</span>`, 'being in the right sectors')}
    ${kpi('Stock selection', `<span class="${sgn(A.sel)}">${pct(A.sel,2)}</span>`, 'picking better stocks within sectors')}
    ${kpi(tNote?'Trading and other':'Trading during the month', `<span class="${sgn(A.trading)}">${pct(A.trading,2)}</span>`, tNote?esc(tNote.replace(/^Trading and other:\s*/,'')):'buys and sells after month start')}
    ${kpi('Index model gap', `<span class="${sgn(A.replication)}">${pct(A.replication,2)}</span>`, `model vs real index · ${pct(rms,2,false)}/mo RMS`)}
  </div>
  <div class="grid g2">
    <div class="panel"><div class="phead"><div><h2>Where the active return came from</h2><div class="sub">${esc(S.R.stats.label)} · Brinson-Fachler, linked across months</div></div></div>
      ${hbars(effects, v=>pct(v,2))}
      ${tNote?`<p class="note" style="margin:10px 0 0" data-testid="attribution-trading-note">${esc(tNote)}.</p>`:''}
      <p class="note" style="margin:12px 0 0">The four effects add up exactly to the active return. Allocation and selection assume you held the prior month-end positions all month; everything your trades changed inside the month lands in trading.</p></div>
    <div class="panel"><div class="phead"><div><h2>Sector bets today</h2><div class="sub">Your weight minus EGX30 Capped weight · ${AW?dfmt(AW.date):''}</div></div></div>
      ${AW?hbars(AW.rows.filter(r=>Math.abs(r.active)>0.001).map(r=>({label:r.sector,v:r.active})), v=>(v>=0?'+':'−')+(Math.abs(v)*100).toFixed(1)+' pp'):'<p class="muted">—</p>'}</div>
  </div>
  <div class="panel"><div class="phead"><div><h2>Effects by sector</h2><div class="sub">Average weights over the period; returns are linked monthly returns while held</div></div></div>
    <div class="tbl"><table data-testid="attribution-sector-table"><thead><tr><th>Sector</th><th class="n">Your weight</th><th class="n">Index weight</th><th class="n">Active weight</th><th class="n">Your return</th><th class="n">Index return</th><th class="n">Allocation</th><th class="n">Selection</th><th class="n">Total</th></tr></thead><tbody>
    ${A.sectors.map(s=>`<tr><td>${esc(s.sector)}</td><td class="n">${pct(s.wp,1,false)}</td><td class="n">${pct(s.wb,1,false)}</td><td class="n ${sgn(s.wp-s.wb)}">${((s.wp-s.wb)*100).toFixed(1).replace('-','−')} pp</td><td class="n">${s.rp!=null?pct(s.rp):'—'}</td><td class="n">${s.rb!=null?pct(s.rb):'—'}</td><td class="n ${sgn(s.alloc)}">${pct(s.alloc,2)}</td><td class="n ${sgn(s.sel)}">${pct(s.sel,2)}</td><td class="n ${sgn(s.total)}"><b>${pct(s.total,2)}</b></td></tr>`).join('')}
    </tbody><tfoot><tr><td>Total</td><td class="n">100%</td><td class="n">100%</td><td></td><td class="n">${pct(A.months.reduce((a,m)=>a*(1+m.Rh),1)-1)}</td><td class="n">${pct(A.months.reduce((a,m)=>a*(1+m.Bs),1)-1)}</td><td class="n">${pct(A.alloc,2)}</td><td class="n">${pct(A.sel,2)}</td><td class="n">${pct(A.alloc+A.sel,2)}</td></tr></tfoot></table></div></div>
  <div class="panel"><div class="phead"><div><h2>Monthly effects</h2><div class="sub">Each month's contribution to active return, before linking</div></div>
    <div class="legend"><span><i class="sq" style="background:var(--s1)"></i>Allocation</span><span><i class="sq" style="background:var(--s2)"></i>Selection</span><span><i class="sq" style="background:var(--s3)"></i>Trading</span></div></div>
    ${chartSlot('ch-attr',{kind:'bar',title:'Monthly attribution',labels,series:[{name:'Allocation',color:C.s1(),values:A.months.map(m=>m.alloc)},{name:'Selection',color:C.s2(),values:A.months.map(m=>m.sel)},{name:'Trading',color:S3(),values:A.months.map(m=>m.trading)}],yFmt:pctAxis,tipExtra:i=>`<div>Active <b>${pct(A.months[i].R-A.months[i].B,2)}</b></div>`},250)}
    <div class="tbl" style="margin-top:12px"><table><thead><tr><th>Month</th><th class="n">Portfolio</th><th class="n">EGX30 Capped</th><th class="n">Active</th><th class="n">Allocation</th><th class="n">Selection</th><th class="n">Trading</th><th class="n">Model gap</th><th class="n">Model index</th></tr></thead><tbody>
    ${A.months.map(m=>`<tr><td>${M(m.month)}${m.live?' <span class="pill prov">Live</span>':''}</td><td class="n ${sgn(m.R)}">${pct(m.R)}</td><td class="n ${sgn(m.B)}">${pct(m.B)}</td><td class="n ${sgn(m.R-m.B)}">${pct(m.R-m.B,2)}</td><td class="n">${pct(m.alloc,2)}</td><td class="n">${pct(m.sel,2)}</td><td class="n">${pct(m.trading,2)}</td><td class="n">${pct(m.replication,2)}</td><td class="n">${pct(m.Bs)}</td></tr>`).join('')}
    </tbody></table></div></div>
  <div class="grid g2">
    <div class="panel"><div class="phead"><div><h2>EGX30 Capped model weights</h2><div class="sub">Free-float market cap, each stock capped at ${pct((S.bench.capWeight||0.15),0,false)}</div></div></div>
      <div class="tbl"><table><thead><tr><th>Symbol</th><th>Company</th><th>Sector</th><th class="n">Weight</th><th class="n">You hold</th></tr></thead><tbody>
      ${(AW?AW.members:[]).slice(0,30).map(m=>{ const h=S.R.pos.open.find(r=>r.symbol===m.s); return `<tr><td><span class="sym">${esc(m.s)}</span></td><td>${esc(m.name)}</td><td class="ink2">${esc(m.sector)}</td><td class="n">${pct(m.w,1,false)}</td><td class="n">${h?pct(h.weight,1,false):'—'}</td></tr>`; }).join('')}
      </tbody></table></div></div>
    <div class="panel"><div class="phead"><div><h2>How this is calculated</h2></div></div><div class="prose">
      <p>Each month starts from your holdings and cash at the previous month-end and compares them with a model of EGX30 Capped built from today's 30 constituents at their free-float weights.</p>
      <p><b>Allocation</b> = (your sector weight − index weight) × (index sector return − index return). Idle cash counts as a 0% sector, so holding cash in a rising market shows here.</p>
      <p><b>Selection</b> = your sector weight × (your sector return − index sector return). Sectors the index does not hold (Media, Textiles, Education) are compared with the whole index.</p>
      <p><b>Trading</b> = your actual monthly return − the return of the month-start holdings. <b>Index model gap</b> = model index return − published EGX30 Capped return. It exists because constituents and free-float counts change at each index review.</p>
      <p>Monthly effects are linked with the Carino method so they sum to the period's active return.</p></div></div>
  </div>`;
}

// ---------- Income ----------
function vIncome(){
  const I = incomeA(); if(!I) return `<div class="panel empty"><h2>No income data</h2></div>`;
  const net = I.totals.div + I.totals.reb + I.totals.fee;
  const costsByYear = {}; (S.R.ledger||[]).forEach(r=>{ const c=costOf(r); if(c) costsByYear[String(r.d).slice(0,4)] = (costsByYear[String(r.d).slice(0,4)]||0) + c; });
  const months=[]; I.years.forEach(Y=>Y.div.forEach((v,i)=>{ const m=`${Y.year}-${String(i+1).padStart(2,'0')}`; if(m>=S.settings.inception && m<=PE.monthOf(S.R.today)) months.push({m, div:Y.div[i], reb:Y.reb[i], fee:Y.fee[i]}); }));
  return `
  <div class="kpis">
    ${kpi('Dividends received', egp(I.totals.div), `since first trade`, 'hero', 'EGP')}
    ${kpi('Dividends, last 12 months', egp(I.ttmDiv), `${pct(S.R.pos.mvTotal? I.ttmDiv/S.R.pos.mvTotal:null,2,false)} of holdings value`, '', 'EGP')}
    ${kpi('Commission rebates', egp(I.totals.reb), 'Thndr kickbacks and incentives', '', 'EGP')}
    ${kpi('Fees paid', `<span class="neg">${egp(I.totals.fee)}</span>`, 'subscriptions, custody, transfers', '', 'EGP')}
    ${kpi('Net income', `<span class="${sgn(net)}">${egp(net)}</span>`, 'dividends + rebates − fees', '', 'EGP')}
    ${kpi('Expected dividends, next 12 months', egp(I.estAnnual), `at current yields · covers ${pct(I.estCoverage,0,false)} of holdings`, '', 'EGP')}
  </div>
  <div class="panel"><div class="phead"><div><h2>Income by month</h2><div class="sub">Cash credited to the account</div></div>
    <div class="legend"><span><i class="sq" style="background:var(--s1)"></i>Dividends</span><span><i class="sq" style="background:var(--s2)"></i>Rebates</span></div></div>
    ${chartSlot('ch-income',{kind:'bar',title:'Monthly income',labels:months.map(x=>Ms(x.m)),series:[{name:'Dividends',color:C.s1(),values:months.map(x=>x.div)},{name:'Rebates',color:C.s2(),values:months.map(x=>x.reb)}],yFmt:egpAxis,tipExtra:i=>`<div>Fees <b>${egp(months[i].fee)} EGP</b></div>`},230)}</div>
  <div class="grid g2">
    <div class="panel"><div class="phead"><div><h2>Dividends by stock</h2><div class="sub">Every dividend received, including stocks you have sold</div></div></div>
      <div class="tbl"><table data-testid="dividends-table"><thead><tr><th>Stock</th><th class="n">Payments</th><th class="n">Total</th><th class="n">Last 12 months</th><th>Last paid</th></tr></thead><tbody>
      ${I.perAsset.map(x=>`<tr><td>${x.symbol?`<span class="sym">${esc(x.symbol)}</span> `:''}<span class="ink2">${esc(x.name)}</span></td><td class="n">${x.count}</td><td class="n">${egp(x.total)}</td><td class="n">${egp(x.ttm)}</td><td>${dfmt(x.last)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No dividends yet.</td></tr>'}
      </tbody><tfoot><tr><td>Total</td><td class="n">${I.perAsset.reduce((s,x)=>s+x.count,0)}</td><td class="n">${egp(I.totals.div)}</td><td class="n">${egp(I.ttmDiv)}</td><td></td></tr></tfoot></table></div></div>
    <div class="panel"><div class="phead"><div><h2>Income from what you hold</h2><div class="sub">Yield on cost uses dividends received in the last 12 months</div></div></div>
      <div class="tbl"><table data-testid="yield-table"><thead><tr><th>Symbol</th><th class="n">Value</th><th class="n">Received, 12m</th><th class="n">Yield on cost</th><th class="n">Dividend yield</th><th class="n">Expected 12m</th></tr></thead><tbody>
      ${I.holdings.map(h=>`<tr><td><span class="sym">${esc(h.symbol)}</span></td><td class="n">${egp(h.mv)}</td><td class="n">${egp(h.ttm)}</td><td class="n">${h.yoc!=null?pct(h.yoc,2,false):'—'}</td><td class="n">${h.dy!=null?pct(h.dy,2,false):'—'}</td><td class="n">${h.estIncome!=null?egp(h.estIncome):'—'}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="note" style="margin:10px 0 0">Dividend yield is TradingView's trailing yield, refreshed with prices after each session. Expected income is an estimate, not a declared dividend.</p></div>
  </div>
  ${declaredDividends()}
  <div class="panel"><div class="phead"><div><h2>Yearly summary</h2><div class="sub">Trading costs are the commission inside each buy and sell (net amount minus price × shares); they are already in the trade amounts, so they are shown here, not deducted again</div></div></div>
    <div class="tbl"><table data-testid="income-yearly"><thead><tr><th>Year</th><th class="n">Dividends</th><th class="n">Rebates</th><th class="n">Fees</th><th class="n">Net income</th><th class="n">Trading costs</th></tr></thead><tbody>
    ${I.years.map(Y=>`<tr><td>${Y.year}</td><td class="n">${egp(Y.divT)}</td><td class="n">${egp(Y.rebT)}</td><td class="n neg">${egp(Y.feeT)}</td><td class="n ${sgn(Y.net)}"><b>${egp(Y.net)}</b></td><td class="n neg" data-testid="income-trading-costs">${egp(-(costsByYear[Y.year]||0))}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

function declaredDividends(){
  const q=(S.market&&S.market.quotes)||{}; const today=S.R.today; const rows=[];
  S.R.pos.open.forEach(r=>{ const x=r.symbol&&q[r.symbol]; if(!x) return;
    if(x.exDate&&x.divUp!=null&&x.exDate>=today) rows.push({sym:r.symbol,name:r.name,ex:x.exDate,ps:x.divUp,sh:r.open,status:'Declared · ex-date ahead'});
    else if(x.exRecent&&x.divRecent!=null&&PE.dayNum(today)-PE.dayNum(x.exRecent)<=45){ const got=S.R.ledger.some(t=>t.t==='Dividend'&&t.a&&(t.a===r.name||t.a===r.symbol)&&t.d>=x.exRecent); rows.push({sym:r.symbol,name:r.name,ex:x.exRecent,ps:x.divRecent,sh:r.open,status:got?'Credited':'Went ex · awaiting credit'}); } });
  rows.sort((a,b)=>a.ex.localeCompare(b.ex));
  return `<div class="panel" data-testid="declared-dividends"><div class="phead"><div><h2>Declared dividends on current holdings</h2><div class="sub">Ex-dates and amounts from TradingView, refreshed with prices · expected cash = shares held × dividend per share</div></div></div>
    ${rows.length?`<div class="tbl"><table><thead><tr><th>Position</th><th>Ex-date</th><th class="n">Per share</th><th class="n">Shares</th><th class="n">Expected EGP</th><th>Status</th></tr></thead><tbody>${rows.map(r=>`<tr><td><span class="sym">${esc(r.sym)}</span> <span class="ink2">${esc(r.name)}</span></td><td>${dfmt(r.ex)}</td><td class="n">${num(r.ps,3)}</td><td class="n">${num(r.sh,0)}</td><td class="n">${egp(r.ps*r.sh)}</td><td><span class="pill ${r.status==='Credited'?'win':'auto'}">${esc(r.status)}</span></td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">No dividend declared on a current holding in the last 45 days, and none announced ahead.</p>'}</div>`;
}

// ---------- Factsheet ----------
function factsheetData(m){
  const R = PE.run(dataset(true), {type:'Since Inception', asOf:m}, {today:S.R.today, fallback:S.fallback});
  const live = R.live && R.live.month === m;
  const pb = pbook();
  const tr = PA.trailing(R.months, m), cal = PA.calendar(R.months, m);
  const H = live ? { rows: R.pos.open.map(r=>({name:r.name,symbol:r.symbol,sector:r.sector,mv:r.mv})), mv:R.pos.mvTotal, cash:R.liveCash ?? S.settings.cash } : PA.holdingsAt(R.ledger, S.assets, pb, PE.eom(m));
  const cash = live ? (R.liveCash ?? S.settings.cash) : (S.marks[m] && S.marks[m].cash != null ? S.marks[m].cash : H.cash);
  const tot = H.mv + Math.max(0,cash);
  const top = H.rows.filter(r=>r.mv).sort((a,b)=>b.mv-a.mv).slice(0,10).map(r=>({...r, w:r.mv/tot}));
  const secW = {}; H.rows.forEach(r=>{ if(r.mv) secW[r.sector]=(secW[r.sector]||0)+r.mv/tot; }); if(cash>0) secW['Cash & Savings']=(secW['Cash & Savings']||0)+cash/tot;
  const bd = pb.lastDayOnOrBefore(live ? S.R.today : PE.eom(m)); const bw = bd ? PA.benchWeights(S.bench, pb, bd) || [] : [];
  const secB = {}; bw.forEach(x=>{ secB[x.sector]=(secB[x.sector]||0)+x.w; });
  const sectors = [...new Set([...Object.keys(secW),...Object.keys(secB)])].map(s=>({s, p:secW[s]||0, b:secB[s]||0})).sort((a,b)=>b.p-a.p);
  const A1 = PA.attribution(R.months, {from:m,to:m}, R.ledger, S.assets, pb, S.bench, S.R.today);
  const y = m.slice(0,4);
  const Ay = PA.attribution(R.months, {from:(y+'-01')>S.settings.inception?y+'-01':S.settings.inception,to:m}, R.ledger, S.assets, pb, S.bench, S.R.today);
  const inc = (from,to)=>{ const s={div:0,reb:0,fee:0}; R.ledger.forEach(t=>{ if(t.d>=from&&t.d<=to){ if(t.t==='Dividend')s.div+=t.amt; if(t.t==='Rebate')s.reb+=t.amt; if(t.t==='Fee')s.fee+=t.amt; } }); return s; };
  const row = R.months.find(r=>r.month===m);
  let ddDaily = null; try{ const ds = PA.dailyStats(dailyA(), R.range); ddDaily = ds ? ds.maxDD : null; }catch(e){ console.error(e); }
  return { m, R, st:R.stats, row, live, tr, cal, top, sectors, A1, Ay, ddDaily, value: row?row.value:tot, incM: inc(m+'-01',PE.eom(m)), incY: inc(y+'-01',PE.eom(m)) };
}
function factsheetHTML(F){
  const ink='#0F1A17', ink2='#46534E', ink3='#5F6C67', rule='#DAE2DE', acc='#0B6E5F', pos='#137a3a', neg='#c02f2f', bg2='#EDF2EF';
  const col=(x)=>x==null?ink3:x>0?pos:x<0?neg:ink; const P=(x,dp=1)=>`<span style="color:${col(x)}">${pct(x,dp)}</span>`;
  const th=(t,al='right')=>`<th style="text-align:${al};font:600 10px Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:${ink3};padding:6px 8px;border-bottom:1px solid ${rule}">${t}</th>`;
  const td=(t,al='right',extra='')=>`<td style="text-align:${al};padding:6px 8px;border-bottom:1px solid ${bg2};font:13px Arial,sans-serif;color:${ink};${extra}">${t}</td>`;
  const h2=(t)=>`<h2 style="font:600 15px Georgia,serif;color:${ink};margin:22px 0 8px">${t}</h2>`;
  const st=F.st, set=S.settings;
  const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fact=(l,v,sub)=>`<td style="padding:10px 12px;border:1px solid ${rule};vertical-align:top;width:16.6%"><div style="font:600 10px Arial;letter-spacing:.06em;text-transform:uppercase;color:${ink3}">${l}</div><div style="font:600 19px Georgia,serif;color:${ink};margin-top:4px">${v}</div>${sub?`<div style="font:11px Arial;color:${ink2};margin-top:2px">${sub}</div>`:''}</td>`;
  const small = smallSample(st), ind = small ? ` <span style="font:600 9px Arial;letter-spacing:.04em;text-transform:uppercase;color:${ink3}">indicative</span>` : '';
  const incM = +String(set.inception||'').slice(5,7), incY = String(set.inception||'').slice(0,4);   // a first calendar year that starts after January is partial
  const eff = (A)=> A ? `${P(A.active,2)} = allocation ${P(A.alloc,2)} + selection ${P(A.sel,2)} + trading ${P(A.trading,2)} + model gap ${P(A.replication,2)}` : '—';
  // border-box: the card is 760px wide overall (padding included), so it fits an A4 PDF page (186 mm ≈ 703px) and email panes
  const thM=(t,al='right',w='')=>`<th style="text-align:${al};font:600 9.5px Arial,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:${ink3};padding:6px 2px;border-bottom:1px solid ${rule};${w?`width:${w};`:''}">${t}</th>`;
  const tdM=(t,al='right',extra='')=>`<td style="text-align:${al};padding:6px 2px;border-bottom:1px solid ${bg2};font:11.5px Arial,sans-serif;color:${ink};white-space:nowrap;${extra}">${t}</td>`;
  const PN=(x)=>x==null?'':`<span style="color:${col(x)}">${pct(x).replace('%','')}</span>`;   // monthly grid: the header says %, cells carry the number only
  return `<div style="box-sizing:border-box;width:100%;max-width:760px;margin:0 auto;background:#fff;color:${ink};font:13px Arial,sans-serif;padding:28px 30px;border:1px solid ${rule}">
  <table role="presentation" width="100%" style="border-collapse:collapse"><tr><td style="border-bottom:3px solid ${acc};padding-bottom:10px">
    <div style="font:600 11px Arial;letter-spacing:.1em;text-transform:uppercase;color:${acc}">Monthly factsheet · ${M(F.m)}${F.live?' (month to date)':''}</div>
    <div style="font:600 24px Georgia,serif;color:${ink};margin-top:4px">${esc(set.name)}</div>
    <div style="font:12px Arial;color:${ink2};margin-top:2px">Egyptian equities via Thndr · Benchmark ${BENCH} · Reporting currency EGP · Inception ${M(set.inception)}</div></td></tr></table>
  <table role="presentation" width="100%" style="border-collapse:collapse;margin-top:16px"><tr>
    ${fact('Portfolio value', egp(F.value), 'EGP, month-end')}
    ${fact('Month return', P(F.row&&F.row.ret), `Index ${pct(F.row&&F.row.bench)}`)}
    ${fact('Year to date', P(F.tr[3].p), `Index ${pct(F.tr[3].b)}`)}
    ${fact('Since inception', P(st.twr), st.annualized!=null?`${pct(st.annualized)} a year`:`Index ${pct(st.benchTwr)}`)}
    ${fact('Max drawdown', P(st.maxDD), `month-end${F.ddDaily!=null?` · ${pct(F.ddDaily)} daily`:''}`)}
    ${fact('Sharpe ratio', num(st.sharpe)+(st.sharpe!=null?ind:''), `annualized · vol ${pct(st.vol*Math.sqrt(12),1,false)} a year`)}
  </tr></table>
  ${h2('Performance')}
  <table role="presentation" width="100%" style="border-collapse:collapse"><tr>${th('','left')}${F.tr.map(t=>th(t.label)).join('')}</tr>
    <tr>${td('Portfolio','left','font-weight:600')}${F.tr.map(t=>td(t.p!=null?P(t.p):'—')).join('')}</tr>
    <tr>${td(BENCH,'left')}${F.tr.map(t=>td(t.b!=null?pct(t.b):'—')).join('')}</tr>
    <tr>${td('Difference','left')}${F.tr.map(t=>td(t.a!=null?P(t.a):'—')).join('')}</tr></table>
  <div style="font:11px Arial;color:${ink3};margin-top:4px">Time-weighted: Modified Dietz monthly returns (deposits weighted by the days they were invested), chain-linked, net of commissions. Periods under one year are not annualized. The benchmark is a price index: it excludes dividends, the portfolio's return includes them.</div>
  ${h2('Monthly returns · %')}
  <table role="presentation" width="100%" data-testid="factsheet-monthly" style="border-collapse:collapse;table-layout:fixed;width:100%"><tr>${thM('Year','left','9%')}${MON.map(x=>thM(x)).join('')}${thM('Year','right','8.5%')}${thM('Index','right','8.5%')}</tr>
    ${F.cal.map(Y=>`<tr>${tdM(`${Y.year}${String(Y.year)===incY&&incM>1?`<div style="font:400 9.5px Arial;color:${ink3}">(from ${MON3[incM-1]})</div>`:''}`,'left','font-weight:600;font-size:12px')}${Y.m.map(v=>tdM(PN(v))).join('')}${tdM(PN(Y.ytd),'right','font-weight:600')}${tdM(Y.bytd!=null?pct(Y.bytd).replace('%',''):'—')}</tr>`).join('')}</table>
  <table role="presentation" width="100%" style="border-collapse:collapse;margin-top:6px"><tr><td style="vertical-align:top;width:52%;padding-right:14px">
    ${h2('Top holdings')}
    <table role="presentation" width="100%" style="border-collapse:collapse">${`<tr>${th('Holding','left')}${th('Sector','left')}${th('Weight')}</tr>`}
    ${F.top.map(r=>`<tr>${td(`<b>${esc(r.symbol||r.name)}</b>`,'left')}${td(esc(r.sector),'left',`color:${ink2}`)}${td(pct(r.w,1,false))}</tr>`).join('')}</table>
  </td><td style="vertical-align:top;padding-left:14px">
    ${h2('Sectors vs index')}
    <table role="presentation" width="100%" style="border-collapse:collapse"><tr>${th('Sector','left')}${th('Portfolio')}${th('Index')}</tr>
    ${F.sectors.filter(s=>s.p>0.001||s.b>0.02).slice(0,12).map(s=>`<tr>${td(esc(s.s),'left')}${td(pct(s.p,1,false))}${td(`<span style="color:${ink2}">${pct(s.b,1,false)}</span>`)}</tr>`).join('')}</table>
  </td></tr></table>
  ${h2('Attribution vs EGX30 Capped')}
  <table role="presentation" width="100%" style="border-collapse:collapse"><tr>${td(`<b>${M(F.m)}</b>`,'left','width:18%')}${td(eff(F.A1),'left')}</tr><tr>${td('<b>Year to date</b>','left')}${td(eff(F.Ay),'left')}</tr></table>
  <table role="presentation" width="100%" style="border-collapse:collapse;margin-top:6px"><tr><td style="vertical-align:top;width:52%;padding-right:14px">
    ${h2('Risk')}
    <table role="presentation" width="100%" style="border-collapse:collapse">
    ${[['Volatility','annualized',pct(st.vol*Math.sqrt(12),1,false)],['Beta vs EGX30 Capped','monthly returns',st.beta!=null?num(st.beta)+ind:'—'],['Tracking error','annualized',st.trackingError!=null?pct(st.trackingError,1,false)+ind:'—'],['Sortino ratio','annualized',st.sortino!=null?num(st.sortino)+ind:'—'],['Upside / downside capture','cumulative',st.upCapture!=null&&st.downCapture!=null?`${pct(st.upCapture,0,false)} / ${pct(st.downCapture,0,false)}${ind}`:'—'],['Money-weighted return (XIRR)','annualized',pct(st.xirr)],['Return in USD','cumulative',st.usdTwr!=null?pct(st.usdTwr):'—'],['Positive months','since inception',`${st.posMonths} of ${st.n}`]].map(([a,basis,b])=>`<tr>${td(`${a} <span style="color:${ink3};font-size:11px">· ${basis}</span>`,'left',`color:${ink2}`)}${td(b)}</tr>`).join('')}</table>
    <div style="font:11px Arial;color:${ink3};margin-top:4px" data-testid="factsheet-riskfree">Risk-free rate used: ${pct(set.riskFree,2,false)} a year (3-month T-bill). Cumulative figures run from ${M(set.inception)} to ${M(F.m)}.</div>
  </td><td style="vertical-align:top;padding-left:14px">
    ${h2('Income · EGP')}
    <table role="presentation" width="100%" style="border-collapse:collapse"><tr>${th('','left')}${th(M(F.m))}${th('YTD')}</tr>
    ${[['Dividends','div'],['Rebates','reb'],['Fees','fee']].map(([l,k])=>`<tr>${td(l,'left',`color:${ink2}`)}${td(egp(F.incM[k]))}${td(egp(F.incY[k]))}</tr>`).join('')}</table>
  </td></tr></table>
  <div style="margin-top:22px;padding-top:10px;border-top:1px solid ${rule};font:11px/1.5 Arial;color:${ink3}">${factsheetSourceNote(F)}; prices from TradingView closes (15-minute delayed). Attribution uses a free-float model of EGX30 Capped with a ${pct(S.bench?S.bench.capWeight:0.15,0,false)} single-stock cap. Past performance does not guarantee future results. Generated ${dfmt(S.R.today)}.</div>
  </div>`;
}
// Footer sentence on where the month-end values came from. When every closed month up to the factsheet month is a closing-price
// estimate (no Thndr statement posted yet, e.g. a portfolio seeded from a workbook), say so instead of claiming statements.
function factsheetSourceNote(F){
  const marks=S.marks||{}; const closed=(F.R.months||[]).filter(r=>r.has&&!r.live&&r.month<=F.m);
  const srcOf=(r)=> r.estimate ? 'price-estimate' : ((marks[r.month]||{}).source || 'typed');
  if(closed.length && closed.every(r=>srcOf(r)==='price-estimate')) return 'Month-end values estimated from closing prices; no Thndr statements have been posted for this portfolio yet';
  const est=Object.keys(marks).sort().filter(k=>k<=F.m&&marks[k].source==='price-estimate'); const rec=Object.keys(marks).sort().filter(k=>k<=F.m&&marks[k].source==='reconstructed');
  const pend=closed.filter(r=>r.estimate&&!est.includes(r.month)).map(r=>r.month); const parts=[];
  if(est.length) parts.push(`${est.map(M).join(', ')} estimated from closing prices; those statements carry no holdings list`);
  if(pend.length) parts.push(`${pend.map(M).join(', ')} estimated from closing prices while the statement is awaited`);
  if(rec.length) parts.push(`${rec.map(M).join(', ')} rebuilt from the following month's statement`);
  return `Month-end values from Thndr statements${parts.length?` (${parts.join('; ')})`:''}`;
}
function vFactsheet(){
  const months = S.R.months.filter(r=>r.has).map(r=>r.month).reverse();
  if(!S.fsMonth || !months.includes(S.fsMonth)) S.fsMonth = months.find(m=>!S.R.months.find(r=>r.month===m).live) || months[0];
  const F = factsheetData(S.fsMonth);
  const email = S.settings.factsheetEmail || '';
  // the site publishes month-end files (exports/index.json): list them once so a month with a PDF gets its own button
  if(window.pdExports && S.exportsList===null){ S.exportsList=false; window.pdExports().then(l=>{ S.exportsList=Array.isArray(l)?l:[]; if(S.tab==='reports') renderTab(false); }).catch(()=>{ S.exportsList=[]; }); }
  const ex = Array.isArray(S.exportsList) ? S.exportsList.find(x=>x.month===S.fsMonth) : null;
  return `<div class="panel"><div class="phead"><div><h2>Monthly factsheet</h2><div class="sub">A one-page report in the format fund managers publish each month</div></div>
    <div class="row"><label class="ink2" style="font-size:12px">Month <select id="fs-month" data-testid="factsheet-month">${months.map(m=>`<option value="${m}" ${m===S.fsMonth?'selected':''}>${M(m)}${S.R.months.find(r=>r.month===m).live?' (live)':''}</option>`).join('')}</select></label>
    <button class="btn" id="fs-dl" data-testid="factsheet-download">Download HTML</button>
    ${window.pdDownloadExport?`<button class="btn" id="fs-xlsx" data-testid="factsheet-excel" data-month="${S.fsMonth}">Download Excel</button>`:''}${window.pdDownloadExport&&ex&&ex.pdf?`<button class="btn" id="fs-pdf" data-testid="factsheet-pdf" data-month="${S.fsMonth}">Download PDF</button>`:''}
    <button class="btn primary" id="fs-email" data-testid="factsheet-email" ${email?'':'disabled'} title="${email?'Send to '+esc(email):'Set an email address under Settings → Inputs &amp; settings'}">Email to me</button></div></div>
    <p class="note" style="margin:0 0 14px" data-testid="factsheet-note">${S.readOnly?`${S.sync&&email?`Emailed to <span class="mono">${esc(email)}</span> automatically after each monthly statement is posted. `:''}Download it here any time.`:email?`Sends from your Gmail to <span class="mono">${esc(email)}</span>. Posting a monthly statement offers to send it automatically.`:'Add an email address under Settings → Inputs &amp; settings to send factsheets.'}</p>
    <div style="overflow-x:auto;background:var(--surface-2);border-radius:10px;padding:14px 8px" data-testid="factsheet-preview">${factsheetHTML(F)}</div></div>`;
}
async function emailFactsheet(m, quiet){
  const mcp = await window.claude?.use?.('mcp'); const to = S.settings.factsheetEmail;
  if(!mcp || !to){ if(!quiet) toast('Email is not available here. Set an address under Settings → Inputs & settings and allow Gmail when asked.','error'); return false; }
  const F = factsheetData(m);
  const html = `<!doctype html><html><body style="margin:0;padding:16px;background:#EDF2EF">${factsheetHTML(F)}</body></html>`;
  const text = `${S.settings.name} — ${M(m)}\nValue ${egp(F.value)} EGP\nMonth ${pct(F.row&&F.row.ret)} vs EGX30 Capped ${pct(F.row&&F.row.bench)}\nYTD ${pct(F.tr[3].p)} · Since inception ${pct(F.st.twr)}`;
  try{ await mcp.callTool(GMAIL,'send_message',{to:[to], subject:`${S.settings.name} · factsheet ${M(m)}`, htmlBody:html, body:text},{cache:false}); toast(`Factsheet for ${M(m)} sent to ${to}`); return true; }
  catch(e){ toast('Could not send the email: '+(e.message||e.code),'error'); return false; }
}

// ---------- Statements (Gmail → review → post) ----------
function payloadOf(res){ let p = res && (res.payload !== undefined ? res.payload : res); if(typeof p==='string'){ try{ p=JSON.parse(p); }catch(e){} }
  if(p && Array.isArray(p.content)){ const t=p.content.find(c=>c.type==='text'); if(t){ try{ p=JSON.parse(t.text); }catch(e){} } }
  if(p && p.structuredContent) p=p.structuredContent; return p; }
let pdfjsP = null;
function loadPdfjs(){ if(!pdfjsP) pdfjsP = new Promise((res,rej)=>{ const add=(src,cb)=>{ const s=document.createElement('script'); s.src=src; s.onload=cb; s.onerror=()=>{ pdfjsP=null; rej(new Error('Could not load the PDF reader')); }; document.head.appendChild(s); };
  add('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', ()=>add('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', ()=>res(window.pdfjsLib))); }); return pdfjsP; }
const MONNUM={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
async function scanGmail(auto){
  const mcp = await window.claude?.use?.('mcp'); if(!mcp){ if(!auto) toast('Gmail is not available in this view.','error'); return; }
  S.stmt.busy='Searching Gmail…'; if(S.tab==='settings') renderTab(true);
  try{
    const res = await mcp.callTool(GMAIL,'search_threads',{query:'from:no-reply@system.thndr.app subject:E-statement -subject:"US Market"', pageSize:50},{cache:false});
    const p = payloadOf(res); const best={};
    ((p&&p.threads)||[]).forEach(th=>(th.messages||[]).forEach(msg=>{ const sm=(msg.subject||'').match(/E-statement\s*-\s*([A-Za-z]{3})\w*\s+(\d{4})/i); if(!sm) return;
      const month=`${sm[2]}-${String(MONNUM[sm[1].toLowerCase()]).padStart(2,'0')}`; const monthly=/monthly/i.test(msg.subject);
      const c={month, id:msg.id, subject:msg.subject, date:msg.date, monthly}; const b=best[month];
      if(!b || (monthly && !b.monthly) || (monthly===b.monthly && c.date>b.date)) best[month]=c; }));
    S.stmt.list = Object.values(best).sort((a,b)=>b.month.localeCompare(a.month)); S.stmt.scanned=new Date().toISOString(); S.stmt.error=null;
  }catch(e){ S.stmt.error = 'Gmail search failed: '+(e.message||e.code); }
  S.stmt.busy=false; if(S.tab==='settings'||S.tab==='overview') renderTab(true);
}
async function reviewStatement(item){
  const mcp = await window.claude?.use?.('mcp'); if(!mcp) return;
  S.stmt.busy=`Reading the ${M(item.month)} statement…`; S.stmt.review=null; renderTab(true);
  try{
    const [pdfjs, res] = await Promise.all([loadPdfjs(), mcp.callTool(GMAIL,'get_message',{messageId:item.id, messageFormat:'RAW'},{cache:false})]);
    const p = payloadOf(res); if(!p || !p.raw) throw new Error('the email came back without its attachments');
    const att = TS.attachments(p.raw); if(!att.length) throw new Error('no PDF attachments found');
    const docs=[]; for(const a of att) docs.push({filename:a.filename, lines: await TS.pdfLines(pdfjs, a.bytes)});
    const own = TS.ownerCheck(docs, S.settings); if(own.error) throw new Error(`refused — this statement ${own.error}. Only this portfolio's own Thndr documents are ever imported.`);
    const st = TS.parseStatement(docs); if(!st.cash) throw new Error('could not find the account statement among the PDFs');
    const rc = TS.reconcile(st, allTx(), S.assets, S.marks);
    rc.item=item; rc.files=att.map(a=>a.filename); rc.accountCode=own.code;
    rc.pick = rc.fresh.map(()=>true); rc.use = rc.conflicts.map(()=>false);
    rc.applyMarks = !!(rc.markProposal && rc.markProposal.securities!=null);
    S.stmt.review = rc; S.stmt.error=null;
    if(IMPORT_DEBUG) console.debug('[statement]', rc);
  }catch(e){ S.stmt.error = `Could not read the ${M(item.month)} statement: ${e.message||e}`; }
  S.stmt.busy=false; renderTab(true);
}
const IMPORT_DEBUG = false;
function vStatements(){
  const T=S.stmt, imp=S.imports||{};
  const latest = T.list && T.list.find(x=>x.monthly);
  const rv=T.review;
  const row=(x)=>{ const done=imp[x.month]; const part=done&&done.fullMonth===false; return `<tr><td><b>${M(x.month)}</b></td><td class="ink2">${x.monthly?'Monthly statement':'Requested statement'} · ${dfmt((x.date||'').slice(0,10))}</td><td>${done?`<span class="pill ${part?'man':'win'}" title="${part?'A part-month statement was posted; the month-end still needs the monthly statement':''}">${part?'Part posted':'Posted'} ${dfmt((done.postedAt||'').slice(0,10))}</span>`:x.monthly?'<span class="pill prov">Not posted</span>':'<span class="pill man">Not posted</span>'}</td><td><button class="btn sm" data-review="${x.month}" data-testid="review-statement">${done?'Review again':'Review'}</button></td></tr>`; };
  // The inbox job only exists for a portfolio that has a sync/state document; the other portfolio posts statements by hand.
  const hasSync = !!S.sync;
  return `
  <div class="panel"><div class="phead"><div><h2>Thndr statements</h2><div class="sub" data-testid="statements-intro">${hasSync?`An automatic job reads every new Thndr email twice a day. Trade invoices are booked straight away; any statement you request replaces the ledger for the dates it covers and updates your cash; the monthly statement with its positions snapshot rewrites the whole month and sets the month-end, then the factsheet is emailed to you. Nothing is saved unless the corrected month reconciles exactly (cash to the piaster, every share count); otherwise the email is held and sent to you for review here.`:`No automatic inbox sync is set up for this portfolio. Statements are posted by hand from this page (Check Gmail → Review → Post).`}</div></div>
    <button class="btn primary" id="scan-gmail" data-testid="scan-gmail" ${T.busy?'disabled':''}>${T.list?'Check Gmail again':'Check Gmail'}</button></div>
    ${T.busy?`<p class="note">${esc(T.busy)}</p>`:''}${T.error?`<div class="banner" style="background:var(--neg-bg);color:var(--neg)">${esc(T.error)}</div>`:''}
    ${T.list? (T.list.length? `<div class="tbl"><table data-testid="statements-table"><thead><tr><th>Month</th><th>Email</th><th>Status</th><th></th></tr></thead><tbody>${T.list.map(row).join('')}</tbody></table></div>` : '<p class="muted">No Thndr statement emails found.</p>') : S.readOnly?'':`<p class="muted">Thndr emails the monthly statement around the 3rd of each month with three PDFs: the account statement, the fund account, and a month-end positions snapshot. The first check asks your permission to read Gmail.</p>`}
  </div>
  ${syncHistory()}
  ${rv? reviewPanel(rv) : ''}`;
}
// Every sync/state.seen entry whose status is 'hold' (id = Gmail message id), newest first.
function heldEmails(){ const seen=(S.sync&&S.sync.seen)||{}; return Object.keys(seen).filter(id=>seen[id]&&seen[id].status==='hold').map(id=>({id, ...seen[id]})).sort((a,b)=>String(b.date||b.at||'').localeCompare(String(a.date||a.at||''))); }
function toolShaLine(sy){ const t=sy&&sy.toolSha; if(!t) return '';
  const parts = typeof t==='string' ? [String(t).slice(0,8)] : ['sync','statement','engine','engine2'].filter(k=>t[k]).map(k=>`${k}.js ${esc(String(t[k]).slice(0,8))}`).concat(Object.keys(t).filter(k=>!['sync','statement','engine','engine2','at'].includes(k)&&typeof t[k]==='string'&&/^[0-9a-f]{6,}$/i.test(t[k])).map(k=>`${esc(k)} ${esc(t[k].slice(0,8))}`));
  return parts.length?`<div class="note" style="margin-top:6px" data-testid="sync-tool-sha">Sync tools: ${parts.join(' · ')}${t.at?` · as of ${esc(cairoAt(t.at))}`:''}</div>`:''; }
function syncHistory(){
  const imp=S.imports||{}, sy=S.sync||null; const months=Object.keys(imp).sort().reverse();
  const seen=Object.values((sy&&sy.seen)||{}).sort((a,b)=>(b.date||'').localeCompare(a.date||'')).slice(0,8);
  const held=heldEmails();
  const when=(iso)=>iso?cairoAt(iso):'—';
  const stLabel={applied:['win','Applied'],unchanged:['auto','Already in ledger'],hold:['loss','Needs review'],skip:['man','Skipped'],ignored:['man','Ignored']};
  return `<div class="panel" data-testid="sync-history"><div class="phead"><div><h2>${sy?'Automatic import history':'Import history'}</h2><div class="sub">${sy?`Last inbox check ${when(sy.lastRun)} · runs daily at 6:17 PM and 10:17 PM Cairo`:'Statements posted by hand from this page; no inbox job runs for this portfolio'}</div>${sy?toolShaLine(sy):''}</div></div>
    <div class="grid g2"><div><h3 class="eyebrow" style="margin:0 0 8px">Months posted from monthly statements</h3>
      ${months.length?`<div class="tbl"><table><thead><tr><th>Month</th><th>Posted</th><th class="n">Added</th><th class="n">Corrected</th><th class="n">Removed</th><th>By</th></tr></thead><tbody>${months.map(m=>{const x=imp[m]; return `<tr><td><b>${M(m)}</b>${x.fullMonth===false?' <span class="pill man" title="A requested (part-month) statement: the month-end still comes from the monthly statement">part</span>':''}</td><td>${dfmt((x.postedAt||'').slice(0,10))}</td><td class="n">${x.added??0}</td><td class="n">${x.corrected??x.replaced??0}</td><td class="n">${x.removed??0}</td><td class="ink2">${esc(x.postedBy||'you')}</td></tr>`;}).join('')}</tbody></table></div>`:'<p class="muted">None yet.</p>'}</div>
    ${sy?`<div><h3 class="eyebrow" style="margin:0 0 8px">Recent Thndr emails handled</h3>
      ${seen.length?`<div class="tbl"><table><thead><tr><th>Email</th><th>Result</th></tr></thead><tbody>${seen.map(e=>{const l=stLabel[e.status]||['man',e.status]; return `<tr><td class="wrap">${esc(e.subject)}</td><td><span class="pill ${l[0]}">${esc(l[1])}</span></td></tr>`;}).join('')}</tbody></table></div>`:'<p class="muted">The inbox job has not run yet.</p>'}</div>`:''}</div>
    ${sy?`<div style="margin-top:16px" data-testid="held-emails"><div class="phead" style="margin-bottom:8px"><div><h3 class="eyebrow" style="margin:0">Held for review · ${held.length}</h3><div class="sub">${held.length?'Nothing from these emails was saved. Fix the cause (post the earlier month, add the missing asset) and retry: the next inbox run reads them again.':'No email is waiting for review.'}</div></div>
      ${held.length&&!S.readOnly?`<button class="btn sm" id="retry-held" data-testid="retry-held">Retry held emails</button>`:''}</div>
      ${held.length?`<div class="tbl"><table data-testid="held-emails-table"><thead><tr><th>Email</th><th>Date</th><th>Why it was held</th></tr></thead><tbody>${held.map(e=>`<tr><td class="wrap">${esc(e.subject||e.id)}</td><td>${dfmt(String(e.date||e.at||'').slice(0,10))}</td><td class="wrap">${(e.reasons&&e.reasons.length)?e.reasons.map(r=>esc(r)).join('<br>'):'<span class="muted">no reason stored</span>'}</td></tr>`).join('')}</tbody></table></div>`:''}</div>`:''}</div>`;
}
// Removes the held entries from sync/state.seen so the next inbox run processes those emails again.
async function retryHeld(btn){
  const held=heldEmails(); if(!held.length){ toast('No held emails to retry'); return; }
  if(!S.db||S.readOnly){ toast('Retrying is only possible on the Claude page.','error'); return; }
  if(btn){ btn.disabled=true; }
  const seen={}; held.forEach(e=>{ seen[e.id]={'__delete__':true}; });
  const n=held.length;
  const ok = await save(()=>S.db.doc('sync/state').update({seen}), `${n} held email${n===1?'':'s'} will be read again at the next inbox check`);
  if(!ok && btn) btn.disabled=false;
}
function reviewPanel(rv){
  const mp=rv.markProposal, md=rv.markDiff; const H=rv.holdings||[]; const bad=H.filter(h=>h.ok===false);
  const fmtRow=(r)=>`${dfmt(r.d)} · ${esc(r.t)}${r.a?' · '+esc(r.a):''}${r.q?` · ${num(r.q,r.q%1?4:0)} @ ${num(r.p,4)}`:''} · <b class="${sgn(r.amt)}">${egp(r.amt,2)}</b>`;
  const newAssets=[...new Map(rv.fresh.concat(rv.conflicts.map(c=>c.stmt)).filter(r=>r.newAsset).map(r=>[r.a,r])).values()];
  return `<div class="panel" data-testid="statement-review"><div class="phead"><div><h2>${M(rv.month)} statement</h2><div class="sub">${dfmt(rv.from)} to ${dfmt(rv.to)}${rv.fullMonth?'':' · partial month'} · ${rv.files.length} PDFs read</div></div>
    <div class="row">${[['ok',`${rv.matched.length} already in ledger`],[rv.fresh.length?'warn':'ok',`${rv.fresh.length} new`],[rv.conflicts.length?'warn':'ok',`${rv.conflicts.length} conflicts`],[rv.ledgerOnly.length?'warn':'ok',`${rv.ledgerOnly.length} only in ledger`],[bad.length?'err':'ok',bad.length?`${bad.length} holdings differ`:'Holdings match']].map(([c,t])=>`<span class="chip ${c}">${t}</span>`).join('')}</div></div>
    ${rv.fresh.length?`<h3 class="eyebrow" style="margin:6px 0 8px">New on the statement</h3><div style="display:grid;gap:6px">${rv.fresh.map((r,i)=>`<label style="display:flex;gap:10px;align-items:baseline"><input type="checkbox" data-pick="${i}" ${rv.pick[i]?'checked':''} id="pick-${i}"><span>${fmtRow(r)}${r.note?` <span class="note">${esc(r.note)}</span>`:''}${r.newAsset?' <span class="pill stale">new asset</span>':''}</span></label>`).join('')}</div>`:'<p class="note">Every transaction on the statement is already in your ledger.</p>'}
    ${rv.conflicts.length?`<h3 class="eyebrow" style="margin:16px 0 8px">Booked differently</h3><div style="display:grid;gap:8px">${rv.conflicts.map((c,i)=>`<div style="display:grid;gap:2px;padding:8px 10px;background:var(--surface-2);border-radius:8px"><span>Statement: ${fmtRow(c.stmt)}</span><span class="ink2">Ledger: ${fmtRow(c.ledger)}</span><label style="display:flex;gap:8px;margin-top:4px"><input type="checkbox" data-use="${i}" ${rv.use[i]?'checked':''} id="use-${i}"> Replace the ledger row with the statement row</label></div>`).join('')}</div>`:''}
    ${rv.ledgerOnly.length?`<h3 class="eyebrow" style="margin:16px 0 8px">In your ledger but not on this statement</h3><div class="note" style="display:grid;gap:4px">${rv.ledgerOnly.map(r=>`<span>${fmtRow(r)}</span>`).join('')}</div>`:''}
    ${rv.unknown.length?`<h3 class="eyebrow" style="margin:16px 0 8px">Lines the reader did not recognise</h3><div class="note" style="display:grid;gap:4px">${rv.unknown.map(r=>`<span>${esc(r.date||'')} ${esc(r.desc||'')} ${r.value!=null?egp(r.value,2):''}</span>`).join('')}</div>`:''}
    ${newAssets.length?`<h3 class="eyebrow" style="margin:16px 0 8px">New assets</h3><div class="form">${newAssets.map((r,i)=>`<label>${esc(r.a)} symbol<input type="text" class="inp" data-nsym="${esc(r.a)}" id="nsym-${i}" value="${esc(r.newAsset.ticker||'')}" placeholder="${r.acc==='MF'?'fund: leave blank':'e.g. COMI'}"></label><label>Sector<input type="text" class="inp" data-nsec="${esc(r.a)}" id="nsec-${i}" list="sector-list2" value="${r.acc==='MF'?(/saving/i.test(r.a)?'Cash & Savings':'Mutual Funds'):''}"></label>`).join('')}</div><datalist id="sector-list2">${[...new Set(Object.values(S.assets).map(a=>a.sector).filter(Boolean))].sort().map(s=>`<option value="${esc(s)}">`).join('')}</datalist>`:''}
    ${H.length?`<h3 class="eyebrow" style="margin:16px 0 8px">Holdings at ${dfmt(rv.to)}</h3><div class="tbl"><table><thead><tr><th>Ticker</th><th>Asset</th><th class="n">Statement</th><th class="n">Ledger</th><th class="n">Value</th><th></th></tr></thead><tbody>${H.map(h=>`<tr><td><span class="sym">${esc(h.ticker)}</span></td><td>${esc(h.name)}</td><td class="n">${num(h.statementQty,h.statementQty%1?3:0)}</td><td class="n">${num(h.ledgerQty,h.ledgerQty%1?3:0)}</td><td class="n">${egp(h.value)}</td><td>${h.ok===null?'<span class="pill man">Fund</span>':h.ok?'<span class="pill win">Match</span>':'<span class="pill loss">Differs</span>'}</td></tr>`).join('')}</tbody></table></div>`:''}
    ${mp?`<h3 class="eyebrow" style="margin:16px 0 8px">Month-end marks</h3><dl class="kv" style="max-width:520px">
      <dt>Cash (statement end balance)</dt><dd>${egp(mp.cash,2)} <span class="note">${md.cash!=null?`now ${egp(md.current.cash,2)}`:'not set'}</span></dd>
      <dt>Securities (${mp.fundsFromLedger?'snapshot stocks + funds at last NAV':'positions snapshot'})</dt><dd>${mp.securities!=null?egp(mp.securities,2):'No snapshot in this email'} <span class="note">${md.securities!=null?`now ${egp(md.current.securities,2)} · diff ${egp(md.securities,2)}`:''}</span></dd></dl>
      ${mp.securities!=null?`<label style="display:flex;gap:8px;margin-top:8px"><input type="checkbox" id="apply-marks" ${rv.applyMarks?'checked':''}> Set ${M(rv.month)} month-end marks from the statement and mark the month confirmed</label>`:''}`:''}
    <p class="note" style="margin-top:14px" data-testid="review-outcome">${postOutcome(rv).text}</p>
    <div class="row" style="margin-top:18px;justify-content:space-between"><label style="display:flex;gap:8px"><input type="checkbox" id="post-email" ${S.settings.factsheetEmail&&rv.fullMonth?'checked':''} ${S.settings.factsheetEmail?'':'disabled'}> Email me the ${M(rv.month)} factsheet afterwards</label>
      <div class="row"><button class="btn" id="review-close">Close</button><button class="btn primary" id="post-statement" data-testid="post-statement" ${S.readOnly?'disabled':''}>Post to portfolio</button></div></div>
  </div>`;
}
// What posting this review will do to the month: it is final (imports/<month>.fullMonth = true) only when the statement covers the
// whole calendar month AND carried a positions snapshot AND the marks are being applied now. Anything else leaves the month open.
function postOutcome(rv){
  const snapshot = !!(rv.markProposal && rv.markProposal.securities!=null);
  const applying = snapshot && !!rv.applyMarks;
  const final = !!rv.fullMonth && snapshot && applying;
  const text = !rv.fullMonth ? `This is a part-month statement: the month stays open for the monthly statement.`
    : !snapshot ? `This statement carries no positions snapshot: the month stays open for the monthly statement.`
    : !applying ? `Marks are not being applied: the month stays open until the statement's month-end figures are applied.`
    : `Posting sets the ${M(rv.month)} month-end from this statement and closes the month.`;
  return { final, marks: applying, text };
}
async function postStatement(){
  const rv=S.stmt.review; if(!rv) return;
  const btn=$('#post-statement'); if(btn){ btn.disabled=true; btn.textContent='Posting…'; }
  const tag = `stmt-${rv.month}`;
  const clean = (r) => { const o={id:newId(), d:r.d, t:r.t, amt:r.amt, acc:r.acc||'Main', src:tag}; if(r.a) o.a=r.a; if(r.q!=null) o.q=r.q; if(r.p!=null) o.p=r.p; if(r.note) o.note=r.note; return o; };
  const add = rv.fresh.filter((r,i)=>rv.pick[i]).map(clean);
  const repl = rv.conflicts.filter((c,i)=>rv.use[i]);
  // ledger: replace chosen conflicts in place, append new rows by year
  const docs = {}; Object.keys(S.ledgerDocs).forEach(y=>{ docs[y]=(S.ledgerDocs[y].rows||[]).slice(); });
  repl.forEach(c=>{ const y=c.ledger.d.slice(0,4); const i=(docs[y]||[]).findIndex(r=>r.id===c.ledger.id); if(i>=0){ const n=clean(c.stmt); n.id=c.ledger.id; docs[y].splice(i,1); const y2=n.d.slice(0,4); (docs[y2] ||= []).push(n); } });
  add.forEach(r=>{ (docs[r.d.slice(0,4)] ||= []).push(r); });
  const touched = new Set(add.map(r=>r.d.slice(0,4)).concat(repl.flatMap(c=>[c.ledger.d.slice(0,4), c.stmt.d.slice(0,4)])));
  let ok = true;
  for(const y of touched){ ok = ok && await save(()=>S.db.doc('ledger/y'+y).set({rows:docs[y]})); if(!ok) break; }
  // new assets
  const na={}; document.querySelectorAll('[data-nsym]').forEach(inp=>{ const n=inp.dataset.nsym; const sec=document.querySelector(`[data-nsec="${CSS.escape(n)}"]`); na[n]={name:n}; if(inp.value.trim()) na[n].symbol=inp.value.trim().toUpperCase(); if(sec&&sec.value.trim()) na[n].sector=sec.value.trim(); if(!na[n].symbol) na[n].fund=true; });
  if(ok && Object.keys(na).length) ok = await save(()=>S.db.doc('portfolio/assets').set({items:{...S.assets,...na}}));
  rv.applyMarks = !!(rv.markProposal && rv.markProposal.securities!=null && $('#apply-marks') && $('#apply-marks').checked);
  const outcome = postOutcome(rv); const applyMarks = outcome.marks;
  if(ok && applyMarks){ const cur=S.marks[rv.month]||{}; ok = await save(()=>S.db.doc('portfolio/marks').set({months:{...S.marks,[rv.month]:{...cur, cash:rv.markProposal.cash, securities:rv.markProposal.securities, provisional:false, source:'statement'}}})); }
  if(ok && rv.accountCode && S.settings.account && !S.settings.account.unifiedCode) ok = await save(()=>S.db.doc('portfolio/settings').set({...S.settings, account:{...S.settings.account, unifiedCode:rv.accountCode}}), `Thndr account ${rv.accountCode} recorded for this portfolio`);
  // fullMonth is true only for a full-calendar-month statement with a snapshot whose marks were applied in this post; a requested
  // (part-month) statement never marks the month final, so the monthly statement is still expected.
  if(ok) ok = await save(()=>S.db.doc('imports/'+rv.month).set({month:rv.month, messageId:rv.item.id, subject:rv.item.subject, postedAt:new Date().toISOString(), added:add.length, replaced:repl.length, marks:applyMarks, fullMonth:outcome.final, statementFrom:rv.from||null, statementTo:rv.to||null}));
  if(ok){ toast(`${M(rv.month)} posted: ${add.length} added, ${repl.length} replaced${applyMarks?', marks updated':''}`); const wantEmail=$('#post-email')&&$('#post-email').checked; const m=rv.month; S.stmt.review=null; renderTab(true); if(wantEmail) setTimeout(()=>emailFactsheet(m), 1500); }
  else if(btn){ btn.disabled=false; btn.textContent='Post to portfolio'; }
}
function statementBanner(){
  const T=S.stmt; if(!T.list) return '';
  const imp=S.imports||{}; const m = T.list.find(x=>x.monthly && !(imp[x.month] && imp[x.month].fullMonth!==false));   // a part-month post does not close the month
  return m ? `<div class="banner" data-testid="statement-banner"><b>Your ${M(m.month)} Thndr statement is ready to post.</b><span>Review it against the ledger and update the month-end marks.</span><button class="btn sm" data-go="statements">Review</button></div>` : '';
}
async function autoScan(){
  try{ const perm = await window.claude?.use?.('permissions'); if(!perm) return; const st = await perm.state('mcp'); if(st==='granted') scanGmail(true); }catch(e){}
}

// ---------- Risk explained: the down-month analysis, done for you (no rules, just what happened and why) ----------
function betaOf(pb, sym){
  const from = PE.addMonths(PE.cairoToday().slice(0,7), -12) + '-01'; const days = pb.days.filter(d=>d>=from);
  const xs=[], ys=[]; let pp=null, pi=null;
  for(const d of days){ const p=pb.at(sym,d), i=pb.at('EGX30CAPPED',d); if(p==null||i==null) continue; if(pp!=null){ xs.push(i/pi-1); ys.push(p/pp-1); } pp=p; pi=i; }
  if(xs.length<40) return null;
  const mx=xs.reduce((a,b)=>a+b,0)/xs.length, my=ys.reduce((a,b)=>a+b,0)/ys.length; let c=0,v=0; xs.forEach((x,k)=>{ c+=(x-mx)*(ys[k]-my); v+=(x-mx)**2; });
  return {beta:v?c/v:null, vol:Math.sqrt(ys.reduce((a,y)=>a+(y-my)**2,0)/(ys.length-1)*250), n:xs.length};
}
function holdingRisk(){
  const R=S.R, pb=pbook(), cash=R.liveCash??R.settings.cash, tot=R.pos.mvTotal+Math.max(0,cash);
  return R.pos.open.filter(r=>r.mv).map(r=>{
    const sym=r.symbol; const b=sym&&pb.has(sym)?betaOf(pb,sym):null;
    let high=null; if(sym&&pb.has(sym)) for(const d of pb.days){ if(d<r.firstBuy) continue; const p=pb.at(sym,d); if(p!=null&&(high==null||p>high)) high=p; }
    if(r.price!=null&&(high==null||r.price>high)) high=r.price;
    return {sym:sym||r.name, name:r.name, sector:r.sector, w:r.mv/tot, mv:r.mv, beta:b?b.beta:null, vol:b?b.vol:null, unreal:r.unreal, unrealPct:r.openCost?r.unreal/r.openCost:null, price:r.price, high, fromHigh:high&&r.price!=null?r.price/high-1:null};
  }).sort((a,b)=>b.w-a.w);
}
// Down months of the SELECTED period (S.R.stats.rows), so the Analysis tab agrees with Performance for any period.
function downMonths(){
  const R=S.R, pb=pbook(), ledger=R.ledger, today=PE.cairoToday(), tx=allTx(), price=PA.makePricer(S.assets,ledger,pb);
  return (R.stats.rows||[]).filter(r=>r.has&&r.bench!=null&&r.bench<0).map(r=>{
    const start=PE.eom(PE.addMonths(r.month,-1)), end=r.live?today:PE.eom(r.month); const H=PA.holdingsAt(ledger,S.assets,pb,start); const tot=H.mv+Math.max(0,H.cash);
    const rows=H.rows.filter(h=>h.shares>0.5).map(h=>{ const p0=price(h.name,start), p1=price(h.name,end); if(!p0||!p1||!p0.p) return null; return {sym:h.symbol||h.name, w:tot?h.mv/tot:0, ret:p1.p/p0.p-1, contrib:tot?h.shares*(p1.p-p0.p)/tot:0}; }).filter(Boolean).sort((a,b)=>a.contrib-b.contrib);
    const buys=tx.filter(t=>t.t==='Buy'&&t.d>start&&t.d<=end).length, sells=tx.filter(t=>t.t==='Sell'&&t.d>start&&t.d<=end).length;
    return {month:r.month, live:r.live, ret:r.ret, bench:r.bench, diff:r.ret-r.bench, cashPct:tot?Math.max(0,H.cash)/tot:0, rows, buys, sells};
  });
}
// whyText returns HTML-safe text: every symbol is escaped here, so callers must not escape it again.
function whyText(d){ const bad=d.rows.filter(x=>x.contrib<0).slice(0,2); if(!bad.length) return d.diff>=0?'Nothing fell much; the portfolio held up.':'Losses were spread across many stocks.';
  const w=bad.reduce((s,x)=>s+x.w,0);
  if(d.diff>=0){ const good=d.rows.filter(x=>x.contrib>0).sort((a,b)=>b.contrib-a.contrib)[0]; return `Held up${good?`: ${esc(good.sym)} ${pct(good.ret,0)} offset ${bad.map(x=>`${esc(x.sym)} ${pct(x.ret,0)}`).join(' and ')}`:''}.`; }
  return `${bad.map(x=>`${esc(x.sym)} ${pct(x.ret,0)}`).join(' and ')} ${bad.length>1?'were':'was'} ${pct(w,0,false)} of the portfolio${d.cashPct<0.02?', with no cash to cushion it':''}${d.buys>=8?`; ${d.buys} buys were made as it fell`:''}.`; }
function vAnalysis(){
  const R=S.R, st=R.stats, dm=downMonths(), H=holdingRisk(), cash=R.liveCash??R.settings.cash, tot=R.pos.mvTotal+Math.max(0,cash);
  if(!st.n) return `<div class="panel empty"><h2>No data for this selection</h2></div>`;
  // capture ratios, up/down month counts and beta come from the period stats: the same figures Performance shows
  const upN=st.upMonths||0, dnN=st.downMonths||0, upC=st.upCapture??null, dnC=st.downCapture??null;
  const top3=H.slice(0,3).reduce((s,h)=>s+h.w,0); const ind=smallSample(st)?IND:'';
  return `
  ${analysisPanel({R,st,dm,H,cash,tot,upN,dnN,upC,dnC,top3})}
  <div class="panel" data-testid="risk-capture"><div class="phead"><div><h2>How you behave when the index moves</h2><div class="sub">${esc(st.label)} · EGX30 Capped had ${upN} up month${upN===1?'':'s'} and ${dnN} down month${dnN===1?'':'s'}</div></div></div>
    <div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))">
      ${kpi('In up months you captured', upC!=null?pct(upC,0,false):'—', 'of the index gain · above 100% is good'+(upC!=null?ind:''))}
      ${kpi('In down months you took', dnC!=null?`<span class="${dnC>1?'neg':'pos'}">${pct(dnC,0,false)}</span>`:'—', 'of the index loss · under 100% is better'+(dnC!=null?ind:''))}
      ${kpi('Your portfolio beta', num(st.beta), 'monthly, vs EGX30 Capped · 1.0 = moves with the index'+(st.beta!=null?ind:''))}
      ${kpi('Cash today', pct(tot?Math.max(0,cash)/tot:0,1,false), `${egp(cash)} EGP · top three stocks are ${pct(top3,0,false)} of the portfolio`)}
    </div>
    <p class="note" style="margin-top:10px">${dnC!=null&&dnC>1?`You lose more than the index when it falls. The table below shows which months and which stocks did it.`:dnC!=null?`You lose less than the index when it falls.`:''}</p>
  </div>
  <div class="panel" data-testid="risk-downmonths"><div class="phead"><div><h2>When the index fell</h2><div class="sub">Each down month: how you did, what you held going in, and what did the damage</div></div></div>
    ${dm.length?`<div class="tbl"><table><thead><tr><th>Month</th><th class="n">Index</th><th class="n">You</th><th class="n">Difference</th><th class="n">Cash going in</th><th class="n">Trades</th><th>What did it</th></tr></thead><tbody>
    ${dm.map(d=>`<tr><td>${M(d.month)}${d.live?' <span class="pill prov">so far</span>':''}</td><td class="n neg">${pct(d.bench)}</td><td class="n ${sgn(d.ret)}">${pct(d.ret)}</td><td class="n ${sgn(d.diff)}">${pct(d.diff)}</td><td class="n">${pct(d.cashPct,1,false)}</td><td class="n">${d.buys} buys · ${d.sells} sells</td><td class="wrap">${whyText(d)}</td></tr>`).join('')}
    </tbody></table></div>`:`<p class="note">The index had no down month in ${esc(st.label)}.</p>`}
  </div>
  <div class="panel" data-testid="risk-holdings"><div class="phead"><div><h2>Each holding's risk</h2><div class="sub">Beta and volatility from the last 12 months of daily closes · "from its high" is against the highest close since you first bought</div></div></div>
    <div class="tbl"><table><thead><tr><th>Stock</th><th class="n">Weight</th><th class="n">Beta</th><th class="n">Volatility</th><th class="n">Unrealized</th><th class="n">From its high</th></tr></thead><tbody>
    ${H.map(h=>`<tr><td><span class="sym">${esc(h.sym)}</span></td><td class="n">${pct(h.w,1,false)}</td><td class="n">${h.beta!=null?num(h.beta):'—'}</td><td class="n">${h.vol!=null?pct(h.vol,0,false):'—'}</td><td class="n ${sgn(h.unreal)}">${egp(h.unreal)} <span class="muted">${pct(h.unrealPct)}</span></td><td class="n ${h.fromHigh<-0.1?'neg':''}">${pct(h.fromHigh)}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="note" style="margin-top:10px">Beta: how much the stock moves for a 1% move in EGX30 Capped. Volatility: how wide its swings are over a year.</p>
  </div>`;
}

// The written review: what the numbers say, why, and what you could do about it. Suggestions only; nothing is tracked or enforced.
function analysisPanel(c){
  const {R,st,dm,H,cash,tot,upN,dnN,upC,dnC,top3}=c; const cashPct=tot?Math.max(0,cash)/tot:0; const G={cash:0.10,max:0.10,top3:0.30,high:0.15,beta:1.2};
  const over=H.filter(h=>h.w>G.max), excess=over.reduce((s,h)=>s+(h.w-G.max)*tot,0), cashAfter=tot?(Math.max(0,cash)+excess)/tot:0;
  const below=H.filter(h=>h.fromHigh!=null&&h.fromHigh<-G.high), hiB=H.filter(h=>h.beta!=null&&h.beta>G.beta), hiBw=hiB.reduce((s,h)=>s+h.w,0);
  const lost=dm.filter(d=>d.diff<0), n=st.n, turnover=st.n?st.sells/Math.max(1,(st.opening+st.closing)/2)*12/st.n:null;
  const winners=H.filter(h=>h.unreal>0).sort((a,b)=>b.unreal-a.unreal), losers=H.filter(h=>h.unreal<0).sort((a,b)=>a.unreal-b.unreal);
  const list=(arr,f)=>arr.map(f).join(', ');   // every f() below escapes what it interpolates (symbols come from user-typed asset names)
  const sym=(h)=>esc(h.sym);
  const single = st.rows.length===1;
  // 1. where you stand (the selected period, same label as the period bar)
  const stand=[`${single?`In ${M(st.rows[0].month)}${st.rows[0].live?' so far':''}`:`From ${M(st.rows[0].month)} to ${M(st.rows[st.rows.length-1].month)}`} the portfolio ${single?'returned':'has returned'} <b class="${sgn(st.twr)}">${pct(st.twr)}</b>${st.benchTwr!=null&&st.alpha!=null?` against <b>${pct(st.benchTwr)}</b> for EGX30 Capped, so it is ${st.alpha>=0?'ahead of':'behind'} the index by <b>${pct(Math.abs(st.alpha),1,false)}</b>`:'; the EGX30 Capped return is incomplete for this period, so there is no index comparison'}.`,
    upC!=null&&dnC!=null?`In the index's ${upN} up month${upN===1?'':'s'} you captured ${pct(upC,0,false)} of its gains; in its ${dnN} down month${dnN===1?'':'s'} you took ${pct(dnC,0,false)} of its losses. ${dnC>1&&upC<1?'You are paid less on the way up and charged more on the way down, and that gap is most of the shortfall.':dnC<=1&&upC>=1?'You gain more than the index when it rises and lose less when it falls: that is what beating it looks like.':dnC<=1?'You hold up better than the index when it falls; the shortfall comes from lagging it in up months.':'You keep up in rising months but lose more than the index when it falls.'}`
    : upC!=null?`The index only rose in this period (${upN} up month${upN===1?'':'s'}); you captured ${pct(upC,0,false)} of its gains.`
    : dnC!=null?`The index only fell in this period (${dnN} down month${dnN===1?'':'s'}); you took ${pct(dnC,0,false)} of its losses.`:'',
    ...moneyWeightedSentences(R)].filter(Boolean);
  // 2. why
  const why=[];
  if(lost.length) why.push(`The months that hurt were ${list(lost,d=>`${M(d.month)} (${pct(d.ret)} against ${pct(d.bench)})`)}. ${lost.map(d=>`${M(d.month)}: ${whyText(d)}`).join(' ')}`);
  why.push(`Today the three largest positions (${list(H.slice(0,3),sym)}) are ${pct(top3,0,false)} of the portfolio and cash is ${pct(cashPct,1,false)}. ${top3>G.top3?'When one of those three has a bad month, the whole portfolio has a bad month; that is the mechanism behind the down-month numbers above.':'Concentration is moderate.'}${cashPct<0.02?' With no cash, nothing cushions a fall and there is nothing to buy a dip with except by selling something else.':''}`);
  if(hiB.length) why.push(`${list(hiB,h=>`${sym(h)} (beta ${num(h.beta)})`)} ${hiB.length>1?'move':'moves'} more than the index and ${hiB.length>1?'are':'is'} ${pct(hiBw,0,false)} of the book, so on a bad index day the portfolio falls more than the index does.`);
  if(turnover!=null) why.push(`Turnover runs at about ${num(turnover,1)}× the portfolio's value a year (${st.trades} trades in the period). Every round trip costs fees and spread, and the Attribution section below shows whether trading during the month has added or cost you.`);
  // 3. what you could do
  const could=[];
  if(over.length) could.push(`<b>Bring each position to ${pct(G.max,0,false)} or less.</b> ${list(over,h=>`${sym(h)} is ${pct(h.w,1,false)} (about ${egp((h.w-G.max)*tot)} EGP over)`)}. Trimming them all raises about ${egp(excess)} EGP and would put cash at ${pct(cashAfter,0,false)}. Sell winners and losers alike; selling only winners to keep funding losers is how losers become the largest positions.`);
  else could.push(`<b>Position sizes are already under ${pct(G.max,0,false)} each.</b> Keep new buys there.`);
  could.push(cashPct<G.cash?`<b>Hold about ${pct(G.cash,0,false)} cash</b> (${egp(G.cash*tot)} EGP at today's size). It softens a fall by roughly a tenth and, more importantly, it is what you buy a dip with instead of selling something at the bottom.`:`<b>Cash is at ${pct(cashPct,0,false)}</b>, which already gives you a cushion and dry powder.`);
  if(below.length) could.push(`<b>Make one decision on each stock well below its high.</b> ${list(below,h=>`${sym(h)} is ${pct(h.fromHigh,0)} from its high (${h.unreal<0?'−':'+'}${egp(Math.abs(h.unreal))} EGP unrealized)`)}. For each, ask: would I buy it today at this price with fresh money? If yes, keep it at ${pct(G.max,0,false)} or less and write down your reason for holding it. If no, sell. Not deciding is what turns a −10% stock into a −20% one.`);
  if(hiB.length) could.push(`<b>Size the high-beta ${hiB.length>1?'names':'name'} smaller.</b> ${list(hiB,sym)} can stay, but as ${hiB.length>1?'the smaller positions':'a smaller position'} rather than ${hiB.length>1?'the largest':'one of the largest'}.`);
  could.push(`<b>Three habits for every future buy:</b> buy only with cash, never by selling something else the same day; no buy takes a stock above ${pct(G.max,0,false)}; write the price at which you would be wrong (the stop field on each asset) before you buy, and act the week it is hit.`);
  if(turnover!=null&&turnover>2) could.push(`<b>Trade less.</b> One decision day a week and a calendar rebalance (monthly or quarterly, back to your target sizes) removes most reactive trades.`);
  // ballast only when nothing defensive is already more than 5% of the portfolio
  const DEF=new Set(['Food & Beverage','Healthcare & Pharma','Telecom','Utilities','Cash & Savings']);
  if(!H.some(h=>DEF.has(h.sector)&&h.w>0.05)) could.push(`<b>Add ballast.</b> One or two low-beta dividend payers (telecom, food, utilities) or a slice in the Thndr savings fund so the whole book is not cyclicals and financials.`);
  could.push(`<b>Monthly, ten minutes, after the statement posts:</b> open this tab, read the first paragraph, check cash and the top three, and trim anything that drifted over ${pct(G.max,0,false)}.`);
  const expect = dnC!=null&&dnC>1 ? `Done this way, the down-month capture should drift toward 90–100% within a couple of down months, mostly from sizing. You give up a little in strong up months because ${pct(G.cash,0,false)} sits in cash and the winners are smaller; on your numbers the worst down month alone cost more against the index than a cash buffer costs in a year of average months.` : `The main thing to protect is the down-month record; keep sizes even and cash on hand and it should hold.`;
  return `<div class="panel brief" data-testid="analysis"><div class="phead"><div><h2>What the numbers say</h2><div class="sub" data-testid="analysis-period">${esc(st.label)} · a written review of the portfolio as it stands today · guideline figures used here: ${pct(G.cash,0,false)} cash, ${pct(G.max,0,false)} per stock, ${pct(G.top3,0,false)} for the top three, a decision at ${pct(G.high,0,false)} below a stock's high · these are suggestions, nothing is tracked or enforced</div></div></div>
    <h3 class="eyebrow" style="margin-top:14px">Where you stand</h3><p>${stand.join(' ')}</p>
    <h3 class="eyebrow" style="margin-top:14px">Why</h3><p>${why.join(' ')}</p>
    <h3 class="eyebrow" style="margin-top:14px">What you could do</h3><ol style="margin:8px 0 0 20px;padding:0;display:grid;gap:8px;max-width:80ch;line-height:1.55">${could.map(x=>`<li>${x}</li>`).join('')}</ol>
    <h3 class="eyebrow" style="margin-top:14px">What to expect</h3><p>${expect}</p>
    ${winners.length||losers.length?`<p class="note" style="margin-top:10px">Unrealized today: ${winners.length?`winners ${list(winners.slice(0,3),h=>`${sym(h)} +${egp(h.unreal)}`)}`:''}${winners.length&&losers.length?' · ':''}${losers.length?`losers ${list(losers.slice(0,3),h=>`${sym(h)} −${egp(Math.abs(h.unreal))}`)}`:''} (EGP).</p>`:''}
  </div>`;
}
