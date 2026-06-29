# Difficulty auto-tuning policy. TWO modes, switched by $auditCount:
#
#   TIER selection ($auditCount < 0, the default): given the escalation ledger + a task's
#   (layer × work-type) cell, return the index of the cheapest tier on the global ladder whose
#   historical first-attempt success rate for that cell is >= floor with >= minN samples; else
#   coldIdx (the authored difficulty / cold-start prior).
#
#   AUDIT probability ($auditCount >= 0): given a cell's CONFIRMED-AUDITED success count, return the
#   blocking-audit sampling probability as an integer PER-MILLE (0..1000) — so the loop can sample
#   with $RANDOM and no bash floats. 100% until auditStartN, linear taper to auditFloor*1000 by
#   auditFloorN, floored there (never zero). See designs/audit-verification.md §4.6.
#
# $failedIds (tier branch): a JSON array of task ids the OWNER manually marked FAILED (the
#   .harness/manual-fail.json overlay — designs/manual-fail-signal.md). A success outcome row whose
#   id is in this set is RE-INTERPRETED as a failure at every rung it used (exactly like a blocked
#   row), so a falsely-recorded success no longer teaches the calibrator that its (cheap) tier works.
#   The audit-suppression correction lives in the loop's separate audit-count query, not here.
#
# Invoke (tier):  jq -n -f policy.jq --slurpfile rows <outcomes.jsonl> --argjson tiers '<ladder>' \
#                   --arg layer <L> --arg wt <W> --argjson floor 0.75 --argjson minN 6 \
#                   --argjson coldIdx <N> --argjson auditCount -1 --argjson failedIds '<ids>' \
#                   --argjson auditStartN 3 --argjson auditFloorN 8 --argjson auditFloorPM 100
# Invoke (audit): same flags, but --argjson auditCount <confirmed-count> (>= 0); the tier-only flags
#                 may be placeholders (rows '[]', tiers '[]', layer/wt '', failedIds '[]', etc.) —
#                 that branch is not evaluated. Both invocations must DEFINE every $var (jq compiles
#                 both branches).

def tidx($m; $e): ($tiers | map(.model == $m and .effort == $e) | index(true)) // -1;

# audit per-mille from a cell's confirmed-audited success count.
def audit_permille($count; $startN; $floorN; $floorPM):
  if   $count <  $startN then 1000
  elif $count >= $floorN then $floorPM
  else ((1000 - (($count - $startN) * (1000 - $floorPM) / ($floorN - $startN))) | round)
  end;

if $auditCount >= 0 then
  audit_permille($auditCount; $auditStartN; $auditFloorN; $auditFloorPM)
else
  ( $rows
    | map(select(.facets != null and .facets.layer == $layer and .facets.workType == $wt))
    | map(
        tidx(.startModel; .startEffort) as $s
        | tidx(.finalModel; .finalEffort) as $f
        | select($s >= 0 and $f >= 0)
        # An owner-marked manual failure overturns a recorded success: treat it like a blocked row
        # (every rung it used counts as ok:false), so the cell stops looking solved at a cheap tier.
        | (.blocked or (.id as $i | ($failedIds | index($i)) != null)) as $failed
        | if $failed
          then [ range($s; $f + 1) | { idx: ., ok: false } ]
          else [ range($s; $f)     | { idx: ., ok: false } ] + [ { idx: $f, ok: true } ]
          end
      )
    | add // []
  ) as $ev
  | [ range(0; ($tiers | length)) as $i
      | ($ev | map(select(.idx == $i))) as $at
      | ($at | length) as $n
      | select($n >= $minN and (($at | map(select(.ok)) | length) / $n) >= $floor)
      | $i
    ]
  | (min // $coldIdx)
end
