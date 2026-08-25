/**
 * Platform-admin AutoFlow mapping repository regression coverage.
 *
 * Run:
 * NODE_OPTIONS='--require ./scripts/_stubs/server-only-stub.cjs' \
 *   npx tsx tests/autoflow-admin-mappings.smoke.ts
 */
import {
  __deps,
  AutoflowAliasNotOwnedError,
  AutoflowIdentifierConflictError,
  attachAutoflowNumber,
  detachAutoflowNumber,
} from "../lib/data/repositories/autoflow-unresolved-numbers";
import { makeFakeDb } from "./utils/fake-mongo";

let failed = 0;
function ok(name: string, condition: boolean) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

async function run() {
  console.log("autoflow admin mappings smoke");
  const originalGetDb = __deps.getDb;
  const originalGetMongoClient = __deps.getMongoClient;
  __deps.getMongoClient = async () => null as any;

  try {
    // The admin attach boundary is numeric-only; historical slugs may still be
    // detached, but can never be introduced as new learned aliases.
    {
      const fake = makeFakeDb({
        shops: [{ shopId: 99, autoflow: { domain: "target.autotext.me" } }],
        autoflow_identifier_claims: [],
      });
      __deps.getDb = async () => fake.db as any;
      let invalid: unknown = null;
      try {
        await attachAutoflowNumber(
          99,
          "harrells-nc87",
          "admin@example.com",
        );
      } catch (error) {
        invalid = error;
      }
      ok(
        "admin attachment rejects non-numeric learned aliases",
        invalid instanceof Error
          && invalid.message === "Invalid AutoFlow v4 shop number",
      );
      ok(
        "rejected non-numeric attachment reserves and writes nothing",
        fake.ops.length === 0,
      );
    }

    // Canonical v4 ownership blocks admin attachment.
    {
      const fake = makeFakeDb({
        shops: [
          { shopId: 29, name: "Canonical owner", autoflow: { shopId: "2468" } },
          { shopId: 99, name: "Target", autoflow: { domain: "target.autotext.me" } },
        ],
      });
      __deps.getDb = async () => fake.db as any;
      let conflict: unknown = null;
      try {
        await attachAutoflowNumber(99, "2468", "admin@example.com");
      } catch (error) {
        conflict = error;
      }
      ok(
        "admin attach rejects another shop's canonical v4 identity",
        conflict instanceof AutoflowIdentifierConflictError,
      );
      ok(
        "rejected admin attach performs no shop update",
        !fake.ops.some((op) => op.op === "updateOne" && (op as any).collection === "shops"),
      );
    }

    // Invalid detach must not create a false audit entry or unresolved record.
    {
      const fake = makeFakeDb({
        shops: [
          { shopId: 10, autoflow: { shopNumbers: ["1234"] } },
          { shopId: 11, autoflow: { shopNumbers: [] } },
        ],
        autoflow_unresolved_numbers: [],
      });
      __deps.getDb = async () => fake.db as any;
      let notOwned: unknown = null;
      try {
        await detachAutoflowNumber(11, "1234", "admin@example.com");
      } catch (error) {
        notOwned = error;
      }
      ok(
        "detach rejects a shop that does not own the alias",
        notOwned instanceof AutoflowAliasNotOwnedError,
      );
      ok(
        "failed detach writes no audit trail",
        !fake.ops.some(
          (op) =>
            op.op === "updateOne"
            && (op as any).collection === "autoflow_unresolved_numbers",
        ),
      );
    }

    // Valid detach removes the owned alias, releases its reservation, and only
    // then records an auditable cleanup entry.
    {
      const fake = makeFakeDb({
        shops: [{ shopId: 10, autoflow: { shopNumbers: ["1234"] } }],
        autoflow_identifier_claims: [
          { _id: "1234", normalizedIdentifier: "1234", ownerShopId: 10 },
        ],
        autoflow_unresolved_numbers: [],
      });
      __deps.getDb = async () => fake.db as any;
      await detachAutoflowNumber(10, "1234", "admin@example.com");
      const auditWrite = fake.ops.find(
        (op) =>
          op.op === "updateOne"
          && (op as any).collection === "autoflow_unresolved_numbers",
      ) as any;
      ok(
        "valid detach removes the alias from the owning shop",
        fake.collections.shops[0].autoflow.shopNumbers.length === 0,
      );
      ok(
        "valid detach releases the atomic identifier reservation",
        fake.collections.autoflow_identifier_claims.length === 0,
      );
      ok(
        "valid detach records actor and detached audit action",
        auditWrite?.update?.$push?.auditTrail?.action === "detached"
          && auditWrite?.update?.$push?.auditTrail?.actor === "admin@example.com",
      );
    }

    // If attach auditing fails in the no-session fallback, both the alias and
    // its reservation are compensated instead of leaking partial ownership.
    {
      const fake = makeFakeDb({
        shops: [{ shopId: 20, autoflow: { domain: "twenty.autotext.me", shopNumbers: [] } }],
        autoflow_identifier_claims: [],
        autoflow_unresolved_numbers: [],
      });
      const originalCollection = fake.db.collection.bind(fake.db);
      (fake.db as any).collection = (name: string) => {
        const collection = originalCollection(name) as any;
        if (name === "autoflow_unresolved_numbers") {
          collection.updateOne = async () => {
            throw new Error("simulated audit failure");
          };
        }
        return collection;
      };
      __deps.getDb = async () => fake.db as any;
      let thrown: unknown = null;
      try {
        await attachAutoflowNumber(20, "2020", "admin@example.com");
      } catch (error) {
        thrown = error;
      }
      ok(
        "attach propagates an audit failure",
        thrown instanceof Error && thrown.message === "simulated audit failure",
      );
      ok(
        "failed attach audit rolls back the alias",
        fake.collections.shops[0].autoflow.shopNumbers.length === 0,
      );
      ok(
        "failed attach audit releases the reservation",
        fake.collections.autoflow_identifier_claims.length === 0,
      );
    }

    // If detach auditing fails, fallback compensation restores both alias and
    // reservation so cleanup is not silently unaudited.
    {
      const fake = makeFakeDb({
        shops: [{ shopId: 30, autoflow: { shopNumbers: ["3030"] } }],
        autoflow_identifier_claims: [
          { _id: "3030", normalizedIdentifier: "3030", ownerShopId: 30 },
        ],
        autoflow_unresolved_numbers: [],
      });
      const originalCollection = fake.db.collection.bind(fake.db);
      (fake.db as any).collection = (name: string) => {
        const collection = originalCollection(name) as any;
        if (name === "autoflow_unresolved_numbers") {
          collection.updateOne = async () => {
            throw new Error("simulated audit failure");
          };
        }
        return collection;
      };
      __deps.getDb = async () => fake.db as any;
      let thrown: unknown = null;
      try {
        await detachAutoflowNumber(30, "3030", "admin@example.com");
      } catch (error) {
        thrown = error;
      }
      ok(
        "detach propagates an audit failure",
        thrown instanceof Error && thrown.message === "simulated audit failure",
      );
      ok(
        "failed detach audit restores the alias",
        fake.collections.shops[0].autoflow.shopNumbers.includes("3030"),
      );
      ok(
        "failed detach audit restores the reservation",
        fake.collections.autoflow_identifier_claims.some(
          (claim) => claim._id === "3030" && claim.ownerShopId === 30,
        ),
      );
    }
  } finally {
    __deps.getDb = originalGetDb;
    __deps.getMongoClient = originalGetMongoClient;
  }

  if (failed) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll AutoFlow admin mapping checks passed.");
}

run().catch((error) => {
  console.error("Smoke test crashed:", error);
  process.exit(1);
});