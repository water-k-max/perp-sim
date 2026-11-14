#!/usr/bin/env bash
# `pnpm test:guards` — the non-vacuity proof for the src/web render guards.
#
# A green suite proves nothing about a test that would stay green with the bug in. This script
# injects the exact bug each UI guard claims to catch, one at a time, and requires the named test
# to go red. Every file is byte-restored from a copy afterwards; the script never trusts git to
# undo a patch. It re-runs a test file per probe, so it costs minutes rather than seconds and is
# deliberately outside `pnpm test:web` — run it whenever a render guard is added or edited.
#
# Outcomes, and why they are not all one bucket:
#   caught   - the named test went red, so that test is the thing standing in front of the bug
#   OTHER    - the suite went red on a different test: CI protection yes, but wrong attribution
#   MISSED   - the suite stayed GREEN with the bug in. A real hole in the guard set.
#   BROKEN   - the patch did not compile, so no test ran. The injection is unfaithful, not the guard.
#   NO-PATCH - the perl expression matched nothing, so the probe was testing nothing at all.
# Anything but `caught` is a defect in this file or in the guard set, and fails the run.
set -u
cd "$(dirname "$0")/.."
TSX="npx tsx --tsconfig ./tsconfig.web.json --test"
pass=0; fail=0; other=0; missed=""; log=$(mktemp)

probe () { # file  perl-expr  test-file  test-name  [file2  perl2]
  local file="$1" expr="$2" tf="$3" name="$4" f2="${5:-}" e2="${6:-}"
  local backups=("$file.guardbak") backup
  cp "$file" "$file.guardbak"
  perl -0777 -i -pe "$expr" "$file"
  if [ -n "$f2" ]; then
    cp "$f2" "$f2.guardbak"; backups+=("$f2.guardbak")
    perl -0777 -i -pe "$e2" "$f2"
  fi
  if cmp -s "$file" "$file.guardbak"; then
    echo "NO-PATCH : $name"; missed="$missed\n  NO-PATCH  $name"; fail=$((fail+1))
  else
    $TSX "$tf" >"$log" 2>&1
    if grep -qF "✖ $name" "$log"; then
      echo "caught   : $name"; pass=$((pass+1))
    elif grep -qE 'Transform failed|TransformError' "$log"; then
      echo "BROKEN   : $name -> $(grep -m1 -E 'ERROR:' "$log" | cut -c1-140)"
      missed="$missed\n  BROKEN    $name"; fail=$((fail+1))
    elif grep -qE '^ℹ fail 0' "$log"; then
      echo "MISSED   : $name  ($file)"; missed="$missed\n  MISSED    $name"; fail=$((fail+1))
    elif grep -qE '^ℹ fail [1-9]' "$log"; then
      echo "OTHER    : $name -> $(grep -E '^✖' "$log" | head -2 | cut -c1-90 | tr '\n' ' ')"
      other=$((other+1)); missed="$missed\n  OTHER     $name"; fail=$((fail+1))
    else
      echo "BROKEN   : $name -> $(grep -m1 -E 'Error|error TS|SyntaxError' "$log" | cut -c1-140)"
      missed="$missed\n  BROKEN    $name"; fail=$((fail+1))
    fi
  fi
  for backup in "${backups[@]}"; do mv "$backup" "${backup%.guardbak}"; done
}

R=src/web/Results.tsx; C=src/web/Chart.tsx; S=src/web/Resample.tsx; D=src/web/dto.ts
RS=src/web/results-states.test.tsx; SP=src/web/resample-states.test.tsx; DT=src/web/dto.test.ts
MT=src/web/markout.test.tsx; CT=src/web/chart.test.tsx
E=src/web/Execute.tsx; ET=src/web/Execute.test.tsx

