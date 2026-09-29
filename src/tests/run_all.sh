#!/usr/bin/env bash
# The repository's own checks - the same script runs on GitHub Actions (.github/workflows/checks.yml) and locally.
#   bash src/tests/run_all.sh [step ...]      steps: syntax tests tools build private   (default: all five, in that order)
# Nothing here needs private data or network access except `tools`, which installs pdfjs-dist@3.11.174 (for sync.js) into
# a temp dir unless PDFJS_NODE_MODULES points at a node_modules that already has it. Everything that writes goes to a temp
# dir; the working tree is left as it was. Needs: node 20+, python 3.11+ with openpyxl, pillow and cryptography.
# The live-site browser tests are separate: node src/tests/site_smoke.js, node src/tests/site_edit.js (need Playwright + Chromium).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/portfolio-checks.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
export PYTHONPYCACHEPREFIX="$TMP/pycache" PYTHONDONTWRITEBYTECODE=1
# public mode: never pick up private fixtures from the environment
unset KHALED_EXPORT YASSIN_EXPORT EXPECTED_JSON SEED_JSON PRIVATE_MARKERS 2>/dev/null || true
cd "$ROOT"

say() { printf '\n== %s\n' "$*"; }
die() { echo "FAIL: $*" >&2; exit 1; }
nonempty() { for f in "$@"; do [ -s "$f" ] || die "expected non-empty output $f"; done; }
# jsonline <file> <python expression over d>: the last line of <file> is JSON and the expression holds
jsonline() { python3 - "$1" "$2" <<'EOF' || die "$1: check failed: $2"
import json, sys
d = json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])
ok = eval(sys.argv[2], {}, {'d': d})
print(('  ok: ' if ok else '  NOT: ') + sys.argv[2])
sys.exit(0 if ok else 1)
EOF
}

step_syntax() {
  say "syntax: node --check on every .js under src/"
  local n=0
  while IFS= read -r -d '' f; do node --check "$f" || die "node --check $f"; n=$((n+1)); done < <(find src -name '*.js' -not -path '*/node_modules/*' -print0 | sort -z)
  echo "  $n JavaScript files ok"
  say "syntax: python -m py_compile on every .py in src/ and tools/"
  n=0
  while IFS= read -r -d '' f; do python3 -m py_compile "$f" || die "py_compile $f"; n=$((n+1)); done < <(find src tools -name '*.py' -not -path '*/node_modules/*' -print0 | sort -z)
  echo "  $n Python files ok"
}

step_tests() {
  say "engine tests, public mode (no private fixtures): src/tests/test_dietz.js, src/tests/test.js"
  cp -r src "$TMP/tsrc"          # the private sections of test_dietz.js write under <src>/..; keep that out of the tree
  (cd "$TMP/tsrc" && node tests/test_dietz.js > "$TMP/dietz.out") || { cat "$TMP/dietz.out"; die "test_dietz.js"; }
  grep -E '^(FAIL|SKIP)' "$TMP/dietz.out" || true
  echo "  test_dietz.js: $(grep -c '^PASS' "$TMP/dietz.out") PASS, $(grep -c '^SKIP' "$TMP/dietz.out" || true) SKIP (private sections), last line: $(tail -1 "$TMP/dietz.out")"
  grep -q '^PASS' "$TMP/dietz.out" || die "test_dietz.js ran no check"
  (cd "$TMP/tsrc" && node tests/test.js > "$TMP/test.out") || { cat "$TMP/test.out"; die "test.js"; }
  echo "  test.js: $(head -c 160 "$TMP/test.out")"
  (cd "$TMP/tsrc" && node tests/test_site_store.js > "$TMP/sitestore.out") || { cat "$TMP/sitestore.out"; die "test_site_store.js"; }
  echo "  $(tail -1 "$TMP/sitestore.out")"
  (cd "$TMP/tsrc" && python3 tests/test_store.py > "$TMP/store.out" 2>&1) || { tail -20 "$TMP/store.out"; die "test_store.py"; }
  echo "  test_store.py: $(tail -1 "$TMP/store.out")"
  (cd "$TMP/tsrc" && python3 tests/test_jobs.py > "$TMP/jobs.out" 2>&1) || { tail -20 "$TMP/jobs.out"; die "test_jobs.py"; }
  echo "  test_jobs.py: $(tail -1 "$TMP/jobs.out")"
}

