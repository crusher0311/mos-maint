/** Bounded IPP/2.0 codec. Printer replies are untrusted input. */
export const Tag = {
  integer: 0x21, boolean: 0x22, enum: 0x23, range: 0x33,
  collection: 0x34, endCollection: 0x37, text: 0x41, name: 0x42,
  keyword: 0x44, uri: 0x45, charset: 0x47, language: 0x48,
  mime: 0x49, member: 0x4a,
} as const;

export interface Attribute { tag: number; value: string | number | boolean | Attributes }
export type Attributes = Record<string, Attribute | Attribute[]>;
export type Value = string | number | boolean | { range: [number, number] } | Values | null;
export interface Values { [name: string]: Value[] }
export interface Reply { status: number; requestId: number; groups: { tag: number; values: Values }[] }
export const MAX_REPLY_BYTES = 256 * 1024;
const MAX_ATTRIBUTES = 4096;
const MAX_DEPTH = 8;

function short(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error("Invalid IPP field size");
  const b = Buffer.alloc(2); b.writeUInt16BE(n); return b;
}
function field(tag: number, name: string, value: Buffer): Buffer {
  const n = Buffer.from(name);
  return Buffer.concat([Buffer.from([tag]), short(n.length), n, short(value.length), value]);
}
function encodeAttributes(attrs: Attributes, depth = 0): Buffer {
  if (depth > MAX_DEPTH) throw new Error("IPP collection too deep");
  const chunks: Buffer[] = [];
  for (const [name, entry] of Object.entries(attrs)) {
    const items = Array.isArray(entry) ? entry : [entry];
    for (let i = 0; i < items.length; i++) {
      const { tag, value } = items[i];
      if (tag === Tag.collection) {
        if (!value || typeof value !== "object") throw new Error("Invalid IPP collection");
        chunks.push(field(tag, i ? "" : name, Buffer.alloc(0)));
        for (const [member, memberValue] of Object.entries(value)) {
          chunks.push(field(Tag.member, "", Buffer.from(member)));
          chunks.push(encodeAttributes({ "": memberValue }, depth + 1));
        }
        chunks.push(field(Tag.endCollection, "", Buffer.alloc(0)));
      } else {
        let raw: Buffer;
        if (tag === Tag.integer || tag === Tag.enum) {
          if (!Number.isInteger(value)) throw new Error("Invalid IPP integer");
          raw = Buffer.alloc(4); raw.writeInt32BE(value as number);
        } else if (tag === Tag.boolean) {
          if (typeof value !== "boolean") throw new Error("Invalid IPP boolean");
          raw = Buffer.from([value ? 1 : 0]);
        } else {
          if (typeof value !== "string") throw new Error("Invalid IPP string");
          raw = Buffer.from(value);
        }
        chunks.push(field(tag, i ? "" : name, raw));
      }
    }
  }
  return Buffer.concat(chunks);
}

export function encodeRequest(operation: number, requestId: number,
  groups: { tag: number; values: Attributes }[], document: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8);
  header[0] = 2; header.writeUInt16BE(operation, 2); header.writeInt32BE(requestId, 4);
  return Buffer.concat([header, ...groups.flatMap(g =>
    [Buffer.from([g.tag]), encodeAttributes(g.values)]), Buffer.from([3]), document]);
}

export function decodeReply(data: Buffer, expectedRequestId?: number): Reply {
  if (data.length < 9 || data.length > MAX_REPLY_BYTES) throw new Error("Invalid IPP reply length");
  if (![1, 2].includes(data[0])) throw new Error("Unsupported IPP version");
  const reply: Reply = { status: data.readUInt16BE(2), requestId: data.readInt32BE(4), groups: [] };
  if (expectedRequestId !== undefined && reply.requestId !== expectedRequestId)
    throw new Error("IPP request ID mismatch");
  let pos = 8, count = 0;
  function take(n: number): Buffer {
    if (pos + n > data.length) throw new Error("Truncated IPP reply");
    const b = data.subarray(pos, pos + n); pos += n; return b;
  }
  function readField(): { tag: number; name: string; raw: Buffer } {
    if (++count > MAX_ATTRIBUTES) throw new Error("Too many IPP attributes");
    const tag = take(1)[0];
    const name = take(take(2).readUInt16BE()).toString("utf8");
    const raw = take(take(2).readUInt16BE());
    return { tag, name, raw };
  }
  function value(tag: number, raw: Buffer, depth: number): Value {
    if (depth > MAX_DEPTH) throw new Error("IPP collection too deep");
    if (tag === Tag.collection) {
      if (raw.length) throw new Error("Invalid IPP collection");
      const result: Values = Object.create(null);
      let member = "";
      while (true) {
        const f = readField();
        if (f.name) throw new Error("Named IPP collection member value");
        if (f.tag === Tag.endCollection) {
          if (f.raw.length) throw new Error("Invalid collection end");
          return result;
        }
        if (f.tag === Tag.member) {
          member = f.raw.toString("utf8");
          if (!member) throw new Error("Empty IPP member name");
        } else {
          if (!member) throw new Error("IPP member without name");
          (result[member] ??= []).push(value(f.tag, f.raw, depth + 1));
        }
      }
    }
    if (tag === Tag.integer || tag === Tag.enum) {
      if (raw.length !== 4) throw new Error("Invalid IPP integer");
      return raw.readInt32BE();
    }
    if (tag === Tag.boolean) {
      if (raw.length !== 1 || raw[0] > 1) throw new Error("Invalid IPP boolean");
      return raw[0] === 1;
    }
    if (tag === Tag.range) {
      if (raw.length !== 8) throw new Error("Invalid IPP range");
      return { range: [raw.readInt32BE(), raw.readInt32BE(4)] };
    }
    if ([0x10, 0x12, 0x13].includes(tag)) return null;
    if (tag < 0x10 || tag === Tag.member || tag === Tag.endCollection)
      throw new Error("Unexpected IPP tag");
    return raw.toString("utf8");
  }
  let current: Values | undefined, lastName = "";
  while (pos < data.length) {
    const tag = data[pos];
    if (tag === 3) {
      if (pos !== data.length - 1) throw new Error("Unexpected IPP response document");
      return reply;
    }
    if (tag < 0x10) {
      if (![1, 2, 4, 5].includes(tag)) throw new Error("Unsupported IPP group");
      pos++;
      current = Object.create(null) as Values;
      reply.groups.push({ tag, values: current }); lastName = "";
    } else {
      const f = readField();
      if (!current) throw new Error("IPP attribute without group");
      const name = f.name || lastName;
      if (!name) throw new Error("IPP attribute without name");
      (current[name] ??= []).push(value(f.tag, f.raw, 0)); lastName = name;
    }
  }
  throw new Error("Missing IPP end delimiter");
}

export function groupValues(reply: Reply, tag: number): Values {
  const groups = reply.groups.filter(g => g.tag === tag);
  if (groups.length !== 1) throw new Error("Missing or ambiguous IPP group");
  return groups[0].values;
}
