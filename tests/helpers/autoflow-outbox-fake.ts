type Row = Record<string, any>;

function getPath(row: Row, path: string): any {
  return path.split(".").reduce((value, part) => value?.[part], row);
}

function setPath(row: Row, path: string, value: any): void {
  const parts = path.split(".");
  const leaf = parts.pop()!;
  let target = row;
  for (const part of parts) target = target[part] ??= {};
  target[leaf] = value;
}

export function matchesAutoflowOutboxRow(row: Row, query: any): boolean {
  return Object.entries(query).every(([key, expected]: [string, any]) => {
    if (key === "$or") return expected.some((part: any) => matchesAutoflowOutboxRow(row, part));
    if (key === "$and") return expected.every((part: any) => matchesAutoflowOutboxRow(row, part));
    const actual = getPath(row, key);
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      return Object.entries(expected).every(([operator, value]: [string, any]) => {
        if (operator === "$in") return value.includes(actual);
        if (operator === "$lt") return actual < value;
        if (operator === "$lte") return actual <= value;
        if (operator === "$gt") return actual > value;
        if (operator === "$gte") return actual >= value;
        if (operator === "$exists") return (actual !== undefined) === value;
        return false;
      });
    }
    return actual === expected;
  });
}

function applyUpdate(row: Row, update: any): void {
  for (const [key, value] of Object.entries(update.$set ?? {})) setPath(row, key, value);
  for (const [key, value] of Object.entries(update.$inc ?? {}) as any) {
    setPath(row, key, (getPath(row, key) ?? 0) + value);
  }
  for (const [key, value] of Object.entries(update.$max ?? {}) as any) {
    if (getPath(row, key) == null || getPath(row, key) < value) setPath(row, key, value);
  }
  for (const key of Object.keys(update.$unset ?? {})) {
    const parts = key.split(".");
    const leaf = parts.pop()!;
    const parent = parts.reduce((value, part) => value?.[part], row);
    if (parent) delete parent[leaf];
  }
}

export function fakeMongo() {
  const rows: Row[] = [];
  const marker: Row = { _id: "lastUpdate" };
  const options: any[] = [];
  let failUpdate = false;
  let failDelete = false;
  let failIndex = false;
  let failMarker = false;
  let afterClaim: ((row: Row) => void | Promise<void>) | undefined;

  const outboxCollection = {
    createIndex: async (_keys: any, option: any) => {
      options.push(option);
      if (failIndex) {
        failIndex = false;
        throw new Error("temporary index failure");
      }
      return option.name;
    },
    insertOne: async (row: Row, option: any) => {
      options.push(option);
      rows.push(structuredClone(row));
      return { insertedId: row._id };
    },
    updateOne: async (query: any, update: any, option: any) => {
      options.push(option);
      if (failUpdate) {
        failUpdate = false;
        throw new Error("temporary outbox failure");
      }
      const row = rows.find((candidate) => matchesAutoflowOutboxRow(candidate, query));
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(row, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    deleteOne: async (query: any, option: any) => {
      options.push(option);
      if (failDelete) {
        failDelete = false;
        throw new Error("temporary ack failure");
      }
      const index = rows.findIndex((candidate) => matchesAutoflowOutboxRow(candidate, query));
      if (index < 0) return { deletedCount: 0 };
      rows.splice(index, 1);
      return { deletedCount: 1 };
    },
    findOneAndUpdate: async (query: any, update: any, option: any) => {
      options.push(option);
      const candidates = rows.filter((candidate) => matchesAutoflowOutboxRow(candidate, query));
      const sort = option.sort ?? {};
      candidates.sort((a, b) => {
        for (const [key, direction] of Object.entries(sort) as any) {
          const difference = Number(getPath(a, key)) - Number(getPath(b, key));
          if (difference) return difference * direction;
        }
        return 0;
      });
      const row = candidates[0];
      if (!row) return null;
      applyUpdate(row, update);
      const claimed = structuredClone(row);
      if (update.$set?.leaseToken && afterClaim) await afterClaim(row);
      return claimed;
    },
  };

  const markerCollection = {
    updateOne: async (_query: any, update: any, option: any) => {
      options.push(option);
      if (failMarker) {
        failMarker = false;
        throw new Error("temporary marker failure");
      }
      if (Array.isArray(update)) {
        // The outbox always performs a per-shop bump, but retain enough global
        // behavior for integration tests that inspect the shared fake.
        marker.timestamp = Math.max(Date.now(), Number(marker.timestamp ?? 0) + 1);
        marker.globalVersion = Number(marker.globalVersion ?? 0) + 1;
      } else {
        applyUpdate(marker, update);
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };

  return {
    db: {
      collection: (name: string) =>
        name === "dashboard_updates" ? markerCollection : outboxCollection,
    } as any,
    collection: outboxCollection,
    markerCollection,
    rows,
    marker,
    options,
    failNextUpdate: () => { failUpdate = true; },
    failNextDelete: () => { failDelete = true; },
    failNextIndex: () => { failIndex = true; },
    failNextMarkerWrite: () => { failMarker = true; },
    afterNextClaim: (callback: (row: Row) => void | Promise<void>) => {
      afterClaim = async (row) => {
        afterClaim = undefined;
        await callback(row);
      };
    },
  };
}