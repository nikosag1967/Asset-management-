<#
.SYNOPSIS
  Collects device data from Intune (Microsoft Graph), merges the SharePoint
  "Asset Register" list and "Asset Documents" library, and writes devices.json.

.DESCRIPTION
  Read-only against Microsoft Graph. Run from Task Scheduler (see docs/runbook.md).
  Requires: PowerShell 7 (or 5.1) + module Microsoft.Graph.Authentication.
  App permissions: DeviceManagementManagedDevices.Read.All, Sites.Selected (read on the Assets site).

.PARAMETER ConfigPath
  Path to config.json (copy of config.example.json). Default: ..\config.json next to this script.
#>
[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config.json')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------- helpers ----------
function Resolve-RelPath([string]$p) {
    if ([System.IO.Path]::IsPathRooted($p)) { return $p }
    return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $p))
}

function Write-Log([string]$msg, [string]$level = 'INFO') {
    $line = '{0:u} [{1}] {2}' -f (Get-Date), $level, $msg
    Write-Host $line
    if ($script:LogPath) {
        $dir = Split-Path $script:LogPath -Parent
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        # simple rotation at 5 MB
        if ((Test-Path $script:LogPath) -and (Get-Item $script:LogPath).Length -gt 5MB) {
            Move-Item $script:LogPath ($script:LogPath + '.1') -Force
        }
        Add-Content -Path $script:LogPath -Value $line
    }
}

function Send-Alert([string]$text) {
    if ($script:Config.alerts.teamsWebhookUrl) {
        try {
            $body = @{ text = "Asset sync: $text" } | ConvertTo-Json
            Invoke-RestMethod -Uri $script:Config.alerts.teamsWebhookUrl -Method Post -Body $body -ContentType 'application/json' | Out-Null
        } catch { Write-Log "Alert failed: $($_.Exception.Message)" 'WARN' }
    }
}

# Graph GET with paging + throttling/5xx retry
function Invoke-GraphPaged([string]$uri) {
    $results = New-Object System.Collections.Generic.List[object]
    while ($uri) {
        $attempt = 0
        while ($true) {
            try {
                $resp = Invoke-MgGraphRequest -Method GET -Uri $uri -OutputType PSObject
                break
            } catch {
                $attempt++
                $status = $null
                if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
                if ($attempt -le 5 -and ($status -eq 429 -or ($status -ge 500 -and $status -lt 600))) {
                    $wait = [math]::Min(60, [math]::Pow(2, $attempt) * 2)
                    Write-Log "Graph $status, retry $attempt in ${wait}s" 'WARN'
                    Start-Sleep -Seconds $wait
                } else { throw }
            }
        }
        foreach ($v in $resp.value) { $results.Add($v) }
        $uri = $resp.'@odata.nextLink'
    }
    return $results
}

function Normalize-Key([object]$s) {
    if ($null -eq $s) { return '' }
    return ([string]$s).Trim().ToUpperInvariant()
}

function Get-Field($fields, [string]$name) {
    if (-not $name) { return $null }
    $p = $fields.PSObject.Properties[$name]
    if ($p) { return $p.Value }
    return $null
}

function To-DateOnly($v) {
    if (-not $v) { return $null }
    try { return ([datetime]$v).ToString('yyyy-MM-dd') } catch { return $null }
}

function Get-DeviceType([string]$os, [string]$model) {
    switch -Regex ($os) {
        'Windows'  { return 'Laptop/Desktop' }
        'macOS'    { return 'Laptop/Desktop' }
        'iOS|iPadOS' { if ($model -match 'iPad') { return 'Tablet' } else { return 'Phone' } }
        'Android'  { return 'Phone/Tablet' }
        default    { return 'Other' }
    }
}

