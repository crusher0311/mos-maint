# MOS Maintenance MVP - Complete Rebuild Plan

## Executive Summary

This document outlines a ground-up rebuild of MOS Maintenance MVP based on architectural principles discussed between Jeremy and Brandon. The rebuild prioritizes feature flags on everything, clear internal/external user separation, master settings inheritance, and modular feature design.

**Estimated Timeline:** 5-6 weeks  
**Approach:** Parallel rebuild (new project, migrate shops gradually)

---

## Core Architecture Principles

### 1. Feature Flag System (Everything Wrapped)
- **Page-level flags**: Every page assigned to a stage
- **Feature-level flags**: Every button, icon, component wrapped
- **User-stage assignment**: Each user assigned to staging/beta/production
- **Granular control**: Platform admins can enable/disable anything for anyone

### 2. Three-Tier Staging
| Stage | Purpose | Who Sees It |
|-------|---------|-------------|
| Staging | Internal testing | Platform admins only |
| Beta | Selected customer testing | Invited shops |
| Production | Live for everyone | All users |

### 3. User Architecture
**Internal Users:**
- Platform Admin (full access, feature flag control)
- Support Staff (ghost login, messaging)
- Developer (staging access)

**External Users:**
- Enterprise Admin (multi-shop management)
- Shop Owner (full shop access)
- Manager (operational access)
- Technician (limited access)

### 4. Master Settings Layer
- Locked defaults that cascade to all shops
- Shop-level overrides where permitted
- Enterprise-level settings between master and shop
- White-label agency inheritance

### 5. Easy Buttons
- One-click onboarding flows for each feature
- Wizard-based setup instead of complex forms
- Clone settings across enterprise locations

---

## Phase 0: Foundation (Week 1)

### 0.1 Project Setup
- [ ] Initialize Next.js project with TypeScript
- [ ] Configure MongoDB connection
- [ ] Set up Tailwind CSS with design tokens
- [ ] Configure environment variables structure
- [ ] Create base folder structure

### 0.2 Feature Flag System
```typescript
// lib/feature-flags/types.ts
interface FeatureFlag {
  id: string;
  name: string;
  description: string;
  stage: 'staging' | 'beta' | 'production';
  type: 'page' | 'feature' | 'component';
  enabled: boolean;
  shopOverrides?: { shopId: string; enabled: boolean }[];
}

interface UserStage {
  userId: string;
  stage: 'staging' | 'beta' | 'production';
  betaFeatures?: string[]; // specific beta features enabled
}
```

- [ ] Create feature flag database schema
- [ ] Build feature flag provider (React context)
- [ ] Create `useFeatureFlag` hook
- [ ] Create `<FeatureGate>` wrapper component
- [ ] Build platform admin UI for flag management

### 0.3 User System
```typescript
// lib/users/types.ts
interface User {
  id: string;
  email: string;
  name: string;
  userType: 'internal' | 'external';
  role: InternalRole | ExternalRole;
  stage: 'staging' | 'beta' | 'production';
  shopIds: string[];
  enterpriseId?: string;
}

type InternalRole = 'platform_admin' | 'support' | 'developer';
type ExternalRole = 'enterprise_admin' | 'shop_owner' | 'manager' | 'technician';
```

- [ ] Create user database schema
- [ ] Build auth system with role-based access
- [ ] Create permission middleware
- [ ] Build ghost login for support staff
- [ ] Create role switcher for testing

### 0.4 Master Settings
```typescript
// lib/settings/types.ts
interface MasterSettings {
  id: 'master';
  locked: true;
  onboarding: OnboardingConfig;
  defaultWorkflows: Workflow[];
  tourGuides: TourGuide[];
  banners: Banner[];
}

interface ShopSettings {
  shopId: string;
  inheritsFrom: 'master' | string; // master or enterpriseId
  overrides: Partial<SettingsOverrides>;
}
```

