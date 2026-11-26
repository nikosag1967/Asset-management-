# Asset Management (Intune-backed)

Read-only asset inventory: a scheduled PowerShell script pulls devices from Intune (Microsoft Graph) and a
SharePoint *Asset Register* list + *Asset Documents* library, merges them into `devices.json`, and a static
HTML app (`web/`) displays it (dashboard, asset list, asset detail with document links, reports).

```
scripts/Get-IntuneAssets.ps1   collector (Task Scheduler, every ~4h)
scripts/Send-ExpiryDigest.ps1  daily Teams/e-mail digest for expiring licenses & certificates
scripts/dev/make_sample_data.py  generates web/data/devices.sample.json for demos/dev
web/                           static app (index.html, app.js, style.css) – no build step
config.example.json            copy to config.json (gitignored) and fill in
docs/runbook.md                setup + operations
```

## Try it without a tenant
```bash
python3 scripts/dev/make_sample_data.py
cd web && python3 -m http.server 8080   # open http://localhost:8080
```
The app falls back to `data/devices.sample.json` (with a "SAMPLE DATA" banner) when `data/devices.json` is absent.

## Going live
Follow `docs/runbook.md`: app registration + certificate, SharePoint list/library, config, scheduled task, IIS.

## Licenses & certificates
Software licenses and certificates (incl. S/MIME issued outside Entra) are kept in a SharePoint list, assigned to users, devices or free-text resources (with seat counts), and shown on the **Licenses & Certs** tab, asset pages, dashboard and reports. Items turn amber at 60 days, red at 30 days and strong red once expired; the daily digest notifies by Teams/e-mail. See the runbook for the list columns.

## Notes
- Both scripts parse cleanly and were exercised against a stubbed Graph module (paging, merge, license assignment resolution, change tracking, digest sending/de-duplication/re-arming). They have **not** been run against a real tenant yet – run `Get-IntuneAssets.ps1` manually first (runbook step 6) and compare counts with the Intune portal.
- Nothing secret is stored in the repo; `config.json`, certificates, logs and real data are gitignored.
