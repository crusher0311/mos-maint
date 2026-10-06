"""Prepare a non-personal, read-only native baseline. Does not authorize writes."""
import csv
import hashlib
import json
import sys
from datetime import datetime
from decimal import Decimal
from pathlib import Path

source = Path(sys.argv[1])
assessment = json.loads(Path("docs/reporting/jwt-native-export-assessment.json").read_text())
digest = hashlib.sha256(source.read_bytes()).hexdigest()
assert digest == assessment["sha256"], "Native export differs from assessed evidence"
orders = {}
excluded = {"credits": 0, "protected_701_september": 0}
with source.open(encoding="utf-8-sig", newline="") as handle:
    for row in csv.DictReader(handle):
        location = row["Location"].split("-", 1)[0].strip()
        if location not in {str(n) for n in range(701, 711)}:
            continue
        day = datetime.strptime(row["Invoiced"], "%m/%d/%Y")
        if day.year != 2026 or day.month not in (8, 9):
            continue
        if row["Type"] == "Credit Invoice":
            excluded["credits"] += 1
            continue
        assert row["Type"] == "Invoice", "Unrecognized native disposition"
        if location == "701" and day.month == 9:
            excluded["protected_701_september"] += 1
            continue
        wo, invoice = row["Work Order #"], row["Invoice #"]
        assert wo.isascii() and wo.isdigit() and invoice.isascii() and invoice.isdigit()
        shop = int(location) - 474
        key = (shop, wo, invoice)
        entry = orders.setdefault(key, {
            "shopId": shop, "wo": wo, "invoice": invoice,
            "date": day.strftime("%Y-%m-%d"), "labor": Decimal(0), "hours": Decimal(0),
        })
        assert entry["date"] == day.strftime("%Y-%m-%d"), "Conflicting native dates"
        entry["labor"] += Decimal(row["Labor Total"])
        entry["hours"] += Decimal(row["Labor Hours Billed"])
assert len(orders) == 12397, "Unexpected August/September ordinary-invoice population"
identities = []
for entry in orders.values():
    cents = entry["labor"] * 100
    assert cents.is_finite() and cents == cents.to_integral_value(), "Non-cent native total"
    assert entry["hours"].is_finite(), "Missing hours"
    identities.append({
        "shopId": entry["shopId"], "wo": entry["wo"], "invoice": entry["invoice"],
        "date": entry["date"], "laborCents": int(cents), "hours": str(entry["hours"]),
    })
identities.sort(key=lambda n: (n["shopId"], n["date"], n["wo"], n["invoice"]))
assert len({(n["shopId"], n["wo"]) for n in identities}) == len(identities), "Ambiguous native WO"
windows = sorted({f'{n["shopId"]}:{n["date"]}' for n in identities})
assert len(windows) <= 580
payload = {
    "version": 1, "sourceSha256": digest, "scope": "JWT ordinary invoices, August/September 2026",
    "protected": "All location 701 September invoices and all credits excluded",
    "windowKeys": windows, "orders": identities,
}
output = Path("docs/reporting/jwt-overnight-native-manifest.json")
output.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
print(json.dumps({
    "orders": len(identities), "dailyWindows": len(windows),
    "manifestSha256": hashlib.sha256(output.read_bytes()).hexdigest(),
    "excludedPackageRows": excluded,
    "note": "Native candidates only; no provider reads or production writes. Identity preview required.",
}))