- [ ] Create master settings schema
- [ ] Build settings inheritance logic
- [ ] Create settings override system
- [ ] Build master settings admin UI

---

## Phase 1: Core Data Layer (Week 1-2)

### 1.1 Database Schema

**Collections:**
```
users                 # All users (internal + external)
shops                 # Shop configurations
enterprises           # Multi-shop parents
feature_flags         # Flag definitions
user_feature_access   # Per-user flag overrides
master_settings       # Locked defaults
shop_settings         # Shop-level overrides
messages              # Internal <-> external messaging
audit_log             # All admin actions
```

- [ ] Define all MongoDB schemas
- [ ] Create indexes for performance
- [ ] Build data access layer
- [ ] Add audit logging middleware

### 1.2 API Architecture
```typescript
// Every API route follows this pattern:
export async function handler(req, res) {
  // 1. Auth check
  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  
  // 2. Permission check
  if (!hasPermission(user, 'required_permission')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  // 3. Feature flag check
  if (!isFeatureEnabled('feature_name', user)) {
    return res.status(404).json({ error: 'Not found' });
  }
  
  // 4. Rate limit check
  if (await isRateLimited(user, 'endpoint')) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  
  // 5. Actual handler logic
  // ...
  
  // 6. Audit log
  await logAction(user, 'action_name', { details });
}
```

- [ ] Create auth middleware
- [ ] Create permission middleware
- [ ] Create feature flag middleware
- [ ] Create rate limiting middleware
- [ ] Create audit logging middleware
- [ ] Build standard API response helpers

### 1.3 Messaging Backbone
- [ ] Create messages collection schema
- [ ] Build internal -> external messaging
- [ ] Build external -> internal support tickets
- [ ] Integrate SMS (Twilio)
- [ ] Integrate email (Resend)
- [ ] Create in-app notification system

---

## Phase 2: Admin Backbone (Week 2)

### 2.1 Platform Admin Panel
**Pages:**
- `/platform-admin/dashboard` - Overview stats
- `/platform-admin/feature-flags` - Manage all flags
- `/platform-admin/users` - User directory with stage assignment
- `/platform-admin/shops` - Shop management
- `/platform-admin/master-settings` - Edit locked defaults
- `/platform-admin/messages` - Support ticket queue
- `/platform-admin/audit-log` - All admin actions

- [ ] Build platform admin layout
- [ ] Create feature flag manager
- [ ] Create user stage manager
- [ ] Create shop onboarding tools
- [ ] Create master settings editor
- [ ] Create support message queue
- [ ] Create audit log viewer

### 2.2 Configuration Manager
- [ ] Build page registry (which stage each page is in)
- [ ] Build feature registry (which stage each feature is in)
- [ ] Build user stage assignment UI
- [ ] Create "promote to production" workflow

---

## Phase 3: Shop Experience (Week 2-3)

### 3.1 Shop Dashboard
- [ ] Create clean dashboard layout
- [ ] Build feature-aware navigation (only show enabled features)
- [ ] Create quick action cards
- [ ] Add easy button onboarding prompts

### 3.2 Shop Settings
**Sections (each behind feature flags):**
- General (name, contact, logo)
- Integrations (SMS connections)
- Team (user management)
- Billing (Stripe portal)
- Features (enable/disable modules)

- [ ] Build settings layout with inheritance indicators
- [ ] Create general settings page
- [ ] Create integrations hub
- [ ] Create team management
- [ ] Create billing portal link
- [ ] Create feature toggle page

### 3.3 Enterprise Layer
- [ ] Build enterprise dashboard (multi-shop view)
- [ ] Create shop switcher
- [ ] Build settings cloning (copy settings to all locations)
- [ ] Create enterprise-wide analytics
- [ ] Build enterprise user management

---

## Phase 4: Feature Modules (Week 3-4)

### Module Template
Every feature module follows this pattern:

