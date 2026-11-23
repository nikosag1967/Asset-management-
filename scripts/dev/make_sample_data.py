#!/usr/bin/env python3
"""Generate web/data/devices.sample.json with the same schema Get-IntuneAssets.ps1 writes.
Lets you develop/demo the web app without a tenant. Deterministic (seeded)."""
import json, random, datetime as dt, pathlib

random.seed(42)
today = dt.date.today()
now = dt.datetime.now(dt.timezone.utc)

people = [("Maria Papadopoulou", "Finance"), ("John Smith", "IT"), ("Elena Georgiou", "HR"),
          ("Nikos Dimitriou", "Sales"), ("Anna Kowalski", "Sales"), ("Peter Novak", "Operations"),
          ("Sofia Rossi", "Marketing"), ("Luca Bianchi", "Operations"), ("Eva Müller", "Finance"),
          ("Dimitris Alexiou", "IT"), ("Kate Brown", "Legal"), ("Tom Wilson", "Sales")]
sites = ["Athens HQ", "Thessaloniki", "Remote", "Warehouse"]
costc = {"Finance": "CC100", "IT": "CC200", "HR": "CC110", "Sales": "CC300", "Operations": "CC400",
         "Marketing": "CC310", "Legal": "CC120"}
suppliers = ["Dell Direct", "Public", "Apple Business", "Insight", "Plaisio"]
models = {
    "Windows": [("Dell", "Latitude 5540", 1150, "10.0.22631"), ("Dell", "Latitude 7440", 1650, "10.0.22631"),
                ("Lenovo", "ThinkPad T14 Gen 3", 1300, "10.0.19045"), ("HP", "EliteBook 840 G9", 1400, "10.0.22631")],
    "macOS": [("Apple", "MacBook Pro 14", 2400, "14.5"), ("Apple", "MacBook Air M2", 1500, "14.5")],
    "iOS": [("Apple", "iPhone 14", 900, "17.5"), ("Apple", "iPhone 13", 800, "16.7"), ("Apple", "iPad 10th gen", 600, "17.5")],
    "Android": [("Samsung", "Galaxy S23", 850, "14"), ("Samsung", "Galaxy Tab A9", 250, "13")],
}
weights = [("Windows", 22), ("macOS", 5), ("iOS", 9), ("Android", 6)]
doc_types = ["Invoice", "Warranty", "Delivery note", "Handover form"]


def d(x):
    return x.isoformat() if x else None


assets, n = [], 0
for os_name, count in weights:
    for _ in range(count):
        n += 1
        mfr, model, price, ver = random.choice(models[os_name])
        user, dept = random.choice(people)
        age_days = random.choice([60, 200, 400, 700, 900, 1100, 1300, 1500, 1700])
        pdate = today - dt.timedelta(days=age_days + random.randint(0, 120))
        warranty_years = 3 if os_name in ("Windows",) else (1 if os_name in ("Android", "iOS") else 3)
        wend = pdate + dt.timedelta(days=365 * warranty_years)
        days_sync = random.choice([0, 0, 0, 1, 1, 2, 3, 5, 12, 45, 90]) if random.random() > 0.1 else random.choice([0, 1])
        status = random.choices(["In use", "In stock", "In repair"], [85, 9, 6])[0]
        serial = f"{mfr[:2].upper()}{random.randint(10**6, 10**7 - 1)}"
        tag = f"AST-{n:05d}"
        docs = []
        inv = f"INV-{random.randint(2020, 2026)}-{random.randint(100, 999)}"
        if random.random() > 0.15:
            docs.append({"name": f"{serial}_Invoice_{pdate:%Y-%m}.pdf", "docType": "Invoice", "validUntil": None,
                         "webUrl": f"https://contoso.sharepoint.com/sites/Assets/Asset%20Documents/{serial}_Invoice.pdf"})
        if random.random() > 0.3:
            docs.append({"name": f"{serial}_Warranty.pdf", "docType": "Warranty", "validUntil": d(wend),
                         "webUrl": f"https://contoso.sharepoint.com/sites/Assets/Asset%20Documents/{serial}_Warranty.pdf"})
        if random.random() > 0.6:
            docs.append({"name": f"{serial}_Handover.pdf", "docType": "Handover form", "validUntil": None,
                         "webUrl": f"https://contoso.sharepoint.com/sites/Assets/Asset%20Documents/{serial}_Handover.pdf"})
        total = random.choice([256, 512, 1024]) if os_name in ("Windows", "macOS") else random.choice([128, 256])
        assets.append({
            "id": f"intune-{n:04d}", "intuneId": f"{random.getrandbits(32):08x}-0000-4000-8000-{n:012d}", "inIntune": True,
            "assetTag": tag, "deviceName": f"{dept[:3].upper()}-{os_name[:3].upper()}-{n:03d}",
            "type": "Laptop/Desktop" if os_name in ("Windows", "macOS") else ("Tablet" if "iPad" in model or "Tab" in model else "Phone"),
            "manufacturer": mfr, "model": model, "serial": serial, "os": os_name, "osVersion": ver,
            "user": user if status == "In use" else "", "userEmail": user.lower().replace(" ", ".") + "@contoso.com",
            "department": dept, "location": random.choice(sites), "costCentre": costc[dept], "status": status,
            "compliance": random.choices(["compliant", "noncompliant", "inGracePeriod"], [88, 8, 4])[0],
            "managementState": "managed",
            "lastSync": (now - dt.timedelta(days=days_sync, hours=random.randint(0, 20))).isoformat(),
            "daysSinceLastSync": days_sync, "stale": days_sync > 30,
            "enrolledDate": d(pdate + dt.timedelta(days=3)),
            "enrollmentType": "windowsAzureADJoin" if os_name == "Windows" else "userEnrollment",
            "ownerType": "company", "imei": None if os_name in ("Windows", "macOS") else str(random.randint(10**14, 10**15 - 1)),
            "mac": ":".join(f"{random.randint(0, 255):02X}" for _ in range(6)),
            "storageTotalGB": total, "storageFreeGB": round(total * random.uniform(0.1, 0.7), 1),
            "encrypted": random.random() > 0.05,
            "purchaseDate": d(pdate), "purchasePrice": price, "supplier": random.choice(suppliers), "invoiceNo": inv,
            "warrantyEnd": d(wend), "replaceDate": d(pdate + dt.timedelta(days=365 * (4 if os_name in ("Windows", "macOS") else 3))),
            "notes": "", "documents": docs,
        })