step_tools() {
  say "tools on synthetic data (src/tests/fixtures/make_synthetic.js)"
  local S="$TMP/synthetic" T="$TMP/tools" O="$TMP/tools-out"
  mkdir -p "$O"
  node src/tests/fixtures/make_synthetic.js "$S" > "$O/make.json"; jsonline "$O/make.json" "d['ok'] and d['ledgerRows'] > 5 and d['sessions'] > 60"
  cp -r src/tools "$T"           # the jobs run every tool from one directory, with pdfjs-dist next to sync.js
  if [ -n "${PDFJS_NODE_MODULES:-}" ]; then cp -r "$PDFJS_NODE_MODULES" "$T/node_modules"
  else (cd "$T" && npm install --no-save --no-package-lock --no-audit --no-fund --loglevel=error pdfjs-dist@3.11.174 >/dev/null) || die "npm install pdfjs-dist"; fi

  say "tools: plan.js"
  node "$T/plan.js" --now 2026-09-24T12:00:00Z > "$O/plan.json"; jsonline "$O/plan.json" "d['today'] == '2026-09-24' and d['weekday'] == 'Thu' and d['isEgxSession'] and d['prevMonth'] == '2026-08'"
  node "$T/plan.js" > "$O/plan_now.json"; jsonline "$O/plan_now.json" "len(d['today']) == 10 and d['nowCairo'][-6:] in ('+02:00', '+03:00')"

  say "tools: weekly.js --week-ending 2026-09-10"
  node "$T/weekly.js" --data "$S" --week-ending 2026-09-10 --today 2026-09-24 --out "$O/weekly.html" --text "$O/weekly.txt" --json "$O/weekly.json" > "$O/weekly.out"
  nonempty "$O/weekly.html" "$O/weekly.txt" "$O/weekly.json"
  jsonline "$O/weekly.out" "d['ok'] and d['weekEnding'] == '2026-09-10' and d['sessions'] == 5 and d['trades'] == 2 and 'Demo Portfolio' in d['subject'] and d['bytes'] > 5000"

  say "tools: excel.js + excel.py (month 2026-08)"
  node "$T/excel.js" --data "$S" --month 2026-08 --out "$O/xl.json" > "$O/excel.out"; nonempty "$O/xl.json"
  jsonline "$O/excel.out" "d['ok'] and d['month'] == '2026-08' and d['holdings'] == 5 and d['value'] > 0"
  python3 "$T/excel.py" "$O/xl.json" "$O/Demo.xlsx" > "$O/excelpy.out"; nonempty "$O/Demo.xlsx" "$O/Demo.xlsx.b64"
  jsonline "$O/excelpy.out" "d['ok'] and d['bytes'] > 5000 and d['sheets'][0] == 'Summary' and d['sheets'][-1] == 'Monthly (formulas)'"
  python3 - "$O/Demo.xlsx" <<'EOF' || die "excel.py workbook read-back"
import sys
from openpyxl import load_workbook
wb = load_workbook(sys.argv[1], data_only=True)
col = [r[0] for r in wb['Monthly'].iter_rows(values_only=True)]
months = [c for c in col[col.index('Month') + 1:] if c]
assert months == ['Jun-26', 'Jul-26', 'Aug-26'], months
print(f"  ok: workbook reads back, {len(wb.sheetnames)} sheets, Monthly rows {months}")
EOF

  say "tools: sync.js with an empty inbox (no e-mail is read or sent; heads-up digest path runs)"
  mkdir -p "$O/inbox"; echo '[]' > "$O/inbox/manifest.json"
  node "$T/sync.js" --data "$S" --inbox "$O/inbox" --out "$O/plan" --today 2026-09-24 > "$O/sync.out" 2> "$O/sync.err" || { cat "$O/sync.err"; die "sync.js"; }
  nonempty "$O/plan/summary.json" "$O/plan/write/sync_state.json"
  jsonline "$O/sync.out" "d['status'] == 'nochange' and d['processed'] == 0 and d['writes'] == ['sync_state.json'] and len(d['toolSha']['sync']) == 12"
  python3 - "$O/plan/summary.json" <<'EOF' || die "sync.js summary"
import json, sys
s = json.load(open(sys.argv[1]))
kinds = sorted(i['kind'] for i in s['digest']['items'])
assert s['digest']['errors'] == [], s['digest']['errors']
assert kinds == ['exdiv', 'target'], kinds                     # the synthetic export plants one of each
assert s['digest']['drawdown'] and s['digest']['drawdown']['basis'] == 'daily'
assert s['email'] and s['email']['subject'].startswith('Demo Portfolio: heads-up')
print(f"  ok: summary.json digest {kinds}, drawdown {s['digest']['drawdown']['dd']:.4f}, email subject set (not sent)")
EOF

  say "tools: build_tooldocs.py, fetch_prices.py --help (no network)"
  python3 src/tools/build_tooldocs.py --out "$O/tooldocs" > "$O/tooldocs.out" 2> "$O/tooldocs.err" || die "build_tooldocs.py"
  if grep -q WARNING "$O/tooldocs.err"; then cat "$O/tooldocs.err"; die "build_tooldocs.py warns (a tools/ copy drifted)"; fi
  [ "$(ls "$O/tooldocs" | wc -l)" -ge 9 ] || die "build_tooldocs.py wrote $(ls "$O/tooldocs" | wc -l) documents, expected 9"
  echo "  ok: $(ls "$O/tooldocs" | wc -l) tool documents"
  python3 tools/fetch_prices.py --help > "$O/fp.out"; grep -q 'usage: fetch_prices.py' "$O/fp.out" || die "fetch_prices.py --help"
  echo "  ok: fetch_prices.py --help"

  say "tools: export.py + encrypt_file.py round trip with a throwaway key"
  python3 src/tests/crypto_roundtrip.py "$ROOT" "$S" "$O/Demo.xlsx" "$O/crypto" > "$O/crypto.out" || die "crypto round trip"
  jsonline "$O/crypto.out" "d['ok'] and d['exportDocs'] >= 10"
}