```
// Module structure:
/lib/[feature]/
  types.ts           # Data types
  api.ts             # API helpers
  hooks.ts           # React hooks
  
/components/[feature]/
  [Feature]Designer.tsx    # Main component
  [Feature]Settings.tsx    # Settings page
  [Feature]Preview.tsx     # Live preview
  
/app/api/[feature]/
  settings/route.ts        # CRUD settings
  generate/route.ts        # Generate output
  
/app/dashboard/settings/[feature]/
  page.tsx                 # Settings page
```

### 4.1 Oil Stickers Module
**Flag:** `STICKER_MODULE`  
**Easy Button:** "Enable Stickers" -> Designer opens

- [ ] Create sticker designer types
- [ ] Build sticker designer canvas
- [ ] Build sticker settings page
- [ ] Build sticker generation API
- [ ] Create quick sticker flow

### 4.2 Keytags Module
**Flag:** `KEYTAG_MODULE`  
**Easy Button:** "Enable Keytags" -> Designer opens

- [ ] Migrate existing keytag designer
- [ ] Wrap in feature flags
- [ ] Add easy button onboarding

### 4.3 Vehicle Analysis Module
**Flag:** `ANALYSIS_MODULE`  
**Easy Button:** "Connect Your Shop System" -> Integration wizard

- [ ] Create analysis dashboard
- [ ] Build recommendation engine
- [ ] Create maintenance queue
- [ ] Integrate with SMS adapters

### 4.4 Common Failures Module
**Flag:** `FAILURES_MODULE`  
**Easy Button:** Auto-enabled with analysis

- [ ] Create failures advisor UI
- [ ] Build pattern matching engine
- [ ] Create shop-specific training

### 4.5 Auto Booking Module
**Flag:** `BOOKING_MODULE`  
**Easy Button:** "Enable Auto Booking" -> Calendar setup

- [ ] Create booking scheduler
- [ ] Build availability calendar
- [ ] Create booking queue
- [ ] Integrate with SMS calendars

---

## Phase 5: Integrations Layer (Week 4)

### 5.1 SMS Adapters

**Standard Interface:**
```typescript
interface SMSAdapter {
  name: string;
  connect(credentials: any): Promise<void>;
  getVehicles(shopId: string): Promise<Vehicle[]>;
  getCustomers(shopId: string): Promise<Customer[]>;
  getRepairOrders(shopId: string, since?: Date): Promise<RepairOrder[]>;
  pushToRO?(roId: string, items: LineItem[]): Promise<void>;
}
```

**Adapters to build:**
- [ ] Tekmetric adapter (OAuth)
- [ ] Protractor adapter (API key)
- [ ] AutoFlow adapter (API key)

### 5.2 External Services

**Standard Pattern:**
```typescript
interface ServiceAdapter {
  name: string;
  rateLimit: { requests: number; window: number };
  call<T>(method: string, params: any): Promise<T>;
  getCached<T>(key: string, fetcher: () => Promise<T>, ttl: number): Promise<T>;
}
```

**Services to integrate:**
- [ ] CARFAX (vehicle history)
- [ ] DataOne (VIN decoding)
- [ ] OpenAI (AI analysis)
- [ ] HoverCode (QR codes)
- [ ] Stripe (billing)
- [ ] Twilio (SMS)
- [ ] Resend (email)

### 5.3 Usage Tracking
- [ ] Create `api_usage` collection
- [ ] Build usage tracking middleware
- [ ] Create usage dashboard in platform admin
- [ ] Set up billing alerts

---

## Phase 6: Chrome Extension (Week 5)

### 6.1 Extension Architecture
- Separate codebase in `/extension`
- Communicates with main app via authenticated API
- Feature-flag aware (shows only enabled features)

### 6.2 Extension Features
- [ ] Plan tab (maintenance recommendations)
- [ ] Failures tab (common failures advisor)
- [ ] Lookup tab (job history search)
- [ ] Sticker tab (oil sticker printing)
- [ ] Keytag tab (keytag printing)
- [ ] Push-to-RO functionality

