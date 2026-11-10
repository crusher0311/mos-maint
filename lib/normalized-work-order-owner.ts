/**
 * A work-order number is not provider identity. Only reuse a collision winner
 * when both records unambiguously identify the same provider record.
 */
export function assertSameWorkOrderOwner(existing: any, incoming: any): void {
  const identity = (provenance: any) => {
    const ids = provenance?.sourceIds;
    if (!Array.isArray(ids)) throw new Error("Work order ownership conflict");
    const primary = ids.filter((id: any) => id?.isPrimary === true);
    if (primary.length !== 1) throw new Error("Work order ownership conflict");
    const id = primary[0];
    if (typeof id.system !== "string" || !id.system || id.system === "unknown" ||
        typeof id.idType !== "string" || !id.idType.endsWith("_id") ||
        typeof id.idValue !== "string" || !id.idValue.trim() ||
        (provenance.sourceSystem && provenance.sourceSystem !== "unknown" &&
          provenance.sourceSystem !== id.system) ||
        ids.some((other: any) => other?.system !== id.system ||
          (other.idType === id.idType && other.idValue !== id.idValue))) {
      throw new Error("Work order ownership conflict");
    }
    return [id.system, id.idType, id.idValue];
  };
  if (JSON.stringify(identity(existing)) !== JSON.stringify(identity(incoming))) {
    throw new Error("Work order ownership conflict");
  }
}
