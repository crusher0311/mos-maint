"""Stream a Protractor package export; emit only non-personal monthly summaries.

This does not ingest production data, allocate discounts, or establish native
report deduplication semantics. Invoice Total is repeated per package and is
deliberately never summed.
"""
import argparse
import csv
import hashlib
import json
from collections import Counter
from datetime import datetime
from decimal import Decimal, InvalidOperation

FIELDS = ("Labor Hours Billed", "Labor Total", "Labor Cost")


def number(value):
    try:
        result = Decimal(value.strip())
        return result if result.is_finite() else None
    except (InvalidOperation, AttributeError):
        return None


def assess(path):
    months, types, locations = {}, Counter(), Counter()
    rows = bad_dates = 0
    with open(path, encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        required = {"Location", "Invoiced", "Type", "Invoice #", "Work Order #", *FIELDS}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError("Missing required native export columns")
        for row in reader:
            rows += 1
            location = row["Location"].split("-", 1)[0].strip()
            locations[location] += 1
            if location not in {str(n) for n in range(701, 711)}:
                continue
            types[row["Type"]] += 1
            try:
                date = datetime.strptime(row["Invoiced"], "%m/%d/%Y")
            except ValueError:
                bad_dates += 1
                continue
            key = (location, date.strftime("%Y-%m"), row["Type"])
            cell = months.setdefault(key, {
                "rows": 0, "invoices": set(), "work_orders": set(),
                "missing_invoice_ids": 0,
                "sums": {f: Decimal(0) for f in FIELDS},
                "missing": Counter(), "negative": Counter(), "zero": Counter(),
            })
            cell["rows"] += 1
            if row["Invoice #"]:
                cell["invoices"].add(row["Invoice #"])
            else:
                cell["missing_invoice_ids"] += 1
            if row["Work Order #"]:
                cell["work_orders"].add(row["Work Order #"])
            for field in FIELDS:
                value = number(row[field])
                if value is None:
                    cell["missing"][field] += 1
                else:
                    cell["sums"][field] += value
                    cell["negative"][field] += int(value < 0)
                    cell["zero"][field] += int(value == 0)
    output = []
    for (location, month, kind), cell in sorted(months.items()):
        output.append({
            "location": location, "month": month, "type": kind,
            "package_rows": cell["rows"],
            "distinct_invoice_numbers": len(cell["invoices"]),
            "distinct_work_order_numbers": len(cell["work_orders"]),
            "missing_invoice_id_rows": cell["missing_invoice_ids"],
            "raw_package_sums": {k: str(v) for k, v in cell["sums"].items()},
            "missing_fields": dict(cell["missing"]),
            "negative_fields": dict(cell["negative"]),
            "zero_fields": dict(cell["zero"]),
        })
    with open(path, "rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    return {
        "sha256": digest, "total_export_rows": rows,
        "location_row_counts": dict(sorted(locations.items())),
        "jwt_type_counts": dict(types), "jwt_invalid_dates": bad_dates,
        "cells": output,
        "limitations": [
            "Raw package sums, not certified net sales or deduplicated technician allocations.",
            "Invoice Total is repeated per package and was not summed.",
            "No explicit discount allocation, refund allocation or declined disposition columns.",
            "Scope restricted to canonical JWT locations 701-710; other locations excluded.",
            "Native invoice dates have no timezone; UTC-close-date parity remains unverified.",
        ],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    args = parser.parse_args()
    print(json.dumps(assess(args.path), indent=2))
