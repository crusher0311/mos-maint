/**
 * Task #1287 manual-number regression coverage.  Exercises the real mapping
 * repository against the in-memory Mongo fixture only; it never connects to
 * the configured database.
 */
import {
  __deps,
  AutoflowIdentifierConflictError,
  attachAutoflowNumber,
  detachAutoflowNumber,
} from "../lib/data/repositories/autoflow-unresolved-numbers";
import { makeFakeDb } from "./utils/fake-mongo";

let failed = 0;
function ok(name: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const originalGetDb = __deps.getDb;
  const originalGetMongoClient = __deps.getMongoClient;
  __deps.getMongoClient = async () => null as any;

  try {
    const fake = makeFakeDb({
      shops: [
        {
          shopId: 432,
          name: "Grand Rapids Motorcar Service",
          autoflow: {
            domain: "grandrapidsmotorcar.autotext.me",
            shopNumbers: [],
          },
        },
        {
          shopId: 900,
          name: "Other AutoFlow",
          autoflow: { domain: "other.autotext.me", shopNumbers: [] },
        },
        {
          shopId: "legacy-shop",
          name: "Legacy string identity",
          autoflow: { domain: "legacy.autotext.me", shopNumbers: [] },
        },
      ],
      autoflow_identifier_claims: [],
      autoflow_unresolved_numbers: [],
    });
    __deps.getDb = async () => fake.db as any;

    await attachAutoflowNumber(432, "615", "admin@example.com");
    ok(
      "manual attach supports an unseen number",
      fake.collections.shops[0].autoflow.shopNumbers.includes("615"),
    );
    ok(
      "manual attach preserves MOS identity and AutoFlow domain",
      fake.collections.shops[0].shopId === 432 &&
        fake.collections.shops[0].autoflow.domain ===
          "grandrapidsmotorcar.autotext.me",
    );
    ok(
      "manual attach marks unresolved number resolved",
      fake.collections.autoflow_unresolved_numbers[0]?.resolvedShopId === 432,
    );

    await attachAutoflowNumber(432, "615", "admin@example.com");
    ok(
      "repeating the same attach is idempotent for the alias",
      fake.collections.shops[0].autoflow.shopNumbers.filter((n: string) => n === "615")
        .length === 1,
    );
    ok(
      "repeating the same attach is idempotent for the atomic claim",
      fake.collections.autoflow_identifier_claims.filter(
        (claim: any) => claim._id === "615" && claim.ownerShopId === 432,
      ).length === 1,
    );

    let conflict: unknown;
    try {
      await attachAutoflowNumber(900, "615", "admin@example.com");
    } catch (error) {
      conflict = error;
    }
    ok(
      "duplicate manual ownership remains fail-closed",
      conflict instanceof AutoflowIdentifierConflictError,
    );
    ok(
      "conflicting attach does not change the original owner",
      fake.collections.shops[1].autoflow.shopNumbers.length === 0,
    );

    await attachAutoflowNumber("legacy-shop", "700", "admin@example.com");
    ok(
      "repository attach preserves a legacy string shop identity",
      fake.collections.shops[2].autoflow.shopNumbers.includes("700") &&
        fake.collections.shops[2].shopId === "legacy-shop",
    );
    await detachAutoflowNumber("legacy-shop", "700", "admin@example.com");
    ok(
      "repository detach accepts the same legacy string identity",
      fake.collections.shops[2].autoflow.shopNumbers.length === 0,
    );
  } finally {
    __deps.getDb = originalGetDb;
    __deps.getMongoClient = originalGetMongoClient;
  }

  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});