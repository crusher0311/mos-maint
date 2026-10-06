import csv
import importlib.util
import json
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "preview", Path(__file__).resolve().parents[1] / "scripts/preview-jwt-labor-recovery.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PreviewTest(unittest.TestCase):
    def test_signed_packages_exact_scope_no_automatic_repair(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            identities = root / "ids.json"
            identities.write_text(json.dumps([{
                "wo": "701000001", "invoice": "701000002", "date": "09/01/2026",
                "classification": "invoice_number_only_match",
            }]))
            export = root / "export.csv"
            with export.open("w", newline="") as out:
                writer = csv.writer(out)
                writer.writerow(["Location", "Type", "Invoiced", "Work Order #", "Invoice #",
                                 "Labor Hours Billed", "Labor Total", "Email"])
                for location, kind, hours, labor in [
                    ("701-Test", "Invoice", "1", "100"),
                    ("701-Test", "Invoice", "0", "-10"),
                    ("702-Other", "Invoice", "99", "999"),
                    ("701-Test", "Credit Invoice", "-1", "-90"),
                ]:
                    writer.writerow([location, kind, "09/01/2026", "701000001", "701000002",
                                     hours, labor, "private@example.test"])
            rows = module.preview(export, identities)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["native_labor_total"], Decimal("90"))
            self.assertEqual(rows[0]["native_billed_hours"], Decimal("1"))
            self.assertEqual(rows[0]["writes_authorized"], "NO")
            self.assertEqual(rows[0]["provider_verified"], "NO")
            self.assertIn("no automatic repair", rows[0]["next_action"])
            self.assertNotIn("private@example.test", str(rows))
            identities.write_text(json.dumps([{
                "wo": "999", "invoice": "888", "date": "09/01/2026",
                "classification": "nonterminal",
            }]))
            with self.assertRaises(ValueError):
                module.preview(export, identities)


if __name__ == "__main__":
    unittest.main()