# ---------- main ----------
$script:LogPath = $null
try {
    $script:Config = Get-Content -Raw -Path (Resolve-RelPath $ConfigPath) | ConvertFrom-Json
    $cfg = $script:Config
    $script:LogPath = Resolve-RelPath $cfg.logPath
    $outputPath  = Resolve-RelPath $cfg.outputPath
    $historyPath = Resolve-RelPath $cfg.historyPath
    $staleDays   = [int]$cfg.staleAfterDays

    Write-Log 'Sync started'
    Import-Module Microsoft.Graph.Authentication -ErrorAction Stop
    Connect-MgGraph -TenantId $cfg.tenantId -ClientId $cfg.clientId -CertificateThumbprint $cfg.certificateThumbprint -NoWelcome

    # ----- Intune managed devices -----
    $select = 'id,deviceName,serialNumber,manufacturer,model,operatingSystem,osVersion,userPrincipalName,userDisplayName,' +
              'enrolledDateTime,lastSyncDateTime,complianceState,managementState,deviceEnrollmentType,imei,wiFiMacAddress,' +
              'totalStorageSpaceInBytes,freeStorageSpaceInBytes,isEncrypted,managedDeviceOwnerType'
    $intune = Invoke-GraphPaged "https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?`$select=$select&`$top=500"
    Write-Log "Intune devices: $($intune.Count)"
    if ($intune.Count -eq 0) { throw 'Intune returned 0 devices - refusing to overwrite data file.' }

    # ----- SharePoint register + documents -----
    $register = @(); $docs = @()
    $sp = $cfg.sharePoint
    if ($sp.enabled) {
        $base = "https://graph.microsoft.com/v1.0/sites/$($sp.siteId)/lists"
        $register = Invoke-GraphPaged "$base/$($sp.registerListId)/items?`$expand=fields&`$top=999"
        $docs     = Invoke-GraphPaged "$base/$($sp.documentsListId)/items?`$expand=fields&`$top=999"
        Write-Log "Register rows: $($register.Count); documents: $($docs.Count)"
    }

    # index register by serial and by asset tag
    $rf = $sp.registerFields
    $regBySerial = @{}; $regByTag = @{}
    foreach ($r in $register) {
        $f = $r.fields
        $serial = Normalize-Key (Get-Field $f $rf.serial)
        $tag    = Normalize-Key (Get-Field $f $rf.assetTag)
        if ($serial) { $regBySerial[$serial] = $r }
        if ($tag)    { $regByTag[$tag] = $r }
    }

    # documents: attach to every key listed in AssetKey (; , or newline separated), else filename prefix
    $df = $sp.documentFields
    $docsByKey = @{}
    $docsMatched = New-Object System.Collections.Generic.HashSet[string]
    $allKeys = New-Object System.Collections.Generic.HashSet[string]
    foreach ($k in $regBySerial.Keys) { [void]$allKeys.Add($k) }
    foreach ($k in $regByTag.Keys)    { [void]$allKeys.Add($k) }
    foreach ($i in $intune) { $k = Normalize-Key $i.serialNumber; if ($k) { [void]$allKeys.Add($k) } }

    $orphanDocs = New-Object System.Collections.Generic.List[object]
    foreach ($d in $docs) {
        $f = $d.fields
        $name = [string](Get-Field $f 'FileLeafRef'); if (-not $name) { $name = [string](Get-Field $f 'LinkFilename') }
        if (-not $name) { $name = [string](Get-Field $f 'Title') }
        $keys = @()
        $raw = Get-Field $f $df.assetKey
        if ($raw) { $keys = @(([string]$raw) -split '[;,\r\n]+' | ForEach-Object { Normalize-Key $_ } | Where-Object { $_ }) }
        if (-not $keys) {
            $prefix = Normalize-Key (($name -split '[_ ]')[0])
            if ($prefix -and $allKeys.Contains($prefix)) { $keys = @($prefix) }
        }
        $entry = [ordered]@{
            name       = $name
            docType    = [string](Get-Field $f $df.docType)
            validUntil = To-DateOnly (Get-Field $f $df.validUntil)
            webUrl     = $d.webUrl
        }
        if (-not $keys) { $orphanDocs.Add($entry); continue }
        $hit = $false
        foreach ($k in $keys) {
            if ($allKeys.Contains($k)) {
                if (-not $docsByKey.ContainsKey($k)) { $docsByKey[$k] = New-Object System.Collections.Generic.List[object] }
                $docsByKey[$k].Add($entry); $hit = $true
            }
        }
        if (-not $hit) { $orphanDocs.Add($entry) }
    }

    # ----- build asset objects -----
    $now = Get-Date
    $assets = New-Object System.Collections.Generic.List[object]
    $usedRegister = New-Object System.Collections.Generic.HashSet[string]

    function New-RegisterBits($reg) {
        $f = if ($reg) { $reg.fields } else { $null }
        $g = { param($n) if ($f) { Get-Field $f $rf.$n } else { $null } }
        return [ordered]@{
            assetTag      = [string](& $g 'assetTag')
            category      = [string](& $g 'category')
            purchaseDate  = To-DateOnly (& $g 'purchaseDate')
            purchasePrice = (& $g 'purchasePrice')
            supplier      = [string](& $g 'supplier')
            invoiceNo     = [string](& $g 'invoiceNo')
            warrantyEnd   = To-DateOnly (& $g 'warrantyEnd')
            costCentre    = [string](& $g 'costCentre')
            department    = [string](& $g 'department')
            location      = [string](& $g 'location')
            status        = [string](& $g 'status')
            assignedTo    = [string](& $g 'assignedTo')
            replaceDate   = To-DateOnly (& $g 'replaceDate')
            notes         = [string](& $g 'notes')
        }
    }

    foreach ($i in $intune) {
        if (-not $cfg.includeByod -and $i.managedDeviceOwnerType -eq 'personal') { continue }
        $serialKey = Normalize-Key $i.serialNumber
        $reg = $null
        if ($serialKey -and $regBySerial.ContainsKey($serialKey)) { $reg = $regBySerial[$serialKey] }
        $bits = New-RegisterBits $reg
        if ($reg) { [void]$usedRegister.Add($reg.id) }

        $last = $null; $days = $null
        if ($i.lastSyncDateTime) { $last = [datetime]$i.lastSyncDateTime; $days = [int]($now.ToUniversalTime() - $last.ToUniversalTime()).TotalDays }
        $totalGB = if ($i.totalStorageSpaceInBytes) { [math]::Round($i.totalStorageSpaceInBytes / 1GB, 1) } else { $null }
        $freeGB  = if ($i.freeStorageSpaceInBytes)  { [math]::Round($i.freeStorageSpaceInBytes / 1GB, 1) } else { $null }

        $docList = @(); if ($serialKey -and $docsByKey.ContainsKey($serialKey)) { $docList += $docsByKey[$serialKey] }
        $tagKey = Normalize-Key $bits.assetTag
        if ($tagKey -and $docsByKey.ContainsKey($tagKey)) { $docList += $docsByKey[$tagKey] }

        $assets.Add([ordered]@{
            id            = $i.id
            intuneId      = $i.id
            inIntune      = $true
            assetTag      = $bits.assetTag
            deviceName    = $i.deviceName
            type          = if ($bits.category) { $bits.category } else { Get-DeviceType $i.operatingSystem $i.model }
            manufacturer  = $i.manufacturer
            model         = $i.model
            serial        = $i.serialNumber
            os            = $i.operatingSystem
            osVersion     = $i.osVersion
            user          = if ($bits.assignedTo) { $bits.assignedTo } else { $i.userDisplayName }
            userEmail     = $i.userPrincipalName
            department    = $bits.department
            location      = $bits.location
            costCentre    = $bits.costCentre
            status        = if ($bits.status) { $bits.status } else { 'In use' }
            compliance    = $i.complianceState
            managementState = $i.managementState
            lastSync      = if ($last) { $last.ToUniversalTime().ToString('o') } else { $null }
            daysSinceLastSync = $days
            stale         = ($null -ne $days -and $days -gt $staleDays)
            enrolledDate  = To-DateOnly $i.enrolledDateTime
            enrollmentType = $i.deviceEnrollmentType
            ownerType     = $i.managedDeviceOwnerType
            imei          = $i.imei
            mac           = $i.wiFiMacAddress
            storageTotalGB = $totalGB
            storageFreeGB  = $freeGB
            encrypted     = $i.isEncrypted
            purchaseDate  = $bits.purchaseDate
            purchasePrice = $bits.purchasePrice
            supplier      = $bits.supplier
            invoiceNo     = $bits.invoiceNo
            warrantyEnd   = $bits.warrantyEnd
            replaceDate   = $bits.replaceDate
            notes         = $bits.notes
            documents     = $docList
        })
    }

    # register rows with no Intune match (monitors, docks, printers, spares, un-enrolled devices)
    foreach ($r in $register) {
        if ($usedRegister.Contains($r.id)) { continue }
        $bits = New-RegisterBits $r
        $serial = [string](Get-Field $r.fields $rf.serial)
        $serialKey = Normalize-Key $serial
        $tagKey = Normalize-Key $bits.assetTag
        $docList = @()
        if ($serialKey -and $docsByKey.ContainsKey($serialKey)) { $docList += $docsByKey[$serialKey] }
        if ($tagKey -and $docsByKey.ContainsKey($tagKey)) { $docList += $docsByKey[$tagKey] }
        $assets.Add([ordered]@{
            id = "sp-$($r.id)"; intuneId = $null; inIntune = $false
            assetTag = $bits.assetTag; deviceName = $null
            type = if ($bits.category) { $bits.category } else { 'Other' }
            manufacturer = [string](Get-Field $r.fields $rf.manufacturer); model = [string](Get-Field $r.fields $rf.model)
            serial = $serial; os = $null; osVersion = $null
            user = $bits.assignedTo; userEmail = $null
            department = $bits.department; location = $bits.location; costCentre = $bits.costCentre
            status = if ($bits.status) { $bits.status } else { 'In stock' }
            compliance = $null; managementState = $null; lastSync = $null; daysSinceLastSync = $null; stale = $false
            enrolledDate = $null; enrollmentType = $null; ownerType = $null; imei = $null; mac = $null
            storageTotalGB = $null; storageFreeGB = $null; encrypted = $null
            purchaseDate = $bits.purchaseDate; purchasePrice = $bits.purchasePrice; supplier = $bits.supplier
            invoiceNo = $bits.invoiceNo; warrantyEnd = $bits.warrantyEnd; replaceDate = $bits.replaceDate
            notes = $bits.notes; documents = $docList
        })
    }

    # ----- change tracking vs previous run -----
    $history = @()
    if (Test-Path $historyPath) { try { $history = @(Get-Content -Raw $historyPath | ConvertFrom-Json) } catch { $history = @() } }
    $removed = @()
    if (Test-Path $outputPath) {
        try {
            $prev = Get-Content -Raw $outputPath | ConvertFrom-Json
            $prevById = @{}; foreach ($p in $prev.assets) { $prevById[$p.id] = $p }
            $curById = @{}; foreach ($a in $assets) { $curById[$a.id] = $a }
            $stamp = $now.ToUniversalTime().ToString('o')
            foreach ($a in $assets) {
                if (-not $prevById.ContainsKey($a.id)) {
                    $history += [ordered]@{ at = $stamp; assetId = $a.id; label = "$($a.deviceName) $($a.serial)"; event = 'added'; detail = '' }
                } else {
                    $p = $prevById[$a.id]
                    if ("$($p.user)" -ne "$($a.user)") { $history += [ordered]@{ at = $stamp; assetId = $a.id; label = "$($a.deviceName)"; event = 'user changed'; detail = "$($p.user) -> $($a.user)" } }
                    if ("$($p.status)" -ne "$($a.status)") { $history += [ordered]@{ at = $stamp; assetId = $a.id; label = "$($a.deviceName)"; event = 'status changed'; detail = "$($p.status) -> $($a.status)" } }
                }
            }
            foreach ($p in $prev.assets) {
                if (-not $curById.ContainsKey($p.id)) {
                    $history += [ordered]@{ at = $stamp; assetId = $p.id; label = "$($p.deviceName) $($p.serial)"; event = 'removed'; detail = "last user: $($p.user)" }
                }
            }
        } catch { Write-Log "Diff against previous file failed: $($_.Exception.Message)" 'WARN' }
    }
    if ($history.Count -gt [int]$cfg.maxHistoryEntries) { $history = $history[($history.Count - [int]$cfg.maxHistoryEntries)..($history.Count - 1)] }
    foreach ($h in $history) { if ($h.event -eq 'removed') { $removed += $h } }

    # ----- write output atomically -----
    $out = [ordered]@{
        generatedAt  = $now.ToUniversalTime().ToString('o')
        source       = 'intune+sharepoint'
        isSample     = $false
        config       = [ordered]@{
            staleAfterDays        = $staleDays
            intunePortalDeviceUrl = $cfg.ui.intunePortalDeviceUrl
            sharePointLibraryUrl  = $sp.libraryUrl
        }
        assets       = $assets
        orphanDocuments = $orphanDocs
        history      = $history
    }
    $json = $out | ConvertTo-Json -Depth 8
    $dir = Split-Path $outputPath -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $tmp = "$outputPath.tmp"
    [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -Path $tmp -Destination $outputPath -Force
    $history | ConvertTo-Json -Depth 5 | Set-Content -Path $historyPath -Encoding UTF8

    Write-Log "Sync OK: $($assets.Count) assets written to $outputPath"
    Disconnect-MgGraph | Out-Null
    exit 0
}
catch {
    Write-Log "Sync FAILED: $($_.Exception.Message)" 'ERROR'
    Send-Alert "FAILED - $($_.Exception.Message)"
    exit 1
}
