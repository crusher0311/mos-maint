import { IppClient, supportedModel } from "./client";
import { IppDiagnosticError, printerUrl } from "./transport";
import { selectMedia, validateStock, type Stock } from "./media";

// Only Get-Printer-Attributes through inspect: no credential lookup, enrollment,
// configuration writes, print operations, retries or certificate bypass.
export async function diagnosePrinter(uri: string, stock: Stock, client = new IppClient()) {
  try { printerUrl(uri); validateStock(stock); }
  catch { return { diagnostic: "invalid_input", message: "Check the IPP address and individual label dimensions." }; }
  let attrs;
  try { attrs = await client.inspect(uri); }
  catch (error) {
    const messages: Record<string, string> = {
      name_resolution_failed: "Printer name could not be resolved. Check the selected printer and local network.",
      certificate_rejected: "The secure printer certificate was rejected. Certificate checks were not bypassed.",
      connection_failed: "Could not establish the printer connection. Check network reachability and the advertised service.",
    };
    const code = error instanceof IppDiagnosticError && messages[error.code] ? error.code : "attributes_failed";
    return { diagnostic: code, message: messages[code] ?? "Printer attributes could not be read as a valid IPP response." };
  }
  const model = attrs["printer-make-and-model"]?.[0];
  if (typeof model !== "string" || model.length > 128 || !supportedModel(model, "sticker"))
    return { diagnostic: "unsupported_model", message: "The printer did not identify itself as a supported ZINK Happy." };
  const uuid = attrs["printer-uuid"]?.[0];
  if (typeof uuid !== "string" || !/^urn:uuid:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uuid))
    return { diagnostic: "identity_missing", message: "The printer did not advertise a stable printer UUID." };
  if (!attrs["document-format-supported"]?.includes("image/png"))
    return { diagnostic: "png_missing", message: "The printer does not advertise PNG support." };
  if (!attrs["print-scaling-supported"]?.includes("none"))
    return { diagnostic: "no_scaling_missing", message: "The printer does not advertise exact-size printing without scaling." };
  if (!attrs["operations-supported"]?.includes(2))
    return { diagnostic: "print_job_missing", message: "The printer does not advertise the required Print-Job operation." };
  try { selectMedia(attrs, stock, stock); }
  catch { return { diagnostic: "media_mismatch", message: "The printer does not advertise exact borderless media matching these label dimensions." }; }
  return { diagnostic: "ready", message: "Printer capability checks passed. Nothing was enrolled or printed; physical output remains unverified." };
}