# non-Intune items
for k, (cat, mfr, model, price) in enumerate([("Monitor", "Dell", "U2723QE", 520), ("Monitor", "Dell", "P2422H", 190),
                                              ("Docking station", "Dell", "WD19S", 220), ("Printer", "HP", "LaserJet M428", 450),
                                              ("Docking station", "Lenovo", "ThinkPad Dock", 180), ("Monitor", "LG", "27UK850", 400)]):
    n += 1
    pdate = today - dt.timedelta(days=random.randint(100, 1400))
    serial = f"{mfr[:2].upper()}{random.randint(10**6, 10**7 - 1)}"
    assets.append({
        "id": f"sp-{n}", "intuneId": None, "inIntune": False, "assetTag": f"AST-{n:05d}", "deviceName": None, "type": cat,
        "manufacturer": mfr, "model": model, "serial": serial, "os": None, "osVersion": None, "user": "", "userEmail": None,
        "department": random.choice(list(costc)), "location": random.choice(sites), "costCentre": None,
        "status": random.choice(["In use", "In stock"]), "compliance": None, "managementState": None, "lastSync": None,
        "daysSinceLastSync": None, "stale": False, "enrolledDate": None, "enrollmentType": None, "ownerType": None,
        "imei": None, "mac": None, "storageTotalGB": None, "storageFreeGB": None, "encrypted": None,
        "purchaseDate": d(pdate), "purchasePrice": price, "supplier": random.choice(suppliers), "invoiceNo": f"INV-{random.randint(2020, 2026)}-{random.randint(100, 999)}",
        "warrantyEnd": d(pdate + dt.timedelta(days=365 * 3)), "replaceDate": None, "notes": "", "documents": [],
    })

hist = [
    {"at": (now - dt.timedelta(days=1)).isoformat(), "assetId": assets[3]["id"], "label": assets[3]["deviceName"], "event": "user changed", "detail": "Kate Brown -> " + assets[3]["user"]},
    {"at": (now - dt.timedelta(days=2)).isoformat(), "assetId": assets[10]["id"], "label": assets[10]["deviceName"], "event": "status changed", "detail": "In use -> In repair"},
    {"at": (now - dt.timedelta(days=5)).isoformat(), "assetId": "gone-1", "label": "SAL-WIN-099 DE1234567", "event": "removed", "detail": "last user: Former Employee"},
    {"at": (now - dt.timedelta(days=6)).isoformat(), "assetId": assets[20]["id"], "label": assets[20]["deviceName"], "event": "added", "detail": ""},
]

out = {
    "generatedAt": now.isoformat(), "source": "sample", "isSample": True,
    "config": {"staleAfterDays": 30,
               "intunePortalDeviceUrl": "https://intune.microsoft.com/#view/Microsoft_Intune_Devices/DeviceSettingsMenuBlade/~/overview/mdmDeviceId/{intuneId}",
               "sharePointLibraryUrl": "https://contoso.sharepoint.com/sites/Assets/Asset%20Documents"},
    "assets": assets,
    "orphanDocuments": [{"name": "Scan_0042.pdf", "docType": "Invoice", "validUntil": None, "webUrl": "https://contoso.sharepoint.com/sites/Assets/Asset%20Documents/Scan_0042.pdf"}],
    "history": hist,
}
path = pathlib.Path(__file__).resolve().parents[2] / "web" / "data" / "devices.sample.json"
path.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
print(f"wrote {path} ({len(assets)} assets)")
