/**
 * Regression coverage for the shared platform-admin notification inbox.
 *
 * Run: NODE_OPTIONS='--require ./scripts/_stubs/server-only-stub.cjs' \
 *   npx tsx tests/platform-admin-notifications.smoke.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ObjectId } from "mongodb";
import {
  __deps as repoDeps,
  countUnreadForAdmins,
  deleteOneAdminNotification,
  findForAdmins,
  markAllAdminNotificationsRead,
  markOneAdminNotificationRead,
  PLATFORM_ADMIN_INBOX_USER_ID,
  upsertPlatformAdminNotification,
} from "../lib/data/repositories/notifications";
import {
  GET as listNotifications,
  POST as mutateNotifications,
  __deps as listDeps,
} from "../app/api/platform-admin/notifications/route";
import {
  GET as countNotifications,
  __deps as countDeps,
} from "../app/api/platform-admin/notifications/count/route";
import {
  PATCH as patchNotification,
  DELETE as deleteNotification,
  __deps as itemDeps,
} from "../app/api/platform-admin/notifications/[id]/route";

type Doc = Record<string, any>;

function getPath(doc: Doc, path: string): any {
  return path.split(".").reduce((value, key) => value?.[key], doc);
}

function sameValue(left: any, right: any): boolean {
  if (left instanceof ObjectId || right instanceof ObjectId) return String(left) === String(right);
  return left === right;
}

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter || {}).every(([key, expected]) => {
    if (key === "$or") return (expected as Doc[]).some((part) => matches(doc, part));
    const actual = getPath(doc, key);
    if (expected instanceof RegExp) return expected.test(String(actual || ""));
    if (expected && typeof expected === "object" && "$regex" in expected) {
      return expected.$regex.test(String(actual || ""));
    }
    if (expected && typeof expected === "object" && "$in" in expected) {
      return expected.$in.some((candidate: any) => sameValue(actual, candidate));
    }
    return sameValue(actual, expected);
  });
}

function makeNotificationDb(seed: Doc[]) {
  const docs = seed;
  const collection = {
    find(filter: Doc = {}) {
      let found = docs.filter((doc) => matches(doc, filter));
      const cursor: any = {
        sort(spec: Doc) {
          const [[key, direction]] = Object.entries(spec);
          found = [...found].sort((a, b) =>
            (getPath(a, key) < getPath(b, key) ? -1 : 1) * Number(direction),
          );
          return cursor;
        },
        limit(limit: number) {
          found = found.slice(0, limit);
          return cursor;
        },
        toArray: async () => found.map((doc) => ({ ...doc })),
      };
      return cursor;
    },
    async findOne(filter: Doc) {
      return docs.find((doc) => matches(doc, filter)) || null;
    },
    async findOneAndUpdate(filter: Doc, update: Doc, opts: Doc) {
      let found = docs.find((doc) => matches(doc, filter));
      if (!found && opts?.upsert) {
        found = { _id: filter._id || new ObjectId(), ...update.$setOnInsert };
        docs.push(found);
      }
      return found || null;
    },
    async updateMany(filter: Doc, update: Doc) {
      let modifiedCount = 0;
      for (const doc of docs) {
        if (!matches(doc, filter)) continue;
        const changed = Object.entries(update.$set || {}).some(
          ([key, value]) => !sameValue(getPath(doc, key), value),
        );
        Object.assign(doc, update.$set || {});
        if (changed) modifiedCount += 1;
      }
      return { modifiedCount };
    },
    async deleteMany(filter: Doc) {
      let deletedCount = 0;
      for (let index = docs.length - 1; index >= 0; index -= 1) {
        if (!matches(docs[index], filter)) continue;
        docs.splice(index, 1);
        deletedCount += 1;
      }
      return { deletedCount };
    },
  };
  return {
    docs,
    db: { collection: () => collection },
  };
}

function notification(overrides: Doc): Doc {
  return {
    _id: new ObjectId(),
    userId: "admin:first@example.com",
    type: "ticket_created",
    title: "New ticket",
    message: "Needs attention",
    link: "/platform-admin/tickets?id=t1",
    read: false,
    createdAt: new Date("2026-08-22T12:00:00Z"),
    metadata: { ticketId: "t1" },
    ...overrides,
  };
}

async function testRepositoryContract() {
  const sharedT1 = notification({
    userId: PLATFORM_ADMIN_INBOX_USER_ID,
    metadata: { ticketId: "t1", platformAdminNotificationKey: "ticket_created:t1" },
  });
  const legacyT1A = notification({ userId: "admin:first@example.com" });
  const legacyT1B = notification({ userId: "admin:second@example.com" });
  const legacyT4A = notification({
    userId: "admin:first@example.com",
    type: "ticket_message",
    metadata: { ticketId: "t4" },
  });
  const legacyT4B = notification({
    userId: "admin:second@example.com",
    type: "ticket_message",
    metadata: { ticketId: "t4" },
  });
  const sharedT4 = notification({
    userId: PLATFORM_ADMIN_INBOX_USER_ID,
    type: "ticket_message",
    metadata: {
      ticketId: "t4",
      platformAdminNotificationKey: "ticket_message:t4:new-message-id",
      platformAdminLegacyKey: "ticket_message:t4:New ticket:Needs attention",
    },
  });
  const distinctLegacyT4Reply = notification({
    userId: "admin:first@example.com",
    type: "ticket_message",
    message: "A separate reply on the same ticket",
    metadata: { ticketId: "t4" },
  });
  const sharedT2 = notification({
    userId: PLATFORM_ADMIN_INBOX_USER_ID,
    type: "system",
    metadata: { ticketId: "t2", platformAdminNotificationKey: "system:t2" },
  });
  const privateRow = notification({
    userId: "shop-user@example.com",
    metadata: { ticketId: "t1" },
  });
  const fake = makeNotificationDb([
    sharedT1,
    legacyT1A,
    legacyT1B,
    legacyT4A,
    legacyT4B,
    sharedT4,
    distinctLegacyT4Reply,
    sharedT2,
    privateRow,
  ]);
  const originalGetDb = repoDeps.getDb;
  repoDeps.getDb = (async () => fake.db) as any;
  try {
    const firstAdminList = await findForAdmins(20);
    const secondAdminList = await findForAdmins(20);
    assert.deepEqual(firstAdminList, secondAdminList, "the list cannot vary by admin identity");
    assert.equal(firstAdminList.length, 4, "legacy replicas collapse without merging distinct replies");
    assert.equal(await countUnreadForAdmins(), 4, "unread count counts logical events");

    assert.equal(await markOneAdminNotificationRead(String(legacyT1A._id)), true);
    assert.equal(sharedT1.read, true);
    assert.equal(legacyT1A.read, true);
    assert.equal(legacyT1B.read, true);
    assert.equal(privateRow.read, false, "shared read must not touch a private user row");
    assert.equal(await countUnreadForAdmins(), 3);

    assert.equal(await markOneAdminNotificationRead(String(sharedT4._id)), true);
    assert.equal(sharedT4.read, true);
    assert.equal(legacyT4A.read, true);
    assert.equal(legacyT4B.read, true, "legacy replicas share read state");
    assert.equal(distinctLegacyT4Reply.read, false, "separate legacy replies stay independent");
    assert.equal(await countUnreadForAdmins(), 2);
    assert.equal(await deleteOneAdminNotification(String(sharedT4._id)), true);
    assert.equal(fake.docs.includes(distinctLegacyT4Reply), true, "shared delete preserves a distinct same-ticket reply");
    assert.equal(fake.docs.includes(legacyT4A), false, "shared delete removes only its legacy replicas");

    assert.equal(await markAllAdminNotificationsRead(), 2);
    assert.equal(await countUnreadForAdmins(), 0);
    assert.equal(privateRow.read, false, "mark-all remains admin-scoped");

    assert.equal(await deleteOneAdminNotification(String(legacyT1A._id)), true);
    assert.equal(fake.docs.some((doc) => ["t1"].includes(doc.metadata?.ticketId) && doc.userId.startsWith("admin:")), false);
    assert.equal(fake.docs.includes(privateRow), true, "delete remains isolated from private users");

    const sharedDoc = {
      platformAdminNotificationKey: "system:t3",
      type: "system" as const,
      title: "Escalation",
      message: "One logical event",
      metadata: { ticketId: "t3" },
    };
    const ids = await Promise.all(
      Array.from({ length: 10 }, () => upsertPlatformAdminNotification(sharedDoc)),
    );
    assert.equal(new Set(ids.map(String)).size, 1, "concurrent retries converge on a deterministic id");
    assert.equal(
      fake.docs.filter((doc) => doc.metadata?.platformAdminNotificationKey === "system:t3").length,
      1,
      "producer retries create one shared row",
    );
  } finally {
    repoDeps.getDb = originalGetDb;
  }
}

async function testRoutes() {
  const originalListDeps = { ...listDeps };
  const originalCountDeps = { ...countDeps };
  const originalItemDeps = { ...itemDeps };
  try {
    listDeps.requirePlatformAdmin = (async () => {
      throw new Error("Not a platform admin");
    }) as any;
    let response = await listNotifications(new Request("http://localhost/api/platform-admin/notifications") as any);
    assert.equal(response.status, 401, "non-admin list request is rejected");

    const sample = [notification({ userId: PLATFORM_ADMIN_INBOX_USER_ID })];
    let requestedLimit = 0;
    listDeps.getPlatformAdminNotifications = (async (limit: number) => {
      requestedLimit = limit;
      return sample;
    }) as any;
    listDeps.getAdminUnreadCount = (async () => 1) as any;
    for (const email of ["first@example.com", "second@example.com"]) {
      listDeps.requirePlatformAdmin = (async () => ({ email })) as any;
      response = await listNotifications(
        new Request("http://localhost/api/platform-admin/notifications?limit=999") as any,
      );
      const body = await response.json();
      assert.equal(body.unreadCount, 1);
      assert.equal(body.notifications.length, 1);
    }
    assert.equal(requestedLimit, 100, "list limit is bounded");

    listDeps.markAllPlatformAdminNotificationsRead = (async () => 4) as any;
    response = await mutateNotifications(
      new Request("http://localhost/api/platform-admin/notifications", {
        method: "POST",
        body: JSON.stringify({ action: "markAllRead" }),
      }) as any,
    );
    assert.deepEqual(await response.json(), { ok: true, markedCount: 4 });
    response = await mutateNotifications(
      new Request("http://localhost/api/platform-admin/notifications", {
        method: "POST",
        body: "{not-json",
      }) as any,
    );
    assert.equal(response.status, 400, "malformed mark-all JSON is rejected");

    countDeps.requirePlatformAdmin = (async () => ({ email: "other@example.com" })) as any;
    countDeps.getAdminUnreadCount = (async () => 0) as any;
    response = await countNotifications();
    assert.deepEqual(await response.json(), { ok: true, unreadCount: 0 });

    itemDeps.requirePlatformAdmin = (async () => {
      throw new Error("Unauthorized");
    }) as any;
    response = await patchNotification(
      new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ read: true }) }) as any,
      { params: { id: String(new ObjectId()) } },
    );
    assert.equal(response.status, 401, "non-admin item mutation is rejected");

    itemDeps.requirePlatformAdmin = (async () => ({ email: "admin@example.com" })) as any;
    itemDeps.markPlatformAdminNotificationRead = (async () => false) as any;
    response = await patchNotification(
      new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ read: true }) }) as any,
      { params: { id: String(new ObjectId()) } },
    );
    assert.deepEqual(await response.json(), { ok: true, changed: false }, "mark-one is idempotent");
    response = await patchNotification(
      new Request("http://localhost", { method: "PATCH", body: "{not-json" }) as any,
      { params: { id: String(new ObjectId()) } },
    );
    assert.equal(response.status, 400, "malformed mark-one JSON is rejected");

    itemDeps.deletePlatformAdminNotification = (async () => false) as any;
    response = await deleteNotification(new Request("http://localhost") as any, {
      params: { id: String(new ObjectId()) },
    });
    assert.deepEqual(await response.json(), { ok: true, deleted: false }, "delete is idempotent");
  } finally {
    Object.assign(listDeps, originalListDeps);
    Object.assign(countDeps, originalCountDeps);
    Object.assign(itemDeps, originalItemDeps);
  }
}

function testProducerAndPresentationContracts() {
  const producerFiles = [
    "app/api/support/tickets/route.ts",
    "app/api/support/tickets/[ticketId]/route.ts",
    "app/api/support/chat/escalate/route.ts",
    "app/api/extension/support/route.ts",
  ];
  const sources = producerFiles.map((file) => [file, readFileSync(file, "utf8")] as const);
  for (const [file, source] of sources) {
    assert.equal(source.includes("userId: `admin:"), false, `${file} must not fan out in-app rows`);
    assert.equal(source.includes("createNotificationsForUsers"), false, `${file} must use the shared producer`);
    assert.match(source, /createPlatformAdminNotification\(/, `${file} creates a shared admin event`);
    assert.match(source, /to:\s*adminEmail/, `${file} keeps per-recipient admin email`);
  }
  assert.equal(
    (sources[3][1].match(/createPlatformAdminNotification\(/g) || []).length,
    2,
    "extension ticket and escalation actions each create one shared event",
  );

  const privateRoutes = [
    readFileSync("app/api/notifications/route.ts", "utf8"),
    readFileSync("app/api/notifications/[id]/route.ts", "utf8"),
  ].join("\n");
  assert.match(privateRoutes, /session\.email/, "ordinary notification APIs remain exact-user scoped");
  assert.equal(privateRoutes.includes("PLATFORM_ADMIN_INBOX_USER_ID"), false);

  const bell = readFileSync("components/ui/NotificationBell.tsx", "utf8");
  assert.match(bell, /bg-white border-slate-300/, "admin surface is opaque and high contrast");
  assert.match(bell, /max-h-\[calc\(100dvh-5rem\)\]/, "panel stays within the viewport");
  assert.match(bell, /sm:left-0 sm:right-auto/, "desktop placement remains attached to the sidebar bell");
  assert.match(bell, /whitespace-normal break-words/, "titles and messages wrap");
  assert.match(bell, /bg-blue-50 border-blue-600/, "unread state is visually distinct");
  assert.equal(bell.includes("truncate"), false, "notification content is not destructively truncated");
  assert.equal(bell.includes("line-clamp"), false, "notification messages are not clamped");
  assert.match(bell, /aria-label="Mark notification as read"/, "notification actions are accessible");
}

async function main() {
  await testRepositoryContract();
  await testRoutes();
  testProducerAndPresentationContracts();
  console.log("Shared platform-admin notification inbox smoke tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});