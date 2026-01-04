import { NextResponse } from "next/server";

const CURRENT_EXTENSION_VERSION = "1.3.1";
const MIN_SUPPORTED_VERSION = "1.3.0";

function parseVersion(version: string): number[] {
  return version.split('.').map(n => parseInt(n, 10) || 0);
}

function compareVersions(v1: string, v2: string): number {
  const parts1 = parseVersion(v1);
  const parts2 = parseVersion(v2);
  
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const clientVersion = searchParams.get('v') || '0.0.0';
  
  const isOutdated = compareVersions(clientVersion, MIN_SUPPORTED_VERSION) < 0;
  const isLatest = compareVersions(clientVersion, CURRENT_EXTENSION_VERSION) >= 0;
  
  return NextResponse.json({
    currentVersion: CURRENT_EXTENSION_VERSION,
    minSupportedVersion: MIN_SUPPORTED_VERSION,
    clientVersion,
    isOutdated,
    isLatest,
    updateRequired: isOutdated,
    message: isOutdated 
      ? `Please update MOS Tools to version ${CURRENT_EXTENSION_VERSION}. Your version (${clientVersion}) is no longer supported.`
      : isLatest 
        ? "You're running the latest version!"
        : `A new version (${CURRENT_EXTENSION_VERSION}) is available.`
  });
}
