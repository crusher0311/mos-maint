-- Drop CRM and Rescue Rover tables (extracted to separate Replit project).
-- See replit.md "CRM and Rescue Rover Extracted" for context.

-- Onboarding / content / tours / banners / guides
DROP TABLE IF EXISTS "user_workflow_sequence_progress" CASCADE;
DROP TABLE IF EXISTS "workflow_sequences" CASCADE;
DROP TABLE IF EXISTS "user_banner_progress" CASCADE;
DROP TABLE IF EXISTS "banners" CASCADE;
DROP TABLE IF EXISTS "user_onboarding_guide_progress" CASCADE;
DROP TABLE IF EXISTS "onboarding_guides_content" CASCADE;
DROP TABLE IF EXISTS "user_tour_progress" CASCADE;
DROP TABLE IF EXISTS "tours" CASCADE;
DROP TABLE IF EXISTS "onboarding_card_progress" CASCADE;
DROP TABLE IF EXISTS "onboarding_cards" CASCADE;
DROP TABLE IF EXISTS "onboarding_step_checklists" CASCADE;
DROP TABLE IF EXISTS "onboarding_checklists" CASCADE;
DROP TABLE IF EXISTS "onboarding_stage_steps" CASCADE;
DROP TABLE IF EXISTS "onboarding_steps" CASCADE;
DROP TABLE IF EXISTS "onboarding_stage_assignments" CASCADE;
DROP TABLE IF EXISTS "onboarding_stages" CASCADE;
DROP TABLE IF EXISTS "user_favorites" CASCADE;
DROP TABLE IF EXISTS "content_assignments" CASCADE;

-- Sales / Marketing / Pricing
DROP TABLE IF EXISTS "getting_started_packages" CASCADE;
DROP TABLE IF EXISTS "promo_codes" CASCADE;
DROP TABLE IF EXISTS "product_features" CASCADE;
DROP TABLE IF EXISTS "products" CASCADE;
DROP TABLE IF EXISTS "pricing_plans" CASCADE;
DROP TABLE IF EXISTS "message_templates" CASCADE;
DROP TABLE IF EXISTS "specials" CASCADE;
DROP TABLE IF EXISTS "coupons" CASCADE;
DROP TABLE IF EXISTS "campaigns" CASCADE;
DROP TABLE IF EXISTS "deals" CASCADE;
DROP TABLE IF EXISTS "deal_funnel_stages" CASCADE;

-- CRM contacts
DROP TABLE IF EXISTS "crm_entity_tasks" CASCADE;
DROP TABLE IF EXISTS "crm_entity_notes" CASCADE;
DROP TABLE IF EXISTS "crm_contact_location_assignments" CASCADE;
DROP TABLE IF EXISTS "crm_contact_account_assignments" CASCADE;
DROP TABLE IF EXISTS "crm_contact_parent_org_assignments" CASCADE;
DROP TABLE IF EXISTS "crm_contact_agency_assignments" CASCADE;
DROP TABLE IF EXISTS "crm_contact_role_types" CASCADE;
DROP TABLE IF EXISTS "crm_contacts" CASCADE;

-- CRM users
DROP TABLE IF EXISTS "crm_users" CASCADE;

-- CRM accounts hierarchy
DROP TABLE IF EXISTS "crm_agency_pricing_packages" CASCADE;
DROP TABLE IF EXISTS "crm_user_types" CASCADE;
DROP TABLE IF EXISTS "crm_locations" CASCADE;
DROP TABLE IF EXISTS "crm_accounts" CASCADE;
DROP TABLE IF EXISTS "crm_parent_organizations" CASCADE;
DROP TABLE IF EXISTS "crm_branding_themes" CASCADE;
DROP TABLE IF EXISTS "crm_corporate_branding" CASCADE;
DROP TABLE IF EXISTS "crm_agencies" CASCADE;

-- Rescue Rover
DROP TABLE IF EXISTS "rescue_rover_rcs_links" CASCADE;
DROP TABLE IF EXISTS "rescue_rover_context_rules" CASCADE;
DROP TABLE IF EXISTS "rescue_rover_voice_scripts" CASCADE;
DROP TABLE IF EXISTS "rescue_rover_prompt_templates" CASCADE;
DROP TABLE IF EXISTS "rescue_rover_safety_rules" CASCADE;
DROP TABLE IF EXISTS "rescue_rover_call_logs" CASCADE;
DROP TABLE IF EXISTS "rescue_rover_settings" CASCADE;

-- Drop Rescue Rover enums (if they survived the CASCADE)
DROP TYPE IF EXISTS "call_outcome" CASCADE;
DROP TYPE IF EXISTS "call_sentiment" CASCADE;

-- Mongo collections to drop in the new project's data migration:
--   rescue_rover_calls
--   rescue_rover_transcripts
--   rescue_rover_events
