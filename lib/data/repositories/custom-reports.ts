import { ObjectId, type Filter } from "mongodb";
import { getDb } from "@/lib/data/db";
import {
  canReadCustomReport,
  canWriteCustomReport,
  normalizeActorEmail,
  type CustomReportAccessActor,
  type CustomReportAccessScope,
  type CustomReportVisibility,
} from "@/lib/custom-report-access";

const COLLECTION = "custom_reports";
const LIST_LIMIT = 200;

export interface CustomReportScopeRequest {
  kind: "shop" | "enterprise" | "platform";
  shopId?: number;
  enterpriseId?: string;
}

export interface CustomReportDefinitionVersion {
  version: number;
  definition: Record<string, unknown>;
  createdAt: Date;
  createdBy: string;
}

export interface CustomReportDocument {
  _id: ObjectId;
  name: string;
  ownerEmail: string;
  scope: CustomReportScopeRequest;
  sharing: {
    visibility: CustomReportVisibility;
    shopIds?: number[];
    enterpriseId?: string;
  };
  currentVersion: number;
  versions: CustomReportDefinitionVersion[];
  createdAt: Date;
  updatedAt: Date;
}

export type NewCustomReport = Pick<CustomReportDocument, "name" | "scope" | "sharing"> & {
  definition: Record<string, unknown>;
};

async function collection() {
  return (await getDb()).collection<CustomReportDocument>(COLLECTION);
}

function idFilter(id: string): Filter<CustomReportDocument> | null {
  return ObjectId.isValid(id) ? { _id: new ObjectId(id) } : null;
}

export function currentCustomReportDefinition(
  report: Pick<CustomReportDocument, "currentVersion" | "versions">,
): CustomReportDefinitionVersion | null {
  return report.versions.find((version) => version.version === report.currentVersion) || null;
}

export async function createCustomReport(ownerEmail: string, input: NewCustomReport) {
  const now = new Date();
  const owner = normalizeActorEmail(ownerEmail);
  const doc: Omit<CustomReportDocument, "_id"> = {
    name: input.name,
    ownerEmail: owner,
    scope: input.scope,
    sharing: input.sharing,
    currentVersion: 1,
    versions: [{ version: 1, definition: input.definition, createdAt: now, createdBy: owner }],
    createdAt: now,
    updatedAt: now,
  };
  const result = await (await collection()).insertOne(doc as CustomReportDocument);
  return { ...doc, _id: result.insertedId };
}

export async function findCustomReport(id: string) {
  const filter = idFilter(id);
  return filter ? (await collection()).findOne(filter) : null;
}

export async function listCustomReports(
  actor: CustomReportAccessActor,
  scope: CustomReportAccessScope,
) {
  const email = normalizeActorEmail(actor.email);
  const visible: Filter<CustomReportDocument> = actor.isPlatformAdmin
    ? {}
    : {
        $or: [
          { ownerEmail: email },
          { "sharing.visibility": "shop", "sharing.shopIds": { $in: [...scope.shopIds] } },
          ...(scope.enterpriseId
            ? [{ "sharing.visibility": "enterprise", "sharing.enterpriseId": scope.enterpriseId }]
            : []),
        ],
      };
  const docs = await (await collection()).find(visible).sort({ updatedAt: -1 }).limit(LIST_LIMIT).toArray();
  return docs.filter((doc) => canReadCustomReport(actor, doc, scope));
}

export async function renameCustomReport(
  id: string,
  actor: CustomReportAccessActor,
  name: string,
) {
  const report = await findCustomReport(id);
  if (!report || !canWriteCustomReport(actor, report)) return null;
  return (await collection()).findOneAndUpdate(
    { _id: report._id, currentVersion: report.currentVersion },
    { $set: { name, updatedAt: new Date() } },
    { returnDocument: "after" },
  );
}

export async function updateCustomReportDefinition(
  id: string,
  actor: CustomReportAccessActor,
  update: {
    definition: Record<string, unknown>;
    scope: CustomReportScopeRequest;
    sharing?: CustomReportDocument["sharing"];
  },
) {
  const report = await findCustomReport(id);
  if (!report || !canWriteCustomReport(actor, report)) return null;
  const now = new Date();
  const nextVersion = report.currentVersion + 1;
  return (await collection()).findOneAndUpdate(
    { _id: report._id, currentVersion: report.currentVersion },
    {
      $set: {
        currentVersion: nextVersion,
        scope: update.scope,
        ...(update.sharing ? { sharing: update.sharing } : {}),
        updatedAt: now,
      },
      $push: {
        versions: {
          version: nextVersion,
          definition: update.definition,
          createdAt: now,
          createdBy: normalizeActorEmail(actor.email),
        },
      },
    },
    { returnDocument: "after" },
  );
}

export async function duplicateCustomReport(
  source: CustomReportDocument,
  ownerEmail: string,
  name: string,
) {
  const current = currentCustomReportDefinition(source);
  if (!current) throw new Error("Report definition is missing");
  return createCustomReport(ownerEmail, {
    name,
    scope: source.scope,
    sharing: { visibility: "private" },
    definition: current.definition,
  });
}

export async function deleteCustomReport(id: string, actor: CustomReportAccessActor) {
  const report = await findCustomReport(id);
  if (!report || !canWriteCustomReport(actor, report)) return false;
  return (await collection()).deleteOne({ _id: report._id }).then((result) => result.deletedCount === 1);
}