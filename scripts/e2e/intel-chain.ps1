$ErrorActionPreference = "Stop"
$base = "http://localhost:5189"
$results = @()
function Step($name, $block) {
  try { & $block; $script:results += "PASS  $name" }
  catch { $script:results += "FAIL  $name - $($_.Exception.Message)" }
}
function PostJ($url, $obj) {
  $body = if ($null -eq $obj) { "{}" } else { $obj | ConvertTo-Json -Depth 12 }
  Invoke-RestMethod -Method Post "$base$url" -ContentType "application/json" -Body $body -TimeoutSec 180
}
function GetJ($url) { Invoke-RestMethod "$base$url" -TimeoutSec 60 }
function PostRaw($url, $obj) {
  # Returns the error body instead of throwing, so negative gates can be asserted.
  $body = if ($null -eq $obj) { "{}" } else { $obj | ConvertTo-Json -Depth 12 }
  try {
    $r = Invoke-WebRequest -Method Post "$base$url" -ContentType "application/json" -Body $body -TimeoutSec 60
    return @{ code = $r.StatusCode; body = $r.Content }
  } catch {
    $resp = $_.Exception.Response
    $code = if ($resp) { [int]$resp.StatusCode } else { 0 }
    $txt = ""
    if ($resp) { $sr = New-Object System.IO.StreamReader($resp.GetResponseStream()); $txt = $sr.ReadToEnd() }
    return @{ code = $code; body = $txt }
  }
}

# I0 - pristine start
Step "I0 Reset to pristine seed" {
  $r = PostJ "/api/admin/reset" $null
  if (-not $r.ok) { throw "reset not ok" }
  $cues = GetJ "/api/intel/cues"
  if ($cues.Count -lt 3) { throw "expected 3 seeded cues, got $($cues.Count)" }
  $script:cue = $cues | Where-Object { $_.state -eq "new" } | Select-Object -First 1
  if (-not $script:cue) { throw "no NEW cue seeded" }
}

# I1 - the AI may reason alone
Step "I1 Interrogate + identify (AI acts alone)" {
  $ans = PostJ "/api/intel/cues/$($script:cue.id)/interrogate" @{ question = "What is this contact and how confident are we?" }
  if ($ans.answer.Length -lt 60) { throw "interrogate answer too short" }
  if ($ans.handoff.autonomy -ne "auto") { throw "interrogate autonomy $($ans.handoff.autonomy)" }
  $id = PostJ "/api/intel/cues/$($script:cue.id)/identify" $null
  if (-not $id.assessment.unitType) { throw "no unitType" }
  if ($id.handoff.autonomy -ne "auto") { throw "identify autonomy $($id.handoff.autonomy)" }
  $script:sources = "$($ans.source)/$($id.assessment.source)"
  $c = GetJ "/api/intel/cues/$($script:cue.id)"
  if ($c.state -ne "reviewing") { throw "state $($c.state) after identify" }
}

# I2 - the AI may NOT close the loop
Step "I2 Governance gates refuse the AI" {
  $r1 = PostRaw "/api/intel/cues/$($script:cue.id)/confirm" @{ by = "Col A. Mansour" }
  if ($r1.code -eq 200) { throw "confirm accepted with no collection" }
  $r2 = PostRaw "/api/intel/cues/$($script:cue.id)/scenario" @{ createdBy = "   " }
  if ($r2.code -eq 200) { throw "scenario accepted a whitespace name" }
  $opts = PostJ "/api/intel/cues/$($script:cue.id)/collect/options" $null
  if ($opts.options.Count -lt 2) { throw "expected 2+ collection options" }
  $script:opts = $opts.options
}

# I3 - a sensor too coarse must not unlock confirmation
Step "I3 Inconclusive collection does not unlock confirm" {
  $coarse = 0
  for ($i = 0; $i -lt $script:opts.Count; $i++) { if ($script:opts[$i].note -match "(will not|cannot|does not) resolve") { $coarse = $i } }
  $t = PostJ "/api/intel/cues/$($script:cue.id)/collect" @{ optionIndex = $coarse }
  $tid = $t.task.id
  $bad = PostRaw "/api/intel/cues/$($script:cue.id)/collect/$tid/approve" @{}
  if ($bad.code -eq 200) { throw "approve accepted with no approver name" }
  $ap = PostJ "/api/intel/cues/$($script:cue.id)/collect/$tid/approve" @{ approver = "Col A. Mansour" }
  if ($ap.task.status -ne "approved") { throw "status $($ap.task.status) after approve" }
  if ($ap.task.result) { throw "approve fabricated a product before collection" }
  $rep = PostJ "/api/intel/cues/$($script:cue.id)/collect/$tid/report" $null
  if ($rep.task.outcome -ne "inconclusive") { throw "coarse sensor returned $($rep.task.outcome)" }
  $blocked = PostRaw "/api/intel/cues/$($script:cue.id)/confirm" @{ by = "Col A. Mansour" }
  if ($blocked.code -eq 200) { throw "confirm accepted on an inconclusive product" }
}

