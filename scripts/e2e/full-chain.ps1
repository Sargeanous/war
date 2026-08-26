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
function PutRaw($url, $obj) {
  # Returns the error body instead of throwing, so negative gates can be asserted.
  try {
    $r = Invoke-WebRequest -Method Put "$base$url" -ContentType "application/json" -Body ($obj | ConvertTo-Json -Depth 12) -TimeoutSec 60
    return @{ code = $r.StatusCode; body = $r.Content }
  } catch {
    $resp = $_.Exception.Response
    $code = if ($resp) { [int]$resp.StatusCode } else { 0 }
    $txt = ""
    if ($resp) { $sr = New-Object System.IO.StreamReader($resp.GetResponseStream()); $txt = $sr.ReadToEnd() }
    return @{ code = $code; body = $txt }
  }
}
function GetJ($url) { Invoke-RestMethod "$base$url" -TimeoutSec 60 }
function GetRaw($url) {
  try {
    $r = Invoke-WebRequest "$base$url" -TimeoutSec 60
    return @{ code = $r.StatusCode; body = $r.Content }
  } catch {
    $resp = $_.Exception.Response
    $code = if ($resp) { [int]$resp.StatusCode } else { 0 }
    return @{ code = $code; body = "" }
  }
}
function PostRaw($url, $obj) {
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

# 16 - The adversary is playing a plan, and it is masked until the reveal
Step "16 OPFOR plan is played and masked" {
  $plans = GetJ "/api/adversary/plans"
  if ($plans.Count -lt 2) { throw "expected 2 adversary plans, got $($plans.Count)" }
  $coas = (GetJ "/api/coas") | Where-Object { $_.scenarioId -eq "scn-azure-horizon" } | Select-Object -First 2
  $rs = (GetJ "/api/rulesets") | Where-Object { $_.status -eq "active" } | Select-Object -First 1
  $run = PostJ "/api/runs" @{ scenarioId = "scn-azure-horizon"; coaIds = @($coas | ForEach-Object { $_.id }); ruleSetId = $rs.id; engine = "realtime"; speed = 4; label = "E2E adversary"; redPlanId = "adv-tidewall" }
  $seeds = $run.branches | ForEach-Object { $_.seed } | Select-Object -Unique
  if ($seeds.Count -ne 1) { throw "branches drew different seeds: $($seeds -join ',')" }
  $adv = $run.branches[0].adversary
  if ($adv.revealed) { throw "plan revealed before the umpire said so" }
  if ($adv.codename -ne "Withheld") { throw "masked codename leaked as $($adv.codename)" }
  if ($adv.phases.Count -ne 0) { throw "masked view leaked $($adv.phases.Count) phases" }
  $bad = PostRaw "/api/runs/$($run.id)/adversary/reveal" @{}
  if ($bad.code -eq 200) { throw "unsigned reveal accepted" }
  $revealed = PostJ "/api/runs/$($run.id)/adversary/reveal" @{ revealedBy = "E2E Umpire" }
  $adv2 = $revealed.branches[0].adversary
  if (-not $adv2.revealed) { throw "reveal did not take" }
  if ($adv2.codename -ne "TIDEWALL") { throw "codename $($adv2.codename)" }
  if ($adv2.phases.Count -lt 3) { throw "only $($adv2.phases.Count) phases revealed" }
  if (-not $adv2.counter) { throw "no counter recorded" }
  if ($run.PSObject.Properties.Name -contains "redPlanId") { throw "the plan id is serialized to players, which unmasks the plan via GET /api/adversary/plans" }
  $openTruth = GetRaw "/api/runs/$($run.id)/adversary/truth"
  if ($openTruth.code -ne 403) { throw "the white-cell plan view is readable by anyone (got $($openTruth.code))" }
  $truth = GetJ "/api/runs/$($run.id)/adversary/truth?viewedBy=E2E%20White%20Cell"
  if ($truth.branches.Count -lt 2) { throw "white cell view missing a branch" }
  $log = GetJ "/api/audit"
  if (-not ($log | Where-Object { $_.action -eq "adversary-truth-read" })) { throw "reading the enemy plan was not audited" }
  $script:advRunId = $run.id
  PostJ "/api/runs/$($run.id)/control" @{ action = "abort" } | Out-Null
}

# 16b - A decision cuts an order, so it cannot be made by nobody
Step "16b Commander decisions require a named human" {
  $coa = (GetJ "/api/coas") | Where-Object { $_.scenarioId -eq "scn-azure-horizon" } | Select-Object -First 1
  $rs = (GetJ "/api/rulesets") | Where-Object { $_.status -eq "active" } | Select-Object -First 1
  $run = PostJ "/api/runs" @{ scenarioId = "scn-azure-horizon"; coaIds = @($coa.id); ruleSetId = $rs.id; engine = "realtime"; speed = 8; label = "E2E decide gate" }
  $open = $null
  for ($i = 0; $i -lt 90 -and -not $open; $i++) {
    Start-Sleep -Milliseconds 700
    $run = GetJ "/api/runs/$($run.id)"
    $open = $run.branches[0].decisions | Where-Object { $_.status -eq "open" } | Select-Object -First 1
  }
  if (-not $open) { throw "no decision point opened inside the window" }
  $anon = PostRaw "/api/runs/$($run.id)/branches/$($run.branches[0].id)/decide" @{ decisionId = $open.id; optionId = $open.aiRecommendationId }
  if ($anon.code -ne 403) { throw "an unnamed commander decision was accepted (got $($anon.code))" }
  $f = GetJ "/api/runs/$($run.id)/fragos"
  if ($f.fragos.Count -ne 0) { throw "a refused decision still cut an order" }
  PostJ "/api/runs/$($run.id)/branches/$($run.branches[0].id)/decide" @{ decisionId = $open.id; optionId = $open.aiRecommendationId; decidedBy = "Maj Gen E2E"; rationale = "gate check" } | Out-Null
  $f2 = GetJ "/api/runs/$($run.id)/fragos"
  if ($f2.fragos[0].issuedBy -ne "Maj Gen E2E") { throw "order issued by $($f2.fragos[0].issuedBy)" }
  PostJ "/api/runs/$($run.id)/control" @{ action = "abort" } | Out-Null
}

# 17 - Orders out: the platform can write an order, not only read one
Step "17 Orders, sync matrix and decision support" {
  $coa = (GetJ "/api/coas") | Where-Object { $_.scenarioId -eq "scn-azure-horizon" } | Select-Object -First 1
  $o = GetJ "/api/coas/$($coa.id)/orders"
  if ($o.opord.paragraphs.Count -ne 5) { throw "$($o.opord.paragraphs.Count) paragraphs, expected the five-paragraph order" }
  if ($o.opord.annexes.Count -lt 3) { throw "only $($o.opord.annexes.Count) annexes" }
  if (-not $o.opord.marking) { throw "order carries no marking" }
  foreach ($p in $o.opord.paragraphs) { if (-not $p.mark) { throw "paragraph $($p.id) carries no portion mark" } }
  if ($o.text.Length -lt 3000) { throw "rendered order is only $($o.text.Length) characters" }
  if ($o.text -match "[$([char]0x2014)$([char]0x2013)$([char]0x00b7)]") { throw "rendered order carries banned punctuation" }
  if ($o.sync.phases.Count -lt 2) { throw "sync matrix has $($o.sync.phases.Count) phases" }
  if ($o.sync.rows.Count -lt 1) { throw "sync matrix has no task organisation rows" }
  if ($o.sync.unitRows.Count -lt 5) { throw "sync matrix has no unit rows" }
  $joined = $false
  foreach ($row in $o.sync.rows) { foreach ($cell in $row.cells) { foreach ($t in $cell.tasks) { if ($t.subTaskTitle) { $joined = $true } } } }
  if (-not $joined) { throw "no cell joins a tasking to its mission sub-task" }
  if ($o.dsm.rows.Count -lt 3) { throw "decision support matrix has $($o.dsm.rows.Count) rows" }
  foreach ($r in $o.dsm.rows) {
    if (-not $r.ltiov) { throw "decision $($r.id) carries no latest time to decide" }
    if ($r.criteria.Count -lt 2) { throw "decision $($r.id) carries no criteria" }
  }
}

# 18 - A commander decision cuts a fragmentary order under their name.
# Self-contained: the run from step 6 was wiped by the reset in step 12.
Step "18 Fragmentary orders are cut on decisions" {
  $coa = (GetJ "/api/coas") | Where-Object { $_.scenarioId -eq "scn-azure-horizon" } | Select-Object -First 1
  $rs = (GetJ "/api/rulesets") | Where-Object { $_.status -eq "active" } | Select-Object -First 1
  $run = PostJ "/api/runs" @{ scenarioId = "scn-azure-horizon"; coaIds = @($coa.id); ruleSetId = $rs.id; engine = "realtime"; speed = 8; label = "E2E frago" }
  $open = $null
  for ($i = 0; $i -lt 90 -and -not $open; $i++) {
    Start-Sleep -Milliseconds 700
    $run = GetJ "/api/runs/$($run.id)"
    $open = $run.branches[0].decisions | Where-Object { $_.status -eq "open" } | Select-Object -First 1
  }
  if (-not $open) { throw "no decision point opened inside the window" }
  $alt = ($open.options | Where-Object { $_.id -ne $open.aiRecommendationId } | Select-Object -First 1).id
  if (-not $alt) { $alt = $open.options[0].id }
  PostJ "/api/runs/$($run.id)/branches/$($run.branches[0].id)/decide" @{ decisionId = $open.id; optionId = $alt; rationale = "E2E override for the order"; decidedBy = "E2E Commander" } | Out-Null
  $f = GetJ "/api/runs/$($run.id)/fragos"
  if ($f.fragos.Count -lt 1) { throw "no fragmentary order cut for a resolved decision" }
  $override = $f.fragos | Where-Object { -not $_.followedMachine } | Select-Object -First 1
  if (-not $override) { throw "the override decision cut no fragmentary order marked as one" }
  if ($override.issuedBy -ne "E2E Commander") { throw "frago issued by $($override.issuedBy)" }
  if (-not $override.marking) { throw "frago carries no marking" }
  if (-not $override.machineLine) { throw "frago does not record what the machine recommended" }
  if ($override.rationale -notmatch "E2E override") { throw "frago lost the commander rationale" }
  if ($f.text.Length -lt 200) { throw "frago text renders empty" }
  if (-not $f.marking) { throw "the frago compilation carries no marking of its own" }
  # A compilation assembled across a marking change takes the highest of them.
  PutJ "/api/classification" @{ level = "secret"; changedBy = "E2E Admin" } | Out-Null
  $open2 = $null
  for ($i = 0; $i -lt 90 -and -not $open2; $i++) {
    Start-Sleep -Milliseconds 700
    $run = GetJ "/api/runs/$($run.id)"
    $open2 = $run.branches[0].decisions | Where-Object { $_.status -eq "open" } | Select-Object -First 1
  }
  if ($open2) {
    PostJ "/api/runs/$($run.id)/branches/$($run.branches[0].id)/decide" @{ decisionId = $open2.id; optionId = $open2.aiRecommendationId; decidedBy = "E2E Commander"; rationale = "second order" } | Out-Null
    $mixed = GetJ "/api/runs/$($run.id)/fragos"
    if ($mixed.marking -notmatch "^SECRET") { throw "a compilation holding a SECRET order is banner-marked $($mixed.marking)" }
    if ($mixed.text -notmatch "^SECRET") { throw "the downloaded compilation opens on the wrong marking" }
  }
  PutJ "/api/classification" @{ level = "restricted"; changedBy = "E2E Admin" } | Out-Null
  PostJ "/api/runs/$($run.id)/control" @{ action = "abort" } | Out-Null
}

# 19 - Classification is one marking, signed, and inherited by documents
Step "19 Classification marking" {
  $c = GetJ "/api/classification"
  if ($c.current.caveats -notcontains "exercise") { throw "EXERCISE caveat is not locked on" }
  $unsigned = PutRaw "/api/classification" @{ level = "secret" }
  if ($unsigned.code -eq 200) { throw "marking changed without a signature" }
  $up = PutJ "/api/classification" @{ level = "secret"; changedBy = "E2E Admin" }
  if ($up.marking -notmatch "^SECRET") { throw "marking is $($up.marking)" }
  $coa = (GetJ "/api/coas") | Where-Object { $_.scenarioId -eq "scn-azure-horizon" } | Select-Object -First 1
  $o = GetJ "/api/coas/$($coa.id)/orders"
  if ($o.opord.marking -notmatch "^SECRET") { throw "the order did not inherit the new marking" }
  if ($o.opord.paragraphs[0].mark -notmatch "S") { throw "portion marks did not follow the level" }
  $back = PutJ "/api/classification" @{ level = "restricted"; changedBy = "E2E Admin" }
  if ($back.marking -notmatch "^RESTRICTED") { throw "marking did not restore" }
  $log = GetJ "/api/audit"
  if (-not ($log | Where-Object { $_.action -eq "classification-changed" })) { throw "marking change not audited" }
}

# 20 - Cues are anchored to the requirements they answer
Step "20 Requirements board anchors cues" {
  $b = GetJ "/api/intel/requirements"
  if ($b.pirs.Count -lt 3) { throw "only $($b.pirs.Count) priority requirements" }
  if ($b.namedAreas.Count -lt 4) { throw "only $($b.namedAreas.Count) named areas" }
  $anchored = 0
  foreach ($p in $b.pirs) { foreach ($i in $p.indicators) { $anchored += $i.cues.Count } }
  if ($anchored -lt 1) { throw "no cue is anchored to any indicator" }
  if ($b.outstanding.Count -lt 1) { throw "every indicator is answered, which means the matching is too loose" }
  $cues = GetJ "/api/intel/cues"
  $m = GetJ "/api/intel/cues/$($cues[0].id)/requirements"
  foreach ($match in $m.matches) {
    if ($match.because.Count -lt 3) { throw "match on $($match.indicatorId) does not show its reasoning" }
    if (-not $match.naiName) { throw "match on $($match.indicatorId) names no area" }
  }
}

$results | Select-Object -Last 10 | ForEach-Object { $_ }
"report source: $($script:reportSource)"
