$ErrorActionPreference = "Stop"
$base = "http://localhost:5189"
$results = @()
function Step($name, $block) {
  try { & $block; $script:results += "PASS  $name" }
  catch { $script:results += "FAIL  $name - $($_.Exception.Message)" }
}
function PostJ($url, $obj) {
  $body = if ($null -eq $obj) { "{}" } else { $obj | ConvertTo-Json -Depth 12 }
  Invoke-RestMethod -Method Post "$base$url" -ContentType "application/json" -Body $body -TimeoutSec 120
}
function PutJ($url, $obj) { Invoke-RestMethod -Method Put "$base$url" -ContentType "application/json" -Body ($obj | ConvertTo-Json -Depth 12) -TimeoutSec 60 }
function GetJ($url) { Invoke-RestMethod "$base$url" -TimeoutSec 60 }

# 0 - pristine start
Step "0 Reset demo data" { $r = PostJ "/api/admin/reset" $null; if (-not $r.ok) { throw "reset not ok" } }

# 1 - scenario authoring: create from blank template, validate flags issues
Step "1 Create scenario from template + validate" {
  $s = PostJ "/api/scenarios" @{ name = "E2E Authoring Test"; codename = "E2E AUTHOR"; template = "scn-blank-template" }
  $script:authorScn = $s
  $v = PostJ "/api/scenarios/$($s.id)/validate" $null
  if ($null -eq $v.issues) { throw "no validation report" }
}

# 2 - OPORD pipeline: parse sample text -> materialize ready scenario
Step "2 OPORD parse + materialize" {
  # curl.exe carries the UTF-8 body verbatim; PowerShell mangles it inline.
  $fixture = Join-Path $PSScriptRoot "fixtures/opord-body.json"
  $raw = & curl.exe -s -X POST "$base/api/opord/parse" -H "Content-Type: application/json" --data "@$fixture" -m 120
  $p = $raw | ConvertFrom-Json
  if ($p.error) { throw $p.error }
  $total = ($p.sides | ForEach-Object { $_.entities.Count } | Measure-Object -Sum).Sum
  if ($total -lt 14) { throw "only $total entity groups" }
  $scn = PostJ "/api/scenarios/from-opord" @{ parse = $p; name = "E2E Azure Trident"; codename = "E2E TRIDENT" }
  if ($scn.status -ne "ready" -or $scn.units.Count -lt 15) { throw "materialize bad: $($scn.status)/$($scn.units.Count)" }
  $script:scn = $scn
}

# 3 - mission + decomposition
Step "3 Mission create + decompose" {
  $m = PostJ "/api/missions" @{ scenarioId = $script:scn.id; side = "blue"; title = "E2E: Open the strait"; intent = "Open and secure the Meridian Strait under restricted emissions."; endState = "Strait open, RED IADS combat-ineffective." }
  $m2 = PostJ "/api/missions/$($m.id)/decompose" $null
  if ($m2.subTasks.Count -lt 5) { throw "only $($m2.subTasks.Count) subtasks" }
  $script:mission = $m2
}

# 4 - COA generation with strategy + grades + silent eval + select two
Step "4 COA generate (loss-control) + grades + silent eval + select" {
  $g = PostJ "/api/coas/generate" @{ scenarioId = $script:scn.id; missionId = $script:mission.id; count = 3; strategy = "loss-control" }
  if ($g.analysis.Count -lt 5) { throw "no analysis trace" }
  $rec = $g.coas | Where-Object { $_.grade -eq "recommended" } | Select-Object -First 1
  if (-not $rec) { throw "no recommended grade" }
  $ev = PostJ "/api/coas/$($rec.id)/silent-eval" $null
  if ($null -eq $ev.silentEval.projected.objectiveScore) { throw "no projection" }
  $two = $g.coas | Select-Object -First 2
  foreach ($c in $two) { PutJ "/api/coas/$($c.id)" @{ status = "selected" } | Out-Null }
  $script:coaIds = @($two | ForEach-Object { $_.id })
}

# 5 - rules: author a rule into the active set + dry-run adjudication
Step "5 Rule authoring + dry-run" {
  $rs = (GetJ "/api/rulesets") | Where-Object { $_.status -eq "active" } | Select-Object -First 1
  $newRule = @{ id = "rule-e2e-night"; name = "E2E night strike bonus"; category = "engagement"; priority = 40; enabled = $true;
    conditions = @(@{ fact = "simTimeH"; op = "gte"; value = 48 });
    effects = @(@{ type = "modify-pk"; params = @{ factor = 1.1 } }) }
  $rules = @($rs.rules) + @($newRule)
  PutJ "/api/rulesets/$($rs.id)" @{ rules = $rules } | Out-Null
  $t = PostJ "/api/rulesets/$($rs.id)/test" @{ situation = "surface-engagement" }
  if ($null -eq $t.trace) { throw "no dry-run trace" }
  $script:rsId = $rs.id
}