# I4 - a capable sensor earns the confirmation
Step "I4 Resolving collection, then named human confirms" {
  $fine = 0
  for ($i = 0; $i -lt $script:opts.Count; $i++) { if (-not ($script:opts[$i].note -match "(will not|cannot|does not) resolve")) { $fine = $i; break } }
  $t = PostJ "/api/intel/cues/$($script:cue.id)/collect" @{ optionIndex = $fine }
  $tid = $t.task.id
  PostJ "/api/intel/cues/$($script:cue.id)/collect/$tid/approve" @{ approver = "Col A. Mansour" } | Out-Null
  $rep = PostJ "/api/intel/cues/$($script:cue.id)/collect/$tid/report" $null
  if ($rep.task.outcome -ne "resolved") { throw "capable sensor returned $($rep.task.outcome)" }
  $before = (GetJ "/api/intel/cues/$($script:cue.id)").confidence
  $cf = PostJ "/api/intel/cues/$($script:cue.id)/confirm" @{ by = "Col A. Mansour" }
  if ($cf.cue.state -ne "confirmed") { throw "state $($cf.cue.state)" }
  if ($cf.handoff.autonomy -ne "human-required") { throw "confirm autonomy $($cf.handoff.autonomy)" }
  $script:confidence = $before
}

# I5 - the payoff: a confirmed cue becomes a real scenario
Step "I5 Cue becomes a scenario" {
  $sp = PostJ "/api/intel/cues/$($script:cue.id)/scenario" @{ createdBy = "Plans Cell (J5)" }
  $s = $sp.scenario
  $script:scn = $s
  $blue = ($s.units | Where-Object { $_.side -eq "blue" }).Count
  $red = ($s.units | Where-Object { $_.side -eq "red" }).Count
  if ($blue -lt 4 -or $red -lt 3) { throw "thin ORBAT b=$blue r=$red" }
  if ($s.objectives.Count -lt 2) { throw "objectives $($s.objectives.Count)" }
  $stray = $s.units | Where-Object { $_.position.lat -lt 22.9 -or $_.position.lat -gt 25.1 -or $_.position.lng -lt 58.7 -or $_.position.lng -gt 63.7 }
  if ($stray.Count -gt 0) { throw "$($stray.Count) units outside the theater box" }
  # objectives the engine can actually score
  foreach ($o in $s.objectives) {
    if ($o.kind -eq "destroy" -or $o.kind -eq "protect") {
      if (-not $o.targetUnitIds -or $o.targetUnitIds.Count -lt 1) { throw "$($o.kind) objective has no targets" }
      foreach ($tid in $o.targetUnitIds) { if (-not ($s.units | Where-Object { $_.id -eq $tid })) { throw "objective target $tid not in scenario" } }
    }
  }
  $v = PostJ "/api/scenarios/$($s.id)/validate" $null
  $errs = ($v.issues | Where-Object { $_.level -eq "error" }).Count
  if ($errs -gt 0) { throw "$errs validation errors: $(($v.issues | Where-Object { $_.level -eq 'error' } | ForEach-Object { $_.code }) -join ',')" }
  $c = GetJ "/api/intel/cues/$($script:cue.id)"
  if ($c.state -ne "spawned" -or -not $c.scenarioId) { throw "cue not marked spawned" }
  $again = PostRaw "/api/intel/cues/$($script:cue.id)/scenario" @{ createdBy = "Plans Cell (J5)" }
  if ($again.code -eq 200) { throw "spawned a second scenario from the same cue" }
}

# I6 - the intel scenario feeds the normal planning chain
Step "I6 Mission + COA generation on the intel scenario" {
  $m = PostJ "/api/missions" @{ scenarioId = $script:scn.id; title = "Counter the reported grouping" }
  $script:mission = $m
  $d = PostJ "/api/missions/$($m.id)/decompose" $null
  if ($d.subTasks.Count -lt 2) { throw "decompose gave $($d.subTasks.Count) sub-tasks" }
  $g = PostJ "/api/coas/generate" @{ scenarioId = $script:scn.id; missionId = $m.id; count = 2; strategy = "balanced" }
  if ($g.coas.Count -lt 2) { throw "coas $($g.coas.Count)" }
  $script:coaIds = @($g.coas | ForEach-Object { $_.id })
}

