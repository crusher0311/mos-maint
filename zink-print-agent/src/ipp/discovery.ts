import mdns from "multicast-dns";
import { printerUrl } from "./transport";

export interface Candidate { service: string; uri: string }
interface RecordValue { name: string; type: string; data: unknown }
export interface DiscoverySocket {
  on(event: "response", callback: (packet: { answers?: RecordValue[]; additionals?: RecordValue[] }) => void): unknown;
  on(event: "error", callback: (error: Error) => void): unknown;
  query(packet: { questions: { name: string; type: "PTR" | "SRV" | "TXT" }[] }): unknown;
  destroy(): unknown;
}
const SERVICES = ["_ipp._tcp.local", "_ipps._tcp.local"];
const normalize = (name: string) => name.toLowerCase().replace(/\.$/, "");

/**
 * A bounded browse returns candidates, NOT enrolled printers. No subnet scan,
 * auto-pick, background discovery, or reuse of an offline printer's old route.
 */
export function discoverPrinters(timeoutMs = 3000,
  factory: () => DiscoverySocket = () => mdns() as unknown as DiscoverySocket): Promise<Candidate[]> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000)
    throw new Error("Discovery must run for 100–10000ms");
  return new Promise((resolve, reject) => {
    const socket = factory();
    const instances = new Set<string>(), queried = new Set<string>();
    const addresses = new Map<string, { host: string; port: number }>();
    const paths = new Map<string, string>();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) { reject(error); return; }
      const candidates: Candidate[] = [];
      for (const service of instances) {
        const address = addresses.get(service), resource = paths.get(service);
        if (!address || !resource) continue;
        const scheme = service.endsWith("._ipps._tcp.local") ? "ipps" : "ipp";
        const uri = `${scheme}://${address.host}:${address.port}/${resource.replace(/^\/+/, "")}`;
        try { printerUrl(uri); candidates.push({ service, uri }); }
        catch { /* Malformed advertisements are not candidates. */ }
      }
      resolve(candidates.sort((a, b) => a.service.localeCompare(b.service)));
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    socket.on("error", () => finish(new Error("Local printer discovery failed")));
    socket.on("response", packet => {
      if (settled) return;
      const records = [...(packet.answers ?? []), ...(packet.additionals ?? [])].slice(0, 128);
      for (const record of records) {
        if (typeof record.name !== "string" || record.name.length > 253) continue;
        const name = normalize(record.name);
        if (record.type === "PTR" && SERVICES.includes(name) && typeof record.data === "string") {
          const instance = normalize(record.data);
          if (instances.size >= 32 || instance.length > 253 || !instance.endsWith(`.${name}`)) continue;
          instances.add(instance);
          if (!queried.has(instance)) {
            queried.add(instance);
            socket.query({ questions: [{ name: instance, type: "SRV" }, { name: instance, type: "TXT" }] });
          }
        }
      }
      for (const record of records) {
        if (typeof record.name !== "string") continue;
        const name = normalize(record.name);
        if (!instances.has(name)) continue;
        if (record.type === "SRV" && record.data && typeof record.data === "object") {
          const data = record.data as { target?: unknown; port?: unknown };
          if (typeof data.target !== "string" || typeof data.port !== "number" ||
              !Number.isInteger(data.port) || data.port < 1 || data.port > 65535) continue;
          const host = normalize(data.target);
          if (!/^(?:[a-z0-9][a-z0-9-]{0,62}\.)+local$/.test(host) || host.length > 253) continue;
          addresses.set(name, { host, port: data.port });
        }
        if (record.type === "TXT" && Array.isArray(record.data)) {
          for (const entry of record.data.slice(0, 32)) {
            if (!Buffer.isBuffer(entry) || entry.length > 255) continue;
            const text = entry.toString("utf8");
            if (text.startsWith("rp=")) {
              const resource = text.slice(3);
              if (resource && !/[?#@\s\\]/.test(resource)) paths.set(name, resource);
            }
          }
        }
      }
    });
    socket.query({ questions: SERVICES.map(name => ({ name, type: "PTR" as const })) });
  });
}
