import csv
import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "native", Path(__file__).resolve().parents[1] / "scripts/assess-native-labor-export.py")
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeExportTest(unittest.TestCase):
    def test_scope_signed_values_and_package_population(self):
        columns = ["Location", "Invoiced", "Type", "Invoice #", "Work Order #",
                   *native.FIELDS, "Invoice Total", "Email"]
        rows = [
            ["701-Test", "08/01/2026", "Invoice", "i1", "w1", "1.5", "100", "0", "150", "private@example.test"],
            ["701-Test", "08/01/2026", "Invoice", "i1", "w1", "0", "-10", "-1", "150", ""],
            ["701-Test", "08/02/2026", "Credit Invoice", "c1", "w2", "-1.5", "-90", "0", "-90", ""],
            ["601-Outside", "08/01/2026", "Invoice", "i2", "w3", "900", "900", "900", "900", ""],
            ["702-Test", "09/01/2026", "Invoice", "i3", "w4", "", "NaN", "0", "0", ""],
        ]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "export.csv"
            with path.open("w", newline="") as out:
                writer = csv.writer(out)
                writer.writerow(columns)
                writer.writerows(rows)
            result = native.assess(path)
        self.assertEqual(result["total_export_rows"], 5)
        self.assertEqual(len(result["cells"]), 3)
        invoice = next(c for c in result["cells"] if c["location"] == "701" and c["type"] == "Invoice")
        self.assertEqual(invoice["distinct_invoice_numbers"], 1)
        self.assertEqual(invoice["package_rows"], 2)
        self.assertEqual(invoice["raw_package_sums"]["Labor Total"], "90")
        missing = next(c for c in result["cells"] if c["location"] == "702")
        self.assertEqual(missing["missing_fields"]["Labor Hours Billed"], 1)
        self.assertEqual(missing["missing_fields"]["Labor Total"], 1)
        self.assertNotIn("private@example.test", str(result))
        self.assertNotIn("Invoice Total", str(invoice))


if __name__ == "__main__":
    unittest.main()