step_build() {
  say "copies in sync: src/{engine,engine2,statement}.js == src/tools/*, tools/fetch_prices.py == src/jobs/fetch_prices.py"
  for f in engine.js engine2.js statement.js; do cmp "src/$f" "src/tools/$f" || die "src/tools/$f differs from src/$f (cp src/$f src/tools/)"; done
  cmp tools/fetch_prices.py src/jobs/fetch_prices.py || die "tools/fetch_prices.py differs from src/jobs/fetch_prices.py"
  echo "  ok"
  say "build: src/build.py (desk pages) and src/site/build_site.py (site wrapper) in a temp copy"
  local B="$TMP/build" W="$TMP/site"
  cp -r src "$B"; mkdir -p "$W"
  (cd "$B" && python3 build.py > "$TMP/build.out") || die "build.py"
  sed 's/^/  /' "$TMP/build.out"
  for p in portfolio-desk.html yassin-desk.html; do grep -Eq '<meta name="pd-build" content="[0-9a-f]{12} [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}">' "$B/$p" || die "$p has no pd-build stamp"; done
  (cd "$B/site" && python3 build_site.py "$W" > "$TMP/site.out") || die "build_site.py"
  local I="$W/index.html"; nonempty "$I" "$W/portfolios.json" "$W/manifest.webmanifest" "$W/icon-192.png"
  grep -q '<meta http-equiv="Content-Security-Policy" content="default-src '"'"'self'"'"';' "$I" || die "site index.html: no Content-Security-Policy meta"
  if grep -Eq 'fonts\.(googleapis|gstatic)\.com' "$I"; then die "site index.html still references Google Fonts"; fi
  grep -Eq '<meta name="pd-build" content="[0-9a-f]{12} ' "$I" || die "site index.html has no pd-build stamp"
  echo "  ok: index.html $(wc -c < "$I") bytes, CSP meta present, no Google Fonts, stamp $(grep -Eo 'pd-build" content="[0-9a-f]{12}' "$I" | cut -d'"' -f3)"
  say "published site matches src/: ./index.html, portfolios.json, manifest, icons == a fresh build (build time ignored)"
  local strip='s/<meta name="pd-build" content="[^"]*">//'
  if ! diff -q <(sed "$strip" "$I") <(sed "$strip" index.html) >/dev/null; then
    die "./index.html is not what src/ builds - rebuild the site (cd src && python3 build.py && cd site && python3 build_site.py <repo>) and commit index.html with the src/ change"
  fi
  for f in portfolios.json manifest.webmanifest; do cmp -s "$W/$f" "$f" || die "./$f differs from a fresh build_site.py output"; done
  for f in "$W"/fonts/*; do cmp -s "$f" "fonts/$(basename "$f")" || die "fonts/$(basename "$f") differs from src/site/fonts"; done
  # icons: compared by pixels (PNG bytes depend on the Pillow/zlib build), a mean difference under 1 level per channel
  python3 - "$W" <<'EOF' || die "an icon differs from a fresh build_site.py output"
import sys
from PIL import Image, ImageChops, ImageStat
for n in (180, 192, 512):
    a, b = Image.open(f'{sys.argv[1]}/icon-{n}.png').convert('RGB'), Image.open(f'icon-{n}.png').convert('RGB')
    assert a.size == b.size == (n, n), (n, a.size, b.size)
    m = max(ImageStat.Stat(ImageChops.difference(a, b)).mean)
    assert m < 1, f'icon-{n}.png mean difference {m:.2f}'
EOF
  echo "  ok"
}

step_private() {
  say "private-data guard: src/tests/check_private.py"
  python3 src/tests/check_private.py "$ROOT" || die "private-data guard found something (see the hits above)"
}

STEPS=("$@"); [ ${#STEPS[@]} -eq 0 ] && STEPS=(syntax tests tools build private)
for s in "${STEPS[@]}"; do
  case "$s" in syntax|tests|tools|build|private) t0=$(date +%s); "step_$s"; echo "  [$s done in $(( $(date +%s) - t0 ))s]";; *) die "unknown step '$s' (syntax tests tools build private)";; esac
done
printf '\nALL CHECKS PASSED (%s)\n' "${STEPS[*]}"
