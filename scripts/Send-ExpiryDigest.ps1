<#
.SYNOPSIS
  Daily expiry digest for licenses & certificates (reads web\data\devices.json, written by Get-IntuneAssets.ps1).

.DESCRIPTION
  Sends a Teams message (and optionally e-mail via Graph) when an Active item reaches a new alert stage:
  60 / 30 / 14 / 7 days before expiry (configurable) and "expired". Each stage is sent once per item and
  expiry date; changing the expiry date (renewal) re-arms the item. State is kept in digest.statePath.
  Also alerts once a day if devices.json is older than digest.maxDataAgeHours.

.PARAMETER DryRun
  Print what would be sent; send nothing and do not update the state file.
#>
[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config.json'),
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-RelPath([string]$p) {
    if ([System.IO.Path]::IsPathRooted($p)) { return $p }
    return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $p))
}
function Write-Log([string]$msg, [string]$level = 'INFO') {
    $line = '{0:u} [{1}] digest: {2}' -f (Get-Date), $level, $msg
    Write-Host $line
    if ($script:LogPath) {
        $dir = Split-Path $script:LogPath -Parent
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Add-Content -Path $script:LogPath -Value $line
    }
}
function Get-Opt($obj, [string]$name, $default) {
    if ($null -ne $obj -and $obj.PSObject.Properties[$name]) { return $obj.$name }
    return $default
}

