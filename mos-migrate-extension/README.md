# MOS Migrate (Owner Only)

A standalone Chrome extension that hosts the Tekmetric Shop Migration
wizard. **This extension is for the MOS owner only** — it refuses to
operate for any account that is not on the `SUPER_ADMIN_EMAILS`
allowlist (see `lib/super-admins.ts`).

It was extracted out of the customer-facing `mos-tools-extension` so the
wizard can never leak to platform admins or shop users via a future
regression.

## Allowed accounts

Only the emails on the server-side super-admin allowlist can use this
extension. Any other account that signs in will see a "This extension
is for the MOS owner only" message and the wizard will not render.

**Authoritative source:** `lib/super-admins.ts` →
`SUPER_ADMIN_EMAILS`. As of this writing the allowed emails are:

- `brandoncrusha@gmail.com`
- `brandoncrusha+1@gmail.com`

If you change the allowlist, update both `lib/super-admins.ts` **and**
this README so the two stay in sync.

## Loading the extension

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `mos-migrate-extension/`
   folder from this repo.
4. Pin the **MOS Migrate (Owner Only)** action to your toolbar so it's
   easy to find.
5. Click the toolbar icon to open the side panel; sign in with an
   owner-allowlisted email.

## How it works

1. Sign in to the side panel using your MOS credentials and the API URL
   (defaults to `https://mos.tools`).
2. Open each Tekmetric shop you want to migrate from/into in a tab once
   while this extension is installed — the background script captures
   the shop's `x-auth-token` header and relays it to the MOS backend so
   the server-side migration orchestrator can call Tekmetric on your
   behalf. Each shop's token-cache freshness is shown as a badge in the
   wizard.
3. Pick a source and destination Tekmetric shop, then walk the wizard:
   start run → dump → plan/load-core → resolve overrides →
   load-extras (inspections + photos).

All migration business logic runs server-side under
`app/api/extension/tekmetric-migration/*`; this extension is just the
operator UI plus the auth and token relay glue.

## Don't share this extension

This extension is a one-off owner tool. Don't publish it to the Chrome
Web Store and don't hand it to platform admins or shop users — they
won't be able to use it anyway, but the convention is "owner sideload
only".
