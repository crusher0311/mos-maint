"""Offline candidate preview only: no database access or provider requests."""
import argparse
import csv
import json
from collections import Counter
from decimal import Decimal
from pathlib import Path


def preview(export_path, diff_path):
    identities = json.loads(Path(diff_path).read_text())
    allowed = {"included", "absent_by_both_numbers", "nonterminal", "invoice_number_only_match"}
    if len(identities) > 1000 or any(
        r["classification"] not in allowed or not r["wo"].isdigit() or not r["invoice"].isdigit()
        for r in identities
    ):
        raise ValueError("Invalid identity comparison")
    candidates = {}
    for r in identities:
        if r["classification"] == "included":
            continue
        key = (r["wo"], r["invoice"], r["date"])
        if key in candidates:
            raise ValueError("Duplicate native identity")
        candidates[key] = {
            "location": "701", "native_work_order": r["wo"], "native_invoice": r["invoice"],
            "native_date": r["date"], "classification": r["classification"],
            "package_rows": 0, "native_billed_hours": Decimal(0),
            "native_labor_total": Decimal(0),
            "next_action": "Resolve identity; no automatic repair" if r["classification"] == "invoice_number_only_match"
                else "Read final invoice through approved adapter; validate before proposing writes",
            "provider_verified": "NO", "writes_authorized": "NO",
        }
    with open(export_path, encoding="utf-8-sig", newline="") as source:
        for r in csv.DictReader(source):
            if not r["Location"].startswith("701-") or r["Type"] != "Invoice":
                continue
            if not r["Invoiced"].startswith("09/") or not r["Invoiced"].endswith("/2026"):
                continue
            candidate = candidates.get((r["Work Order #"], r["Invoice #"], r["Invoiced"]))
            if candidate is None:
                continue
            hours, labor = Decimal(r["Labor Hours Billed"]), Decimal(r["Labor Total"])
            if not hours.is_finite() or not labor.is_finite():
                raise ValueError("Missing or invalid financial evidence")
            candidate["package_rows"] += 1
            candidate["native_billed_hours"] += hours
            candidate["native_labor_total"] += labor
    if any(c["package_rows"] == 0 for c in candidates.values()):
        raise ValueError("An identity is absent from the supplied native export")
    return sorted(candidates.values(), key=lambda r: (r["native_date"], r["native_work_order"]))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("export")
    parser.add_argument("identities")
    parser.add_argument("output")
    args = parser.parse_args()
    rows = preview(args.export, args.identities)
    if not rows:
        raise ValueError("No recovery candidates")
    with open(args.output, "w", newline="") as out:
        writer = csv.DictWriter(out, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(json.dumps({
        "candidates": len(rows),
        "classifications": dict(Counter(r["classification"] for r in rows)),
        "native_candidate_hours": str(sum(r["native_billed_hours"] for r in rows)),
        "native_candidate_labor_total": str(sum(r["native_labor_total"] for r in rows)),
        "provider_verified": False, "writes_authorized": False,
    }, indent=2))