---

## Phase 7: Migration & Launch (Week 5-6)

### 7.1 Data Migration
- [ ] Build V1 -> V2 data importer
- [ ] Create shop migration script
- [ ] Test with sample shops
- [ ] Document rollback procedure

### 7.2 Parallel Running
- [ ] Deploy V2 to staging
- [ ] Migrate beta shops
- [ ] Monitor for issues
- [ ] Gradually move remaining shops

### 7.3 Cutover
- [ ] Final data sync
- [ ] DNS switch
- [ ] Monitor closely
- [ ] Keep V1 available for rollback (30 days)

---

## File Structure

```
/app
  /(auth)                    # Login, signup, password reset
  /(public)                  # Public pages
  /dashboard                 # Shop dashboard (external users)
    /settings
      /[feature]             # Feature-specific settings
  /enterprise                # Enterprise dashboard
  /platform-admin            # Internal admin panel
  /api
    /auth                    # Auth endpoints
    /shops                   # Shop CRUD
    /users                   # User management
    /feature-flags           # Flag management
    /[feature]               # Feature-specific APIs

/components
  /shared                    # Reusable UI components
  /layouts                   # Page layouts
  /[feature]                 # Feature-specific components

/lib
  /auth                      # Auth utilities
  /db                        # Database connection & helpers
  /feature-flags             # Flag system
  /settings                  # Master/shop settings
  /messaging                 # Internal/external messaging
  /adapters                  # SMS & service adapters
  /[feature]                 # Feature-specific logic

/extension                   # Chrome extension (separate)
```

---

## Success Criteria

### Foundation Complete When:
- [ ] Feature flags work at page, feature, and user level
- [ ] Users can be assigned to staging/beta/production
- [ ] Master settings cascade to shops correctly
- [ ] Internal staff can ghost login to any shop
- [ ] Messaging works between internal and external users

### Ready for Migration When:
- [ ] All current features work in V2
- [ ] Feature flags wrap everything
- [ ] Easy buttons exist for all features
- [ ] Data can be imported from V1
- [ ] Extension works with V2 APIs

### Launch Complete When:
- [ ] All shops migrated
- [ ] No critical issues for 7 days
- [ ] V1 safely archived

---

## Appendix: Prompting Strategy

When building each phase, use these prompt patterns:

**For foundation work:**
> "Build [component] with feature flag support. Every page must check user stage before rendering. Every feature must be wrapped in a FeatureGate component. Include audit logging for all admin actions."

**For feature modules:**
> "Create the [Feature] module behind the `[FLAG_NAME]` feature flag. Include: settings API, settings UI with easy button onboarding, generation API. If flag is disabled, routes return 404 and UI components render nothing."

**For integrations:**
> "Create an adapter for [Service] following our standard interface. Include: rate limiting, caching, error handling, usage tracking to api_usage collection. Never expose API keys in responses."

---

## Appendix: Key Conversation Points (Jeremy & Brandon)

### Hardware Differentiation
> "We're dealing with people that can't get rid of hardware completely. And that separates what we're doing... We're gonna have printers, phones, tags, headsets."

### Feature Flag Philosophy
> "Every single thing is called feature flag wrapped... If we don't build this way, we won't be able to release the things we want."

### Three-Tier User Staging
> "I have a configuration manager of three levels... staging, beta, production. Then each user I get to assign to a specific user what they're in."

### Page + Feature Level Flags
> "Every page I have a setting. What is this page? This is a beta page. This is a production page. Like down to every single page, in addition every single feature, every button and icon."

### Internal vs External Users
> "You've got internal users and you have external users. I've already built a seamless interworking message board by SMS, email and live chat between internal users and external users."

### Easy Buttons
> "Clones, enterprise closing, cloning, and easy buttons for customer journeys... Hit the easy button, onboard location."

---

*Document Version: 1.0*  
*Created: January 2026*  
*Based on: Jeremy & Brandon architecture discussion*
