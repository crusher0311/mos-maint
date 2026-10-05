/**
 * Install an intentionally permanent network-egress deny for an offline test
 * process.  This is independent of provider-client mocks: a detached request,
 * an accidentally restored hook, or a newly imported HTTP client must still
 * fail before opening a socket.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

export type DeniedNetworkAttempt = {
  transport: string;
  target: unknown;
};

const attempts: DeniedNetworkAttempt[] = [];
let installed = false;

function deny(transport: string, target: unknown): never {
  attempts.push({ transport, target });
  throw new Error("Network egress denied by offline Protractor regression");
}

export function installPermanentNetworkEgressDeny(): void {
  if (installed) return;
  installed = true;

  https.request = ((options: any) => deny("https.request", options)) as typeof https.request;
  https.get = ((options: any) => deny("https.get", options)) as typeof https.get;
  http.request = ((options: any) => deny("http.request", options)) as typeof http.request;
  http.get = ((options: any) => deny("http.get", options)) as typeof http.get;
  net.connect = ((...args: any[]) => deny("net.connect", args)) as typeof net.connect;
  net.createConnection = ((...args: any[]) =>
    deny("net.createConnection", args)) as typeof net.createConnection;
  tls.connect = ((...args: any[]) => deny("tls.connect", args)) as typeof tls.connect;

  const fetchDeny = async (...args: any[]): Promise<never> =>
    deny("fetch", args[0]);
  globalThis.fetch = fetchDeny as typeof globalThis.fetch;
}

export function deniedNetworkAttempts(): readonly DeniedNetworkAttempt[] {
  return attempts;
}

export function clearDeniedNetworkAttempts(): void {
  attempts.length = 0;
}

// This helper is intentionally a preload-style module: importing it installs
// the deny before the test imports any provider client or transport module.
installPermanentNetworkEgressDeny();