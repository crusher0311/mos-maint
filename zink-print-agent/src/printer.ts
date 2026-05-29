/**
 * Printer transport: address resolution + port-9100 sender.
 *
 * ZINK printers accept jobs over raw TCP on port 9100. They're typically
 * addressed by a static IP or an mDNS name like "zink.local". This module:
 *   - resolves an address to a connectable host (IP passthrough, mDNS lookup
 *     for *.local, hostname passthrough otherwise), and
 *   - opens a socket, writes the XML header then the JPEG bytes, and reports
 *     a structured result.
 */

import net from "node:net";
import mdns from "multicast-dns";

export const DEFAULT_PRINTER_PORT = 9100;
export const DEFAULT_MDNS_TIMEOUT_MS = 5000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 8000;

/** Strict-ish IPv4 detector. IPv6 literals are also treated as IPs. */
export function isIpAddress(address: string): boolean {
  const ipv4 =
    /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
  if (ipv4.test(address)) return true;
  // Minimal IPv6 check: contains a colon and only hex/colon chars.
  if (address.includes(":") && /^[0-9a-fA-F:]+$/.test(address)) return true;
  return false;
}

/** True for mDNS ".local" / ".local." single-label hostnames. */
export function isMdnsName(address: string): boolean {
  return /\.local\.?$/i.test(address);
}

/** Function shape used to resolve an mDNS name to an IP (injectable for tests). */
export type MdnsResolver = (hostname: string, timeoutMs: number) => Promise<string>;

/**
 * Resolve a "*.local" mDNS name to an A-record IP using multicast-dns.
 * Rejects if no answer arrives before the timeout.
 */
export const resolveMdns: MdnsResolver = (hostname, timeoutMs) => {
  return new Promise<string>((resolve, reject) => {
    const query = hostname.replace(/\.$/, "");
    const socket = mdns();
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      try {
        socket.removeListener("response", onResponse);
        socket.destroy();
      } catch {
        // ignore teardown errors
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`mDNS resolution for "${query}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onResponse = (response: { answers?: Array<{ name: string; type: string; data: unknown }> }) => {
      if (settled) return;
      const answers = response.answers || [];
      const a = answers.find(
        (ans) => ans.type === "A" && ans.name.toLowerCase() === query.toLowerCase(),
      );
      if (a && typeof a.data === "string") {
        settled = true;
        cleanup();
        resolve(a.data);
      }
    };

    socket.on("response", onResponse);
    socket.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    socket.query({ questions: [{ name: query, type: "A" }] });
  });
};

export interface ResolveOptions {
  timeoutMs?: number;
  /** Override the mDNS resolver (used in tests). */
  mdnsResolver?: MdnsResolver;
}

/**
 * Resolve a configured printer address to a connectable host.
 *   - IP literal       -> returned as-is.
 *   - "*.local" name   -> resolved via mDNS.
 *   - anything else    -> returned as-is (let the OS resolver handle DNS).
 */
export async function resolveAddress(
  address: string,
  opts: ResolveOptions = {},
): Promise<string> {
  const trimmed = (address || "").trim();
  if (trimmed === "") {
    throw new Error("printer address is empty");
  }
  if (isIpAddress(trimmed)) {
    return trimmed;
  }
  if (isMdnsName(trimmed)) {
    const resolver = opts.mdnsResolver || resolveMdns;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_MDNS_TIMEOUT_MS;
    return resolver(trimmed.replace(/\.$/, ""), timeoutMs);
  }
  return trimmed;
}

export interface SendOptions {
  port?: number;
  connectTimeoutMs?: number;
}

/**
 * Open a TCP socket to the printer and write the XML header followed by the
 * JPEG buffer, then half-close so the printer sees EOF. Resolves once the
 * bytes are flushed and the connection closes; rejects on connect/socket
 * timeout or any socket error.
 */
export function sendToPrinter(
  host: string,
  header: string,
  jpeg: Buffer,
  opts: SendOptions = {},
): Promise<void> {
  const port = opts.port ?? DEFAULT_PRINTER_PORT;
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  return new Promise<void>((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      reject(err);
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    socket.setTimeout(connectTimeoutMs);

    socket.on("timeout", () => {
      fail(new Error(`printer socket to ${host}:${port} timed out after ${connectTimeoutMs}ms`));
    });
    socket.on("error", (err: Error) => {
      fail(err);
    });
    socket.on("close", () => {
      // If we already errored/timed out this is a no-op; otherwise the
      // printer closed cleanly after consuming the job.
      succeed();
    });

    socket.connect(port, host, () => {
      socket.write(header, "utf8");
      socket.write(jpeg, (err) => {
        if (err) {
          fail(err);
          return;
        }
        // Half-close: flush our bytes and signal EOF to the printer.
        socket.end();
      });
    });
  });
}
