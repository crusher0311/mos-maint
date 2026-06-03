---
name: /admin vs /platform-admin are different auth realms
description: which admin area to put platform-admin UI under, and why one redirects to /dashboard
---

The app has TWO separate admin areas with DIFFERENT auth:

- `/admin/*` — gated by `app/admin/layout.tsx` using `requireSession()` + a
  `session.role` check (`admin` | `platform_admin`). This is the regular user
  session.
- `/platform-admin/*` — gated by `app/platform-admin/layout.tsx` using
  `requirePlatformAdmin()`, a **separate platform-admin login/session**
  (`getSession().isPlatformAdmin`). The real operator UI + nav
  (`components/ui/PlatformAdminSidebar.tsx`) lives here.

**Why it matters:** an operator who logs in through the platform-admin system
does NOT necessarily satisfy `requireSession()`'s role check, so any new operator
page placed under `/admin/*` silently redirects them to `/dashboard` (looks like
a 404 / missing page). This bit the BullMQ backfill queue dashboard — it was
first built at `app/admin/queues` and was unreachable until moved to
`app/platform-admin/queues` (+ API under `app/api/platform-admin/queues`).

**How to apply:** new platform-admin operator surfaces (dashboards, ops tools)
go under `app/platform-admin/` with the page calling `requirePlatformAdmin()`,
APIs under `app/api/platform-admin/` also gating with `requirePlatformAdmin()`
(return 401 on failure), and the nav link added to `PlatformAdminSidebar.tsx` —
NOT the `/admin` layout's sidebar.