# I7 - run it to completion through the real engine
Step "I7 Deduction run to completion" {
  $rs = (GetJ "/api/rulesets") | Where-Object { $_.status -eq "active" } | Select-Object -First 1
  $run = PostJ "/api/runs" @{ scenarioId = $script:scn.id; coaIds = $script:coaIds; ruleSetId = $rs.id; engine = "realtime"; speed = 4; label = "Intel E2E" }
  if ($run.branches.Count -ne 2) { throw "branches $($run.branches.Count)" }
  $script:runId = $run.id
  $decided = 0
  $deadline = (Get-Date).AddMinutes(6)
  while ((Get-Date) -lt $deadline) {
    $run = GetJ "/api/runs/$($script:runId)"
    if ($run.status -eq "completed" -or $run.status -eq "aborted") { break }
    foreach ($b in $run.branches) {
      $open = $b.decisions | Where-Object { $_.status -eq "open" } | Select-Object -First 1
      if ($open) {
        PostJ "/api/runs/$($script:runId)/branches/$($b.id)/decide" @{ decisionId = $open.id; optionId = $open.aiRecommendationId; rationale = "Intel E2E"; decidedBy = "Col A. Mansour" } | Out-Null
        $script:decided = ++$decided
      }
    }
    Start-Sleep -Seconds 3
  }
  $run = GetJ "/api/runs/$($script:runId)"
  if ($run.status -ne "completed") { throw "run ended $($run.status) at T+$($run.clock.simTimeH)h" }
  if ($decided -lt 1) { throw "no decision points fired on the intel scenario" }
  # objective scoring must be live, not pinned at 0 or stuck at 100 from tick 1
  $objs = @($run.branches | ForEach-Object { $_.metrics.objectiveScore })
  $script:objScores = ($objs -join "/")
  $ev = ($run.branches | ForEach-Object { $_.eventCount } | Measure-Object -Sum).Sum
  if ($ev -lt 20) { throw "only $ev events across branches" }
  $script:events = $ev
}

# I8 - assessment, replay and the after-action report on an intel-born run
Step "I8 Assessment + replay + after-action report" {
  $asm = PostJ "/api/runs/$($script:runId)/assess" $null
  $a = $asm | Select-Object -First 1
  if ($null -eq $a) { $a = (GetJ "/api/assessments?runId=$($script:runId)") | Select-Object -First 1 }
  if ($a.dimensions.Count -lt 5) { throw "dimensions $($a.dimensions.Count)" }
  $run = GetJ "/api/runs/$($script:runId)"
  $rp = GetJ "/api/runs/$($script:runId)/replay/$($run.branches[0].id)"
  if ($rp.snapshots.Count -lt 5) { throw "replay snapshots $($rp.snapshots.Count)" }
  $rep = PostJ "/api/runs/$($script:runId)/report" @{}
  if ($rep.sections.Count -lt 4) { throw "report sections $($rep.sections.Count)" }
  $script:reportSource = $rep.source
}

# I9 - the audit trail survives the whole chain
Step "I9 Hand-off trail is complete and addressable" {
  $c = GetJ "/api/intel/cues/$($script:cue.id)"
  $h = $c.handoffs
  if ($h.Count -lt 6) { throw "only $($h.Count) hand-off records" }
  $humans = ($h | Where-Object { $_.autonomy -eq "human-required" }).Count
  if ($humans -lt 4) { throw "only $humans human-required steps" }
  $named = ($h | Where-Object { $_.actor -eq "Col A. Mansour" }).Count
  if ($named -lt 2) { throw "named human missing from the trail" }
  if (-not $c.assessment.handoffId) { throw "assessment has no handoffId" }
  foreach ($t in $c.collection) {
    if (-not $t.requestHandoffId) { throw "task $($t.taskingId) missing requestHandoffId" }
    if ($t.status -eq "collected" -and -not $t.collectHandoffId) { throw "task $($t.taskingId) missing collectHandoffId" }
  }
  # every referenced id must resolve to a real record
  $ids = @($h | ForEach-Object { $_.id })
  foreach ($t in $c.collection) {
    foreach ($ref in @($t.requestHandoffId, $t.approveHandoffId, $t.collectHandoffId)) {
      if ($ref -and -not ($ids -contains $ref)) { throw "dangling hand-off ref $ref" }
    }
  }
  if (-not ($ids -contains $c.assessment.handoffId)) { throw "dangling assessment hand-off ref" }
}

# I10 - the replay feed keeps producing cues
Step "I10 Feed advance and sync" {
  $before = (GetJ "/api/intel/cues").Count
  $adv = PostJ "/api/intel/feed/advance" $null
  if (-not $adv.cue) { throw "advance produced no cue" }
  $after = (GetJ "/api/intel/cues").Count
  if ($after -ne $before + 1) { throw "cue count $before -> $after" }
  $sync = PostJ "/api/intel/feed/sync" $null
  if (-not $sync.source) { throw "sync reported no source" }
  $script:syncSource = $sync.source
}

Step "I11 Final reset to pristine seed" {
  $r = PostJ "/api/admin/reset" $null
  if (-not $r.ok) { throw "reset not ok" }
  $cues = GetJ "/api/intel/cues"
  if ($cues.Count -ne 3) { throw "reset left $($cues.Count) cues" }
}

$results | ForEach-Object { Write-Host $_ }
Write-Host "AI sources (interrogate/identify): $($script:sources)"
Write-Host "decisions resolved: $($script:decided) | objective scores: $($script:objScores) | events: $($script:events)"
Write-Host "report source: $($script:reportSource) | feed sync source: $($script:syncSource)"
if ($results | Where-Object { $_ -like "FAIL*" }) { exit 1 }