# 6 - launch deduction: 2 branches, realtime 4x
Step "6 Launch run (2 branches)" {
  $run = PostJ "/api/runs" @{ scenarioId = $script:scn.id; coaIds = $script:coaIds; ruleSetId = $script:rsId; engine = "realtime"; speed = 4; label = "E2E full chain" }
  if ($run.branches.Count -ne 2) { throw "$($run.branches.Count) branches" }
  $script:runId = $run.id
}

# 7 - decisions: follow AI on branch 1, override on branch 2; storm inject; run to completion
Step "7 Decisions (follow + override) + inject + completion" {
  $deadline = (Get-Date).AddSeconds(150); $followed = $false; $overrode = $false; $injected = $false
  while ((Get-Date) -lt $deadline) {
    $run = GetJ "/api/runs/$($script:runId)"
    if ($run.status -in @("completed", "aborted")) { break }
    for ($i = 0; $i -lt $run.branches.Count; $i++) {
      $br = $run.branches[$i]
      $open = $br.decisions | Where-Object { $_.status -eq "open" } | Select-Object -First 1
      if ($open) {
        if ($i -eq 1 -and -not $overrode) {
          $alt = ($open.options | Where-Object { $_.id -ne $open.aiRecommendationId } | Select-Object -First 1).id
          PostJ "/api/runs/$($script:runId)/branches/$($br.id)/decide" @{ decisionId = $open.id; optionId = $alt; rationale = "E2E override"; decidedBy = "E2E Commander" } | Out-Null
          $overrode = $true
        } else {
          PostJ "/api/runs/$($script:runId)/branches/$($br.id)/decide" @{ decisionId = $open.id; optionId = $open.aiRecommendationId; rationale = "E2E follow"; decidedBy = "E2E Commander" } | Out-Null
          $followed = $true
        }
      }
    }
    if (-not $injected -and $run.clock.simTimeH -gt 10) {
      PostJ "/api/runs/$($script:runId)/branches/$($run.branches[0].id)/intervene" @{ type = "set-weather"; params = @{ weather = "storm" }; requestedBy = "E2E Umpire" } | Out-Null
      $injected = $true
    }
    Start-Sleep -Seconds 3
  }
  $run = GetJ "/api/runs/$($script:runId)"
  if ($run.status -ne "completed") { throw "run ended $($run.status) at T+$($run.clock.simTimeH)h" }
  if (-not ($followed -and $overrode -and $injected)) { throw "flags f=$followed o=$overrode i=$injected" }
  if ($run.environment.weather -ne "storm") { throw "live env not storm" }
  $adj = ($run.branches[0].recentEvents | Where-Object { $_.adjudication }).Count
  if ($adj -lt 1) { throw "no adjudication payloads" }
  if ($null -eq $run.branches[0].score.net) { throw "no scoreboard" }
}

# 8 - assessment + replay + agent activity
Step "8 Assessment + replay + agent activity" {
  $asm = PostJ "/api/runs/$($script:runId)/assess" $null
  $a = $asm | Select-Object -First 1
  if ($null -eq $a) { $a = (GetJ "/api/assessments?runId=$($script:runId)") | Select-Object -First 1 }
  if ($a.dimensions.Count -lt 5) { throw "dimensions missing" }
  $run = GetJ "/api/runs/$($script:runId)"
  $rp = GetJ "/api/runs/$($script:runId)/replay/$($run.branches[0].id)"
  if ($rp.snapshots.Count -lt 10) { throw "replay snapshots $($rp.snapshots.Count)" }
  $act = GetJ "/api/agent-activity?runId=$($script:runId)"
  if ($act.Count -lt 1) { throw "no agent activity" }
}

# 9 - SAGE: grounded explain + copilot ask
Step "9 SAGE explain + ask" {
  $run = GetJ "/api/runs/$($script:runId)"
  $ex = PostJ "/api/runs/$($script:runId)/branches/$($run.branches[0].id)/explain" @{ topic = "risk" }
  if ($ex.answer.Length -lt 40) { throw "explain too short" }
  $ask = PostJ "/api/ask" @{ question = "One sentence: which E2E branch performed better?"; pageContext = "assessment" }
  if ($ask.answer.Length -lt 20) { throw "ask failed" }
  $script:sageSource = "$($ex.source)/$($ask.source)"
}

