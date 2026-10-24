# Trial permission boundary

Request-time entitlement resolution is authoritative; cron and session lifetime do not extend a trial. `trial.endsAt`, when present, takes precedence over `trialEndsAt`, even if null or malformed. Missing or invalid trial deadlines deny trial access. Expiration is inclusive (`now >= deadline`).

Configured shop/enterprise flags are retained as preferences, not purchased grants. Non-trial Stripe packages are intersected with the current package. Invoice contracts, demo/enterprise status and founder policies retain explicit commercial exceptions. Workflow remains location-only opt-in and still requires eligible billing. Active standalone feature subscriptions with a subscription ID are separate paid add-ons; trialing add-ons do not qualify.

No live rollout actions were performed. Before rollout, operators should review legacy trial records without deadlines and catalog subscriptions with unknown price IDs; do not bulk repair or restart these trials. New custom commercial purchases need an approved catalog mapping rather than a guessed higher package. An ordinary update to an existing, non-trial paid contract retains its established known plan for the same subscription when its price is no longer in current settings. A known mapped downgrade still replaces that plan. No schema migration or canonical-store flag change is required.

MOS Pro and BrandPro (`oil_sticker_legacy`) retain their explicit purchased feature sets even when the catalog contains only modern tier tags. A catalog row explicitly marked inactive still disables that feature.

Offline checks:

```
env -i PATH="$PATH" HOME="$HOME" NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' node --import tsx tests/trial-expiration.smoke.ts
node tests/trial-expiration-ui.smoke.cjs
```
