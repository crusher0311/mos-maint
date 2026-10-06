"""Read-only, non-personal location-701 September-2026 export projection."""
import csv
import json
import sys
from datetime import datetime
from decimal import Decimal

groups = {}
with open(sys.argv[1], encoding="utf-8-sig", newline="") as source:
    for row in csv.DictReader(source):
        if row["Location"].split("-", 1)[0].strip() != "701":
            continue
        date = datetime.strptime(row["Invoiced"], "%m/%d/%Y")
        if date.year != 2026 or date.month != 9:
            continue
        key = (row["Work Order #"], row["Invoice #"], row["Type"])
        assert key[0].isdigit() and key[1].isdigit()
        assert key[2] in ("Invoice", "Credit Invoice")
        entry = groups.setdefault(key, {
            "wo": key[0], "invoice": key[1], "kind": key[2],
            "date": date.strftime("%Y-%m-%d"), "hours": Decimal(0),
            "labor": Decimal(0),
        })
        assert entry["date"] == date.strftime("%Y-%m-%d")
        entry["hours"] += Decimal(row["Labor Hours Billed"])
        entry["labor"] += Decimal(row["Labor Total"])
assert len(groups) <= 1000
with open("/tmp/jwt-native-september.json", "w") as output:
    json.dump([{**v, "hours": str(v["hours"]), "labor": str(v["labor"])}
               for v in groups.values()], output)
print(f"Extracted {len(groups)} non-personal invoice aggregates.")
