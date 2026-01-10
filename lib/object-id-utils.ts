import { ObjectId } from 'mongodb';

export function toObjectId(id: string | ObjectId | undefined | null): ObjectId | undefined {
  if (!id) return undefined;
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) {
    return new ObjectId(id);
  }
  return undefined;
}

export function toObjectIdOrThrow(id: string | ObjectId, fieldName = 'id'): ObjectId {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) {
    return new ObjectId(id);
  }
  throw new Error(`Invalid ObjectId for ${fieldName}: ${id}`);
}

export function objectIdToString(id: ObjectId | string | undefined | null): string | undefined {
  if (!id) return undefined;
  if (id instanceof ObjectId) return id.toHexString();
  return id;
}

export function isValidObjectId(id: any): boolean {
  if (!id) return false;
  if (id instanceof ObjectId) return true;
  if (typeof id === 'string') return ObjectId.isValid(id);
  return false;
}

export function objectIdsEqual(a: ObjectId | string | undefined, b: ObjectId | string | undefined): boolean {
  if (!a || !b) return false;
  const aStr = a instanceof ObjectId ? a.toHexString() : a;
  const bStr = b instanceof ObjectId ? b.toHexString() : b;
  return aStr === bStr;
}
