"""Offline, allowlisted aggregation. Never copy customer or vehicle identifiers.
Usage: python scripts/summarize-sales.py /path/to/sales.csv
Output contains employee names explicitly authorized for the presentation.
"""
import csv
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime
from decimal import Decimal
from pathlib import Path

excluded = {'Customer Concerns', 'Discounts, Promotions & Coupons',
            'Tire Protection Plan', 'Employee Purchase', 'Shop Supplies', 'Sublet & Towing'}
# Only reviewed generic package descriptions may enter the browser bundle;
# arbitrary free-text descriptions can contain private customer information.
approved_packages = {
    'All Wheel Alignment', 'Check Alignment - No Charge',
    'Full Service Oil Change', '•Oil Change - Full Synthetic',
    'Tire Rotation - No Charge', 'Tire Rotation - Full Service Oil Change',
    'Driveability Testing Labor (S700)', 'Concern Testing & Inspecting (S700B)',
    'Front Disc Brake Service', 'Rear Disc Brake Service', 'Brake Inspection',
    'Brake Inspection - No Charge', 'BG Brake Fluid Exchange',
    'BG Cooling System Fluid Exchange', 'BG Engine Performance Restoration EPR/ MOA Kit',
    'Suspension/Steering Testing and Replacement', 'Suspension Control Arm, Lower',
    'Strut Assembly, Front', 'Cooling System Performance Test', 'Water Pump',
    'Battery Installation with Purchase', 'Complete Electrical System Check',
    'Basic Electrical System Check', 'Starter Motor', 'Spark Plug(s)',
    'Engine Air Filter Service', 'Cabin Air Filter Service',
    'Mount, Install & Balance - 4 Tires', 'Tire Repair With Rebalance - Standard Tire/Wheel',
    'Basic Vehicle Inspection - No Fluid Service', 'Balance 4 Tires Warranty Wheel Balance',
}
seen = set()
raw_count = credit_count = duplicate_count = assigned_count = 0
invoices = set()
dates = []
positive_hours = equal_hours = 0
people = defaultdict(lambda: {'packages': Counter(), 'categories': Counter(), 'invoices': set(), 'dates': []})
catalog = Counter()
with open(sys.argv[1], encoding='utf-8-sig', newline='') as source:
    for row in csv.DictReader(source):
        raw_count += 1
        invoices.add(row['Invoice #'])
        dates.append(datetime.strptime(row['Invoiced'], '%m/%d/%Y').date().isoformat())
        assigned_count += bool(row['Technician'].strip())
        credit_count += row['Type'] == 'Credit Invoice'
        key = tuple(row.values())
        if key in seen:
            duplicate_count += 1
            continue
        seen.add(key)
        if row['Type'] != 'Invoice':
            continue
        billed, technician = Decimal(row['Labor Hours Billed']), Decimal(row['Technician Hours'])
        if billed > 0:
            positive_hours += 1
            equal_hours += abs(billed - technician) < Decimal('0.00001')
        name = row['Technician'].removeprefix('Employee - ').strip()
        if not name:
            continue
        person = people[name]
        person['dates'].append(datetime.strptime(row['Invoiced'], '%m/%d/%Y').date().isoformat())
        person['invoices'].add(row['Invoice #'])
        category, package = row['Service Category'], row['Service Package'].strip()
        # This is an evidence shortlist, not a claim that every entry is a repair.
        if category not in excluded and package not in {'DOT Numbers for Tires', 'Carry out tire', 'Carry Out Tires'}:
            person['categories'][category] += 1
            if package in approved_packages:
                person['packages'][package] += 1
                catalog[package] += 1

result = {
    'sourceLabel': 'Burnett location · YTD service-package sales',
    'from': min(dates), 'through': max(dates),
    'rawRows': raw_count, 'invoiceNumbers': len(invoices - {''}),
    'assignedRows': assigned_count, 'creditRows': credit_count,
    'duplicateRows': duplicate_count, 'positiveHoursRows': positive_hours,
    'matchingHoursRows': equal_hours,
    'hoursMatchPercent': round(equal_hours / positive_hours * 100, 2),
    'aliases': [
        ['Ethan Englehorn', 'Ethan Engelhorn'],
        ['Issac Bluemel', 'Isaac Bluemel'],
    ],
    'technicians': [{
        'name': name,
        'firstDate': min(p['dates']), 'lastDate': max(p['dates']),
        'invoiceCount': len(p['invoices']),
        'categories': [{'name': name, 'count': n} for name, n in p['categories'].most_common()],
        'packages': [{'name': name, 'count': n} for name, n in p['packages'].most_common()],
    } for name, p in sorted(people.items())],
    'catalog': [{'name': name, 'count': n} for name, n in catalog.most_common()],
}
target = Path(__file__).resolve().parents[1] / 'src/components/mockups/workflow/_shared/burnett-summary.json'
target.write_text(json.dumps(result, indent=2) + '\n')
print(f'Wrote allowlisted summary: {len(people)} employee labels, {raw_count} source rows. No customer fields.')
