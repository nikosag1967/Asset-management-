# Runbook

## 1. Entra app registration (once)
1. Entra admin center -> App registrations -> New: `AssetInventory-Reader`, single tenant.
2. API permissions -> Microsoft Graph -> **Application** permissions, then *Grant admin consent*:
   - `DeviceManagementManagedDevices.Read.All`
   - `Sites.Selected`
3. Grant the app **read** on the single Assets SharePoint site only (needs an admin; Graph):
   `POST https://graph.microsoft.com/v1.0/sites/{siteId}/permissions`
   body: `{"roles":["read"],"grantedToIdentities":[{"application":{"id":"<clientId>","displayName":"AssetInventory-Reader"}}]}`
4. Certificates & secrets -> upload the public `.cer` (create with `New-SelfSignedCertificate -Subject CN=AssetInventory -CertStoreLocation Cert:\LocalMachine\My -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddYears(2)`; export the public part). Note the expiry date in your calendar.
5. Give the service account read access to the cert private key (certlm.msc -> Manage Private Keys).

## 2. SharePoint (once)
Site "Assets", with:

**List `Asset Register`** (Title = asset tag, e.g. AST-00123). Columns (internal names must match `config.json -> sharePoint.registerFields`):
SerialNumber (text, indexed), Category (choice), Manufacturer, Model, PurchaseDate (date), PurchasePrice (currency), Supplier, InvoiceNo,
WarrantyEnd (date), CostCentre, Department, Location, LifecycleStatus (choice: In stock / In use / In repair / Lost / Retired), AssignedTo (text), ReplaceDate (date), Notes.

**Library `Asset Documents`** with columns `AssetKey` (multi-line plain text: serial numbers and/or asset tags, separated by `;` or new lines – one invoice can list many devices), `DocType` (choice: Invoice, Warranty, Delivery note, Contract/Lease, Handover form, Repair report, Disposal certificate), `ValidUntil` (date).
Fallback: if AssetKey is empty, a file name starting with a known serial/tag (`SN123456_Invoice.pdf`) is matched automatically.

**List `Licenses & Certificates`** (one row per license/certificate – including S/MIME and other certs that live outside Entra). Column internal names must match `config.json -> licenses.fields`:
Title (name, e.g. "S/MIME - Maria Papadopoulou"), ItemType (choice: License / Certificate / Subscription / Other), Subtype (choice: S/MIME, TLS/SSL, Code signing, Client auth/VPN, Perpetual, Subscription, Maintenance, Other), Vendor (vendor or issuing CA), Reference (serial/thumbprint/order no.), SeatsTotal (number, default 1), StartDate, ExpiryDate, AutoRenew (yes/no), RenewalCost, Owner (person responsible for renewal – use their e-mail/UPN if you want them mailed by the digest), LifecycleStatus (choice: Active / Renewed / Revoked / Retired), RenewedBy (lookup to this same list; exposed to Graph as `RenewedByLookupId`), and three multi-line plain-text columns **AssignedUsers** (UPN/e-mail, one per line or `;`), **AssignedDevices** (serial, asset tag or device name) and **AssignedResources** (free text: servers, shared mailboxes, websites…).
Seats used = number of assignees. Items with status Renewed/Revoked/Retired are never coloured or alerted. Documents for an item go into `Asset Documents` with AssetKey = the item's Title or Reference.
**Never store license keys or private keys in SharePoint** – keep them in the password manager and put only a reference in `Reference`.

Get IDs: `GET /sites/{hostname}:/sites/Assets` (site id) and `GET /sites/{siteId}/lists?$select=id,displayName`.

## 3. Server
- Windows Server / VM, PowerShell 7 (or 5.1): `Install-Module Microsoft.Graph.Authentication -Scope AllUsers`.
- IIS with Static Content + Windows Authentication; HTTPS binding.
- Service account (gMSA preferred), e.g. `svc-assetsync`.

## 4. Deploy
1. Copy the repo to e.g. `D:\AssetMgmt`. `Copy-Item config.example.json config.json` and fill tenantId, clientId, thumbprint, SharePoint ids.
2. IIS site root = `D:\AssetMgmt\web`; disable Anonymous, enable Windows Authentication, add authorization rule allowing only the viewers AD group; directory browsing off; for `data/*.json` add response header `Cache-Control: no-store`.
3. NTFS: service account = Modify on `web\data` and `logs`; IIS app pool identity = Read on `web`; nobody else needs `config.json`.

## 5. Scheduled task
```powershell
$a = New-ScheduledTaskAction -Execute 'pwsh.exe' -Argument '-NoProfile -File D:\AssetMgmt\scripts\Get-IntuneAssets.ps1'
$t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 4)
$p = New-ScheduledTaskPrincipal -UserId 'DOMAIN\svc-assetsync$' -LogonType Password -RunLevel Limited
$s = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 10) -StartWhenAvailable
Register-ScheduledTask -TaskName 'AssetSync' -Action $a -Trigger $t -Principal $p -Settings $s
```

### 5b. Expiry digest (daily)
`scripts\Send-ExpiryDigest.ps1` reads `devices.json` and notifies when a license/certificate reaches 60 / 30 / 14 / 7 days before expiry (`digest.thresholds`) and when it expires. Each stage is sent once per item and expiry date (state in `data\alert-state.json`); changing the expiry date (renewal) re-arms the item. It also warns once a day if `devices.json` is older than `digest.maxDataAgeHours`.
```powershell
$a = New-ScheduledTaskAction -Execute 'pwsh.exe' -Argument '-NoProfile -File D:\AssetMgmt\scripts\Send-ExpiryDigest.ps1'
$t = New-ScheduledTaskTrigger -Daily -At 7:30
Register-ScheduledTask -TaskName 'AssetExpiryDigest' -Action $a -Trigger $t -Principal $p -Settings $s   # same principal/settings as above
```
- **Teams:** put a webhook URL in `alerts.teamsWebhookUrl` (the script posts `{"text": "..."}`; if you use a Power Automate *Workflows* webhook, adapt its trigger to accept that payload).
- **E-mail (optional):** set `digest.email.enabled=true`, `from`, `to`, `notifyOwners`. Needs the Graph application permission `Mail.Send` – restrict it to the one sender mailbox with an Exchange *application access policy* (`New-ApplicationAccessPolicy`), otherwise the app could send as anyone.
- Test without sending anything: `pwsh scripts\Send-ExpiryDigest.ps1 -DryRun`.
- Colours in the web app use `expiry.warnDays` (amber, default 60) and `expiry.critDays` (red, default 30); expired items are shown in strong red.

## 6. First run / verification
- Run the script by hand as the service account. Check `logs\asset-sync.log` and `web\data\devices.json`.
- Compare device counts per OS with Intune portal -> Devices -> All devices. Spot-check 5 devices (serial, user, last sync).
- Break the cert thumbprint temporarily: the old JSON must stay, the log shows ERROR, the Teams alert fires (if configured), and after 24h the site shows the red stale banner.
- Browse as an allowed user and as a non-allowed user.

## 7. Operations
- **Cert renewal:** create new cert, upload public part to the app, update `certificateThumbprint`, delete the old one. Do this before expiry.
- **Job failing:** check `logs\asset-sync.log`; common causes – expired cert, consent removed, Graph throttling (script retries), SharePoint column renamed (update `config.json` field names).
- **BYOD:** set `includeByod` to false to exclude personally-owned devices.
- **Safety:** the script refuses to overwrite `devices.json` if Intune returns 0 devices.
