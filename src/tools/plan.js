#!/usr/bin/env node
/* Dates for the scheduled jobs, computed once in Africa/Cairo (one place for "today", the weekday, last month, ...).
     node plan.js [--lastRun ISO] [--now ISO]
   Prints ONE JSON object:
     nowCairo      Cairo wall-clock time with its UTC offset, e.g. '2026-09-28T15:10:04+03:00'
     today         'YYYY-MM-DD' (Cairo)             month / prevMonth  'YYYY-MM'        dayOfMonth  1..31
     weekday       'Sun'..'Sat' (Cairo)          hour  0..23, the Cairo local hour (integer)
     gmailAfter    'YYYY/MM/DD' for a Gmail "after:" search: the Cairo date of --lastRun minus 5 days, or today minus 7 days
                   when there is no (valid) --lastRun
     isEgxSession  true Sunday to Thursday (the EGX trading week; public holidays are not known here)
   --now overrides the current time (tests). */
'use strict';
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? a.concat([[x.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]]) : a), []));
const TZ = 'Africa/Cairo';
// Cairo calendar parts of an instant
function parts(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23' })
    .formatToParts(date).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mi: +p.minute, ss: +p.second, weekday: p.weekday };
}
const pad = (n, w = 2) => String(n).padStart(w, '0');
const ymd = (p, sep = '-') => `${p.y}${sep}${pad(p.m)}${sep}${pad(p.d)}`;
// a Cairo calendar date shifted by k days (pure calendar arithmetic, no time-zone effects)
const shift = (p, k) => { const t = new Date(Date.UTC(p.y, p.m - 1, p.d + k)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
function plan(now, lastRun) {
  const p = parts(now);
  const offMin = Math.round((Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mi, p.ss) - Math.floor(now.getTime() / 1000) * 1000) / 60000);
  const off = `${offMin < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offMin) / 60))}:${pad(Math.abs(offMin) % 60)}`;
  const month = `${p.y}-${pad(p.m)}`;
  const prevMonth = p.m === 1 ? `${p.y - 1}-12` : `${p.y}-${pad(p.m - 1)}`;
  const lr = lastRun ? new Date(lastRun) : null;
  const gmailAfter = lr && !isNaN(lr) ? ymd(shift(parts(lr), -5), '/') : ymd(shift(p, -7), '/');
  return {
    nowCairo: `${ymd(p)}T${pad(p.hh)}:${pad(p.mi)}:${pad(p.ss)}${off}`, today: ymd(p), month, prevMonth, dayOfMonth: p.d, weekday: p.weekday, hour: p.hh,
    gmailAfter, isEgxSession: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu'].includes(p.weekday),
  };
}
if (require.main === module) {
  const now = typeof args.now === 'string' ? new Date(args.now) : new Date();
  if (isNaN(now)) { console.error('--now is not a valid date/time'); process.exit(1); }
  console.log(JSON.stringify(plan(now, typeof args.lastRun === 'string' ? args.lastRun : null)));
}
module.exports = { plan };