# 10 - piece designer -> ontology -> palette defaults
Step "10 Piece designer class + defaults" {
  $cls = PostJ "/api/ontology/classes" @{ label = "E2E Strike Drone"; domain = "air"; description = "E2E test piece"; speedKts = 320; strength = 100; supply = 100;
    sensors = @(@{ type = "eo-ir"; rangeKm = 60 }); weapons = @(@{ type = "strike"; rangeKm = 120; pk = 0.5; ammo = 4 }) }
  $onto = GetJ "/api/ontology"
  $found = $onto.classes | Where-Object { $_.label -eq "E2E Strike Drone" }
  if (-not $found -or $null -eq $found.defaults.weapons) { throw "class or defaults missing" }
}

# 11 - admin: suspend/reactivate + audit trail
Step "11 User suspend/reactivate + audit" {
  $u = (GetJ "/api/users") | Select-Object -Last 1
  PutJ "/api/users/$($u.id)" @{ status = "suspended" } | Out-Null
  $u2 = PutJ "/api/users/$($u.id)" @{ status = "active" }
  if ($u2.status -ne "active") { throw "reactivate failed" }
  $audit = GetJ "/api/audit"
  if ($audit.Count -lt 10) { throw "audit thin" }
}

# 12 - pristine finish
Step "12 Final reset to pristine seed" {
  $r = PostJ "/api/admin/reset" $null
  if (-not $r.ok -or $r.scenarios -ne 3) { throw "reset state off" }
}

$results | ForEach-Object { $_ }
"SAGE sources: $($script:sageSource)"

# 13 - Phase 4: resume from breakpoint
Step "13 Resume from breakpoint" {
  $runs = GetJ "/api/runs"
  $done = $runs | Where-Object { $_.status -eq "completed" } | Select-Object -First 1
  $run = GetJ "/api/runs/$($done.id)"
  $br = $run.branches[0]
  $fork = PostJ "/api/runs/$($done.id)/branches/$($br.id)/resume" @{ tick = 100; speed = 4 }
  if (-not $fork.resumedFrom) { throw "no resumedFrom" }
  if ($fork.clock.tick -ne $fork.resumedFrom.tick) { throw "clock not rewound" }
  if (-not $fork.seats -or $fork.seats.Count -lt 5) { throw "fork lost the crew" }
  PostJ "/api/runs/$($fork.id)/control" @{ action = "abort" } | Out-Null
}

# 14 - Phase 4: after-action report
Step "14 After-action report" {
  $runs = GetJ "/api/runs"
  $done = $runs | Where-Object { $_.status -eq "completed" } | Select-Object -First 1
  $rep = PostJ "/api/runs/$($done.id)/report" @{}
  if ($rep.sections.Count -lt 4) { throw "only $($rep.sections.Count) sections" }
  if ($rep.branches.Count -lt 1) { throw "no branch figures" }
  $script:reportSource = $rep.source
}

# 15 - Command seats
Step "15 Command seats crew + toggle" {
  $coas = (GetJ "/api/coas") | Where-Object { $_.scenarioId -eq "scn-azure-horizon" } | Select-Object -First 2
  $rs = (GetJ "/api/rulesets") | Where-Object { $_.status -eq "active" } | Select-Object -First 1
  $run = PostJ "/api/runs" @{ scenarioId = "scn-azure-horizon"; coaIds = @($coas | ForEach-Object { $_.id }); ruleSetId = $rs.id; engine = "realtime"; speed = 2; label = "E2E seats"; crewedBy = "E2E Commander" }
  if ($run.seats.Count -ne 7) { throw "seats=$($run.seats.Count)" }
  $aiSeat = $run.seats | Where-Object { $_.mode -eq "ai" } | Select-Object -First 1
  $upd = PutJ "/api/runs/$($run.id)/seats/$($aiSeat.id)" @{ mode = "human"; participant = "LT E2E" }
  $seat = $upd.seats | Where-Object { $_.id -eq $aiSeat.id }
  if ($seat.mode -ne "human" -or $seat.participant -ne "LT E2E") { throw "human toggle failed" }
  $upd2 = PutJ "/api/runs/$($run.id)/seats/$($aiSeat.id)" @{ mode = "ai" }
  $seat2 = $upd2.seats | Where-Object { $_.id -eq $aiSeat.id }
  if ($seat2.mode -ne "ai" -or -not $seat2.agentName) { throw "agent toggle failed" }
  PostJ "/api/runs/$($run.id)/control" @{ action = "abort" } | Out-Null
}

$results | Select-Object -Last 3 | ForEach-Object { $_ }
"report source: $($script:reportSource)"
