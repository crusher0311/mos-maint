# Stripe Secret Key Exposure Audit (2026-06-19)

## Context
Stripe flagged that a live secret key (`sk_live_…Q3Uo7v`) was found publicly
online and warned it would be auto-deactivated within ~7 days. This audit
confirms there is no remaining in-code / in-history / in-assets exposure,
confirms keys are read only from environment secrets, confirms the key is never
logged or returned to clients, and documents the rotation steps for the operator.

## Scope
- All tracked source (`*.ts`, `*.js`, `*.md`, configs)
- `attached_assets/` including binary files (`.har`, `.pdf`, images)
- Full git history (every commit, every blob)
- Every place a Stripe client is constructed or a Stripe secret is read

## Commands run & results

### 1. Tracked source — secret / restricted key literals
```
rg -n "sk_live_|sk_test_|rk_live_|rk_test_" --hidden -g '!.git'
```
**Result: CLEAN.** No real key value. Every match is a documentation
placeholder (`sk_test_...`, `sk_live_...`) in `FEATURE_BACKLOG.md`,
`DEPLOYMENT.md`, the task files under `.local/`, and the Stripe skill template.

### 2. Publishable keys
```
rg -n "pk_live_|pk_test_" --hidden -g '!.git'
```
**Result:** One real `pk_live_…` value appears inside three captured
browser-traffic files:
`attached_assets/shop.tekmetric.com_*.har`. The `referrer=shop.tekmetric.com`
in the surrounding event payload shows this is **Tekmetric's own publishable
key**, not MOS's. Publishable keys are public by design (they ship to browsers),
so this is **not a secret leak**. Tracked separately for HAR cleanup
(see follow-up "Remove captured browser-traffic files…").

### 3. Git history (all blobs)
```
git log --all -p | rg "sk_live_[A-Za-z0-9]+|sk_test_…|rk_live_…|rk_test_…"
```
**Result: CLEAN.** No Stripe secret key value was ever committed in any commit.

### 4. Binary assets (PDF text + raw strings)
```
for f in attached_assets/*.pdf; do pdftotext -q "$f" - | rg "sk_/rk_/pk_…"; done
find attached_assets -type f -print0 | xargs -0 strings | rg "sk_live_/sk_test_/rk_…"
```
**Result: CLEAN.** No secret/restricted key in any PDF (including the Stripe
account-notice email PDF) or any other binary asset. The notice email does not
contain the full secret value.

### 5. Stripe client construction / env usage
```
rg -n "new Stripe\(|STRIPE_SECRET_KEY|getStripe\(\)"
```
**Result:** All Stripe clients read the secret **only** from
`process.env.STRIPE_SECRET_KEY`. `lib/stripe.ts#getStripe()` throws a clear
`"STRIPE_SECRET_KEY is not configured"` error when the var is missing and pins
the API version. Every route now obtains its client via `getStripe()`.
- Fixed in this audit: `app/api/platform-admin/stripe/products/route.ts`
  previously did `new Stripe(process.env.STRIPE_SECRET_KEY!)` at module load
  (non-null assertion, no clean error, unpinned API version). It now uses the
  shared `getStripe()` helper.

### 6. Key leakage in output
```
rg -n "console\.(log|error|warn|info).*(STRIPE_SECRET_KEY|stripeKey|secretKey)"
```
**Result: CLEAN.** The secret is never logged, never put in an error message,
never returned by an API route, and never sent to the client/extension.

## Rotation verification (read-only)
With the configured live key, `getStripe()` initializes and a read-only
`stripe.products.list({ limit: 1 })` call succeeds. The new key Brandon sets
will work through the exact same env-only path — no code change needed to adopt it.

## Operator follow-ups (Brandon — out of code scope)
1. **Stripe dashboard:** generate the new secret key, then deactivate/roll the
   exposed `sk_live_…Q3Uo7v` key.
2. **Review activity:** check Stripe's payment/payout/API logs for any
   unauthorized activity while the old key was exposed.
3. **Update the secret on every host that runs this app:**
   - Replit: update the `STRIPE_SECRET_KEY` secret (this repl currently holds a
     `sk_live_` value).
   - Render production web service `mos-tools` **and** the
     `backfill-drain-worker` service — update `STRIPE_SECRET_KEY` (env group or
     per-service), then restart/redeploy so the new value is picked up.
4. **No history purge required:** git history contains no secret key, so no
   `git filter-repo` / BFG cleanup is needed.

## Summary
- No MOS Stripe secret or restricted key in tracked source, assets, or git
  history. **Exposure source is not in this repository.**
- Keys are loaded only from environment secrets, with a clean missing-key error.
- The secret is never logged or returned to clients.
- Rotation is a pure secret-value swap on each host; no code change required.
