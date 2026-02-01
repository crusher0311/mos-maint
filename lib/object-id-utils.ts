import { randomUUID } from 'crypto';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECTID_REGEX = /^[0-9a-f]{24}$/i;

export function toUUID(id: string | undefined | null): string | undefined {
  if (!id) return undefined;
  if (UUID_REGEX.test(id)) return id;
  if (OBJECTID_REGEX.test(id)) return id;
  return undefined;
}

export function toUUIDOrThrow(id: string, fieldName = 'id'): string {
  if (UUID_REGEX.test(id)) return id;
  if (OBJECTID_REGEX.test(id)) return id;
  throw new Error(`Invalid UUID for ${fieldName}: ${id}`);
}

export function generateId(): string {
  return randomUUID();
}

export function isValidId(id: any): boolean {
  if (!id) return false;
  if (typeof id === 'string') {
    return UUID_REGEX.test(id) || OBJECTID_REGEX.test(id);
  }
  return false;
}

export function idsEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

export function toObjectId(id: string | undefined | null): string | undefined {
  return toUUID(id);
}

export function toObjectIdOrThrow(id: string, fieldName = 'id'): string {
  return toUUIDOrThrow(id, fieldName);
}

export function objectIdToString(id: string | undefined | null): string | undefined {
  return id || undefined;
}

export function isValidObjectId(id: any): boolean {
  return isValidId(id);
}

export function objectIdsEqual(a: string | undefined, b: string | undefined): boolean {
  return idsEqual(a, b);
}