$script:LogPath = $null
try {
    $cfg = Get-Content -Raw -Path (Resolve-RelPath $ConfigPath) | ConvertFrom-Json
    $script:LogPath = Resolve-RelPath $cfg.logPath
    $dg = Get-Opt $cfg 'digest' $null
    $thresholds = @(Get-Opt $dg 'thresholds' @(60, 30, 14, 7)) | Sort-Object -Descending
    $statePath  = Resolve-RelPath (Get-Opt $dg 'statePath' '..\data\alert-state.json')
    $maxAgeHrs  = [int](Get-Opt $dg 'maxDataAgeHours' 24)
    $teamsUrl   = [string](Get-Opt (Get-Opt $cfg 'alerts' $null) 'teamsWebhookUrl' '')
    $mail       = Get-Opt $dg 'email' $null
    $mailOn     = [bool](Get-Opt $mail 'enabled' $false)
    $dataPath   = Resolve-RelPath $cfg.outputPath

    if (-not (Test-Path $dataPath)) { throw "Data file not found: $dataPath" }
    $data = Get-Content -Raw -Path $dataPath | ConvertFrom-Json
    $today = (Get-Date).Date
    $state = @{}
    if (Test-Path $statePath) {
        $raw = Get-Content -Raw -Path $statePath | ConvertFrom-Json
        foreach ($p in $raw.PSObject.Properties) { $state[$p.Name] = $p.Value }
    }

    # stage: 0 = nothing, 1..N = threshold index reached (60,30,14,7), N+1 = expired
    $expiredStage = $thresholds.Count + 1
    function Get-Stage([int]$days) {
        if ($days -lt 0) { return $expiredStage }
        $stage = 0
        for ($i = 0; $i -lt $thresholds.Count; $i++) { if ($days -le $thresholds[$i]) { $stage = $i + 1 } }
        return $stage
    }

    $due = New-Object System.Collections.Generic.List[object]
    $newState = @{}
    foreach ($p in $state.GetEnumerator()) { $newState[$p.Key] = $p.Value }
    $licenses = @(); if ($data.PSObject.Properties['licenses']) { $licenses = @($data.licenses) }

    foreach ($l in $licenses) {
        if ($l.status -match '^(Renewed|Revoked|Retired)$') { $newState.Remove($l.id); continue }
        if (-not $l.expiryDate) { continue }
        $days = [int][math]::Floor(([datetime]$l.expiryDate - $today).TotalDays)
        $stage = Get-Stage $days
        $prev = $null; if ($state.ContainsKey($l.id)) { $prev = $state[$l.id] }
        $prevStage = 0
        if ($prev -and $prev.expiryDate -eq $l.expiryDate) { $prevStage = [int]$prev.stage }   # new expiry date = re-armed
        if ($stage -gt $prevStage) {
            $due.Add([pscustomobject]@{ item = $l; days = $days; stage = $stage })
        }
        $newState[$l.id] = [pscustomobject]@{ expiryDate = $l.expiryDate; stage = [math]::Max($stage, $prevStage); notified = $prevStage }
    }

    # stale data warning (once per day)
    $staleMsg = $null
    $ageHrs = ((Get-Date).ToUniversalTime() - ([datetime]$data.generatedAt).ToUniversalTime()).TotalHours
    if ($ageHrs -gt $maxAgeHrs) {
        $key = '__datastale'
        if (-not ($state.ContainsKey($key) -and $state[$key].date -eq $today.ToString('yyyy-MM-dd'))) {
            $staleMsg = "Asset data is $([int]$ageHrs) hours old - the sync task may be failing."
            $newState[$key] = [pscustomobject]@{ date = $today.ToString('yyyy-MM-dd') }
        }
    }

    if ($due.Count -eq 0 -and -not $staleMsg) { Write-Log 'Nothing to notify.'; exit 0 }

    # ----- compose -----
    $lines = New-Object System.Collections.Generic.List[string]
    $htmlRows = New-Object System.Collections.Generic.List[string]
    $enc = { param($s) [System.Net.WebUtility]::HtmlEncode([string]$s) }
    foreach ($d in ($due | Sort-Object days)) {
        $l = $d.item
        $when = if ($d.days -lt 0) { "EXPIRED $(-$d.days) d ago" } elseif ($d.days -eq 0) { 'expires TODAY' } else { "expires in $($d.days) d" }
        $who = (@($l.assignments) | ForEach-Object { $_.label }) -join ', '
        $lines.Add("- **$($l.name)** ($($l.itemType)) - $when ($($l.expiryDate)) - owner: $(if ($l.owner) { $l.owner } else { 'NOT SET' }) - assigned: $(if ($who) { $who } else { '-' })")
        $htmlRows.Add("<tr><td>$(& $enc $l.name)</td><td>$(& $enc $l.itemType)</td><td>$(& $enc $when)</td><td>$(& $enc $l.expiryDate)</td><td>$(& $enc $l.owner)</td><td>$(& $enc $who)</td></tr>")
    }
    $text = "Licenses & certificates needing attention`n`n" + ($lines -join "`n")
    if ($staleMsg) { $text += "`n`n$staleMsg" }

    if ($DryRun) { Write-Host "---- DRY RUN ----`n$text`n-----------------"; exit 0 }

    # ----- send -----
    if ($teamsUrl) {
        Invoke-RestMethod -Uri $teamsUrl -Method Post -ContentType 'application/json' -Body (@{ text = $text } | ConvertTo-Json) | Out-Null
        Write-Log "Teams message sent ($($due.Count) items)"
    }
    if ($mailOn -and $due.Count -gt 0) {
        Import-Module Microsoft.Graph.Authentication -ErrorAction Stop
        Connect-MgGraph -TenantId $cfg.tenantId -ClientId $cfg.clientId -CertificateThumbprint $cfg.certificateThumbprint -NoWelcome
        $send = {
            param([string[]]$to, [string]$subject, [string]$html)
            $body = @{ message = @{ subject = $subject; body = @{ contentType = 'HTML'; content = $html }
                       toRecipients = @($to | ForEach-Object { @{ emailAddress = @{ address = $_ } } }) }; saveToSentItems = $false } | ConvertTo-Json -Depth 8
            Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/users/$($mail.from)/sendMail" -Body $body -ContentType 'application/json' | Out-Null
        }
        $head = '<table border="1" cellpadding="4" style="border-collapse:collapse;font-family:Segoe UI,sans-serif;font-size:13px"><tr><th>Item</th><th>Type</th><th>When</th><th>Date</th><th>Owner</th><th>Assigned</th></tr>'
        & $send @($mail.to) "Licenses & certificates expiring ($($due.Count))" ("<p>The following items reached a new expiry stage:</p>$head$($htmlRows -join '')</table>")
        if (Get-Opt $mail 'notifyOwners' $false) {
            foreach ($grp in ($due | Where-Object { $_.item.owner -match '@' } | Group-Object { $_.item.owner })) {
                $rows = ($grp.Group | Sort-Object days | ForEach-Object {
                    $l = $_.item; $who = (@($l.assignments) | ForEach-Object { $_.label }) -join ', '
                    "<tr><td>$(& $enc $l.name)</td><td>$(& $enc $l.itemType)</td><td>$(& $enc $(if ($_.days -lt 0) { "EXPIRED $(-$_.days) d ago" } else { "in $($_.days) d" }))</td><td>$(& $enc $l.expiryDate)</td><td>$(& $enc $l.owner)</td><td>$(& $enc $who)</td></tr>" }) -join ''
                & $send @($grp.Name) 'Your license/certificate is about to expire' ("<p>You are the owner of these items:</p>$head$rows</table>")
            }
        }
        Write-Log 'E-mail digest sent'
        Disconnect-MgGraph | Out-Null
    }
    if (-not $teamsUrl -and -not $mailOn) { Write-Log 'No delivery channel configured (alerts.teamsWebhookUrl / digest.email.enabled).' 'WARN' }

    # state only after successful delivery, so a failed send is retried tomorrow
    $dir = Split-Path $statePath -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $newState | ConvertTo-Json -Depth 4 | Set-Content -Path $statePath -Encoding UTF8
    exit 0
}
catch {
    Write-Log "FAILED: $($_.Exception.Message)" 'ERROR'
    exit 1
}
