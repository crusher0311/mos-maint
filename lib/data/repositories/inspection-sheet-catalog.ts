import type {Db} from "mongodb";
import {getDb} from "@/lib/data/db";
import {configurationSchema, type StaffConfiguration} from "@/lib/auto-dvi/staff/configuration";
import type {CatalogStore} from "@/lib/auto-dvi/staff/sheet-catalog";
import {canonical} from "@/lib/auto-dvi/durable/model";

/** Full-document CAS protects unrelated rollout/pilot flags from concurrent edits.
 * Catalog requests never supply this key or any admission/permission settings. */
export class MongoSheetCatalog implements CatalogStore {
  constructor(private database: () => Promise<Db> = getDb) {}
  async read(key: string) {
    const raw = await (await this.database()).collection("workflow_staff_inspection_config")
      .findOne({_id: key as any}, {maxTimeMS: 5000});
    if (!raw) return null;
    const {_id, ...config} = raw;
    return configurationSchema.parse(config);
  }
  async cas(key: string, before: StaffConfiguration | null, after: StaffConfiguration) {
    const col = (await this.database()).collection("workflow_staff_inspection_config");
    const value = JSON.parse(JSON.stringify(configurationSchema.parse(after)));
    const options = {writeConcern: {w: "majority" as const, wtimeoutMS: 5000}, ignoreUndefined: true};
    if (!before) {
      try {await col.insertOne({_id: key as any, ...value}, options); return true;}
      catch (error) {if ((error as {code?: number}).code === 11000) return false; throw error;}
    }
    // Match absent optional fields as absent, not as an incomplete subset.
    const raw = await col.findOne({_id: key as any}, {maxTimeMS: 5000});
    if (!raw) return false;
    const {_id, ...stored} = raw;
    if (canonical(configurationSchema.parse(stored)) !== canonical(before)) return false;
    const filter: Record<string, unknown> = {...raw};
    for (const optional of ["catalogRevision", "archivedSheetIds", "catalogReceipts", "pilot", "release", "individual"])
      if (!(optional in stored)) filter[optional] = {$exists: false};
    return (await col.replaceOne(filter as any, {_id: key, ...value}, options)).matchedCount === 1;
  }
}
