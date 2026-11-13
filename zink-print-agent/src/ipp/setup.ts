import path from "node:path";
import { discoverPrinters } from "./discovery";
import { EnrollmentStore } from "./enrollment";

export const IPP_SETUP_HELP = [
  "Local IPP pilot setup (cloud printing requires explicit ipp configuration):",
  "  --ipp-discover",
  "  --ipp-list [--ipp-file <printers.json>]",
  "  --ipp-enroll --uri <ipp://host/path> --name <name> --kind sticker",
  "               --width-mm <mm> --height-mm <mm> [--ipp-file <printers.json>]",
  "  --ipp-remove <printer-id> [--ipp-file <printers.json>]",
  "Enrollment probes capabilities only; it never prints a test label.",
  "Stop the scheduled agent before changing enrollments. No keytag model is supported yet.",
].join("\n");

export async function runIppSetup(argv: string[], write = (text: string) => process.stdout.write(text)): Promise<boolean> {
  const commands = argv.filter(arg => ["--ipp-discover", "--ipp-list", "--ipp-enroll", "--ipp-remove"].includes(arg));
  if (!commands.length) return false;
  if (commands.length !== 1) throw new Error("Choose exactly one IPP setup command");
  const option = (key: string, required = true) => {
    const indexes = argv.map((v, i) => v === key ? i : -1).filter(i => i >= 0);
    if (indexes.length > 1) throw new Error(`Duplicate option ${key}`);
    const value = indexes.length ? argv[indexes[0] + 1] : undefined;
    if ((!value || value.startsWith("--")) && required) throw new Error(`Missing ${key}`);
    return value && !value.startsWith("--") ? value : undefined;
  };
  if (commands[0] === "--ipp-discover") {
    write(JSON.stringify({ candidates: await discoverPrinters(), enrolled: false }, null, 2) + "\n");
    return true;
  }
  const store = new EnrollmentStore(path.resolve(option("--ipp-file", false) ?? "printers.json"));
  if (commands[0] === "--ipp-list") {
    write(JSON.stringify({ printers: store.list() }, null, 2) + "\n");
  } else if (commands[0] === "--ipp-remove") {
    store.remove(option("--ipp-remove")!); write("Removed local enrollment. Cloud defaults have not been changed.\n");
  } else {
    const kind = option("--kind");
    if (kind !== "sticker" && kind !== "keytag") throw new Error("Kind must be sticker or keytag");
    const dimension = (key: string) => {
      const raw = option(key)!;
      if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw new Error("Dimensions must be millimetres with at most two decimals");
      return Math.round(Number(raw) * 100);
    };
    const printer = await store.enroll({
      uri: option("--uri")!, name: option("--name")!, kind,
      stock: { width: dimension("--width-mm"), height: dimension("--height-mm") },
    });
    write(JSON.stringify({ enrolled: printer.id, name: printer.name, activation: "Requires explicit ipp configuration and agent restart" }) + "\n");
  }
  return true;
}