# --- Results.tsx -------------------------------------------------------------
probe "$R" "s/badge === 'RUN FAILED'/true/" "$RS" 'the run headline is the badge the run earned, and only a failure is dressed as one'
probe "$R" "s/hidden=\\{data\\?\\.model\\?\\.fillModel !== 'tape'\\}/hidden={false}/" "$RS" 'the modelled-fill badge explains itself only when fills really were modelled'
probe "$R" "s/ \\? describeModel\\(data\\.model\\) : undefined/ ? undefined : describeModel(data.model)/" "$RS" 'the modelled-fill badge explains itself only when fills really were modelled'
probe "$R" 's/\{data && !busy && <StaleNote/{<StaleNote/' "$RS" 'a stale result names the inputs that moved, and only while it is on screen'
probe "$R" 's/\{data && failure/\{failure/' "$RS" 'with nothing behind it, the failure replaces the empty prompt instead of stacking on it'
probe "$R" "s/!data \\? 'NOT CHECKED'/!data ? 'COMPLETE'/" "$RS" "the data-coverage pill has four tones and picks them from the read, not from the run's status"
probe "$R" "s/ && !data\\.coverage\\.gaps//" "$RS" "the data-coverage pill has four tones and picks them from the read, not from the run's status"
probe "$R" "s/ && \\(!data\\.candleCoverage \\|\\| \\(data\\.candleCoverage\\.complete && data\\.candleCoverage\\.covered === data\\.candleCoverage\\.bars\\)\\)//" "$RS" "the data-coverage pill has four tones and picks them from the read, not from the run's status"
probe "$R" "s/data\\?\\.invariants\\?\\.some\\(i => i\\.status === 'fail'\\)/false/" "$RS" "the data-coverage pill has four tones and picks them from the read, not from the run's status"
probe "$R" "s/!data\\.complete \\? \\['This run is incomplete/false ? ['This run is incomplete/" "$RS" 'the coverage panel withholds its facts until there is a run to report on'
probe "$R" 's/<Metric id="fees" value=/<Metric id="fees" signed value=/' "$RS" "money keeps its sign and a cost never borrows a profit's colour"
probe "$R" 's/: \x27n\x2fa\x27}<\x2fstrong>/: \x270.00\x27}<\x2fstrong>/' "$RS" "money keeps its sign and a cost never borrows a profit's colour"
probe "$R" 's/disabled=\{!exportReady \|\| busy\}/disabled={false}/' "$RS" 'export is inert until there is a result to export and while a run is in flight'
probe "$R" 's/hidden=\{history\.length < 2\}/hidden={false}/' "$RS" 'run comparison needs two runs to compare and marks the one on screen'
probe "$R" "s/entry\\.runId === data\\?\\.manifest\\?\\.runId \\? 'current'/entry.runId === 'nope' ? 'current'/" "$RS" 'run comparison needs two runs to compare and marks the one on screen'
probe "$R" "s/rung\\.bps === null \\? 'no mark'/rung.bps === null ? '0.0 bps'/" "$RS" 'the markout ladder reaches the card through the wire, not just through a fixture'
probe "$R" 's/\{data\?\.resample && <ResamplePanel/\{<ResamplePanel/' "$SP" 'the panel is mounted only by a run that actually carries a resample block' "$S" "s/if \\(!block\\) return null;//"
probe "$R" "s/shape \\|\\| 'No horizons published for this run'/shape || 'Markout is not available'/" "$MT" 'a report with no ladder says it has none'

# --- Chart.tsx ---------------------------------------------------------------
probe "$C" 's/hidden=\{!data\}/hidden={false}/' "$RS" 'the curve is only visible when there is a curve, and a single point is not drawn as one'
probe "$C" "s/points\\.length > 1 && <><line x1/points.length > 0 && <><line x1/" "$RS" 'the curve is only visible when there is a curve, and a single point is not drawn as one'
probe "$C" "s/points\\.length > 1 && <><path d/points.length > 0 && <><path d/" "$RS" 'the curve is only visible when there is a curve, and a single point is not drawn as one'
probe "$C" "s/!points\\.length \\? <text/0 ? <text/" "$RS" 'the curve is only visible when there is a curve, and a single point is not drawn as one'
probe "$C" "s/trades\\.length > 0 && <>/false && <>/" "$RS" 'a close on the axis is coloured by its own sign'
probe "$C" 's/Number\(trade\.netPnl\) >= 0/Number(trade.netPnl) > 0/' "$RS" 'a close on the axis is coloured by its own sign'
probe "$C" 's/cursorReadout\(cursor, points, closes\)/cursorReadout(0, points, closes)/' "$RS" 'the rest state of the cursor readout claims nothing, since no pointer has moved'
probe "$C" 's/\? 0 : closes\.get\(cursor\) \?\? 0/? 0 : 1/' "$CT" 'the readout claims nothing until a cursor names a sample that exists'
probe "$C" 's/Math\.abs\(points\[lo\]!\.t - t\) > Math\.abs/Math.abs(points[lo]!.t - t) >= Math.abs/' "$CT" 'nearestSample lands every time on the closest sample, including outside the window'

