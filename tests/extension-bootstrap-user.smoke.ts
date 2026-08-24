/**
 * Security contract for matching provider identities to existing MOS users.
 *
 * Run: npx tsx tests/extension-bootstrap-user.smoke.ts
 */
import { matchExistingExtensionUser } from "../lib/extension-bootstrap-user";
import { capabilitiesForVerifiedUser } from "../lib/extension-auth";

let failed = 0;
function ok(name: string, condition: boolean) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

const proof = {
  provider: "tekmetric" as const,
  smsShopId: "1234",
  mosShopId: 85,
  employee: {
    subject: "employee-7",
    verifiedEmail: "advisor@example.com",
  },
};
const user = (overrides: Record<string, unknown> = {}) => ({
  _id: "u1",
  email: "advisor@example.com",
  role: "user",
  shopId: 85,
  shopIds: [85],
  ...overrides,
});

console.log("extension bootstrap user matching");

const unique = matchExistingExtensionUser({ ...proof, users: [user()] });
ok("matches one active, assigned user by verified email", unique?._id === "u1");

ok(
  "rejects duplicate-email ambiguity",
  matchExistingExtensionUser({
    ...proof,
    users: [user(), user({ _id: "u2" })],
  }) === null,
);
ok(
  "rejects a disabled user",
  matchExistingExtensionUser({
    ...proof,
    users: [user({ disabled: true })],
  }) === null,
);
ok(
  "rejects a user assigned only to another shop",
  matchExistingExtensionUser({
    ...proof,
    users: [user({ shopId: 86, shopIds: [86] })],
  }) === null,
);
ok(
  "rejects unverified email claims",
  matchExistingExtensionUser({
    ...proof,
    employee: { subject: undefined, verifiedEmail: undefined },
    users: [user()],
  }) === null,
);

const pinned = user({
  providerIdentities: [
    { provider: "tekmetric", subject: "employee-7", smsShopId: "1234" },
  ],
});
ok(
  "pinned subject blocks a different provider account even with matching email",
  matchExistingExtensionUser({
    ...proof,
    employee: { subject: "attacker-99", verifiedEmail: "advisor@example.com" },
    users: [pinned],
  }) === null,
);
ok(
  "pinned subject still matches at a new tenant the user is assigned to",
  matchExistingExtensionUser({
    ...proof,
    smsShopId: "9999",
    users: [pinned],
  })?._id === "u1",
);

const mapped = user({
  email: "different@example.com",
  extensionProviderIdentities: {
    tekmetric: [{ subject: "employee-7", smsShopId: "1234" }],
  },
});
ok(
  "matches an explicit provider subject and tenant",
  matchExistingExtensionUser({ ...proof, users: [mapped] })?._id === "u1",
);
ok(
  // Subjects are provider-global, so the same subject may elevate at a new
  // tenant; only a DIFFERENT subject is blocked from using email fallback.
  "does not let matching email bypass a pinned-subject mismatch",
  matchExistingExtensionUser({
    ...proof,
    users: [
      user({
        extensionProviderIdentities: {
          tekmetric: [{ subject: "someone-else-42", smsShopId: "1234" }],
        },
      }),
    ],
  }) === null,
);

const existingOwner = user({ role: "owner" });
const ownerAuthority = capabilitiesForVerifiedUser(existingOwner);
ok("preserves an existing MOS owner's write permission", ownerAuthority.includes("write"));
ok("does not infer platform admin from a provider owner role", !ownerAuthority.includes("admin"));
const existingPlatformAdmin = user({ role: "platform_admin", isPlatformAdmin: true });
ok(
  "preserves platform admin only when already stored on the MOS user",
  capabilitiesForVerifiedUser(existingPlatformAdmin).includes("admin"),
);

if (failed > 0) process.exit(1);
console.log("extension bootstrap user matching: PASS");