# --- Resample.tsx ------------------------------------------------------------
probe "$S" 's/hidden=\{block\.meta\.paths >= 5000\}/hidden={block.meta.paths >= 10000}/' "$SP" 'the modelled-tail warning fires on both of its mechanisms below 5,000 paths and on neither above'
probe "$S" 's/\{block\.meta\.paths < 5000 \&\&/{false \&\&/' "$SP" 'the modelled-tail warning fires on both of its mechanisms below 5,000 paths and on neither above'
probe "$S" "s/if \(sizing !== undefined && sizing !== 'static'\) return null//" "$SP" 'the fixed-size shuffle explains a flat fan, and nothing else'
probe "$S" "s/\|\| p05 !== p95\) return null/) return null/" "$SP" 'the fixed-size shuffle explains a flat fan, and nothing else'
probe "$S" "s/mode !== 'shuffle_without_replacement'/mode !== 'bootstrap_with_replacement'/" "$SP" 'the fixed-size shuffle explains a flat fan, and nothing else'
probe "$S" "s/if \(!fields\.length\) return null//" "$SP" 'the stale banner lists what moved, and is absent when nothing did'
probe "$S" "s/block\\.audit\\.fillBasis === 'observed'/block.audit.fillBasis === 'never-observed'/g" "$SP" 'the fill-check verdict is decided by the basis of the fills, not by the same-bar share alone'
probe "$S" "s/\{verdict\.band === 'anti-skill' \&\&/{false \&\&/" "$SP" 'the null test renders all four verdicts, and the ceiling gets its own warning'
probe "$S" 's/\$\{floor\.toFixed\(4\)\}/0.0001/' "$SP" 'the null test renders all four verdicts, and the ceiling gets its own warning'
probe "$S" "s/\{edge\.skippedTrades > 0 \&\&/{false \&\&/" "$SP" 'the null test renders all four verdicts, and the ceiling gets its own warning'
probe "$S" 's/if \(!edge\) return <p className="muted">/if (false) return <p className="muted">/' "$SP" 'the null test renders all four verdicts, and the ceiling gets its own warning'
probe "$S" 's/\{block\.sizing\.rows\.length === 0 \&\& <p className="muted">No trades to size\.<\/p>\}//' "$SP" 'an empty trade list reports the absence in every tab rather than charting nothing'
probe "$S" 's/block\.oos === null \? <p className="muted">Out-of-sample needs/block.oos === undefined ? <p className="muted">Out-of-sample needs/' "$SP" 'an empty trade list reports the absence in every tab rather than charting nothing'
probe "$S" 's/if \(dist\.fan\.length === 0\) return <p className="muted">No trades to chart\.<\/p>//' "$SP" 'an empty trade list reports the absence in every tab rather than charting nothing'
probe "$S" 's/\{note \&\& <small>\{note\}<\/small>}/<small>{note}<\/small>/' "$SP" 'a metric states its definition in the card, not in a hover'
probe "$S" "s/note=\\{DIST_NOTES\\.medianFinal\\(dist\\.paths, data\\.quoteSymbol\\)\\}/note={undefined}/" "$SP" 'every distribution metric keeps the wording its note promises'

# --- dto.ts ------------------------------------------------------------------
probe "$D" "s/if \(rejectedEntry \&\& \(result\.fills \|\| \[\]\)\.length === 0\) return 'NO FILL'//" "$DT" 'runBadge refuses to call an unopened position a complete run'
probe "$D" "s/result\\.complete \\? 'RUN COMPLETE' : 'PARTIAL RESULT'/result.complete ? 'RUN COMPLETE' : 'RUN COMPLETE'/" "$DT" 'runBadge refuses to call an unopened position a complete run'
probe "$D" "s/if \(!ranWith\) return \\[\\];//" "$DT" 'changedLabels names only the watched inputs that moved, in watch-list order'
probe "$D" 's/\.filter\(key => current\[key\] !== ranWith\[key\]\)/.filter(() => true)/' "$DT" 'changedLabels names only the watched inputs that moved, in watch-list order'
probe "$D" "s/if \(model\\.fillModel === 'tape'\) return/if (false) return/" "$DT" 'describeModel tells the two fill models apart and admits neither is an execution'

# --- Execute.tsx / dto.ts execution guards -----------------------------------
# A sent order's receipt must link to the REAL Somnia Tokyo explorer (Hideki = Tokyo), never a
# fabricated host: swap the verified explorer helper for an explorer.example destination.
probe "$E" 's/href=\{explorerTxUrl\(hash\)\}/href={"https:\/\/explorer.example\/tx\/" + hash}/' "$ET" 'CANARY: a sent order links its hash to the real Somnia Tokyo explorer, never a fabricated host'
# The live arm is decided by the operator opting in twice, never by a default that could send.
probe "$E" 's/const live = capability\.enabled && !capability\.dryRun;/const live = false;/' "$ET" 'a live capability badges LIVE · TESTNET, names the chain and cap, and requires a confirm'
# A failing pre-trade gate must surface as the binding gate, not be hidden behind a green proposal.
probe "$E" 's/\{!proposal\.placeable && proposal\.binding &&/{false &&/' "$ET" 'a not-placeable proposal surfaces the binding gate, and an over-cap one says so'
# A send result without a real transaction hash is not evidence of a send.
probe "$D" 's/if \(typeof value\.hash !== \x27string\x27 \|\| !txHashHex\.test\(value\.hash\)\) throw new Error\(\x27The send result is missing a valid transaction hash\.\x27\);//' "$ET" 'CANARY: a send result without a valid hash is refused — no evidence, no send'
# A malformed capability must fail closed (null), not render an order form on a guess.
probe "$D" 's/if \(!dec\(value\.maxNotional\)\) return null;//' "$ET" 'parseExecutionCapability accepts a config answer and rejects anything malformed'

rm -f "$log"
echo
echo "guards caught: $pass   other-test-caught: $other   to fix: $fail"
[ -n "$missed" ] && printf "%b\n" "$missed"
[ "$fail" -eq 0 ] || exit 1
