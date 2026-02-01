-- =====================================================
-- PostgreSQL Schema for Full MongoDB Migration
-- Phase 1: Create all remaining tables
-- =====================================================

-- =====================================================
-- GROUP A: Platform & Admin Configuration
-- =====================================================

CREATE TABLE IF NOT EXISTS platform_features (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(100) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(50),
  tier VARCHAR(50),
  is_active BOOLEAN DEFAULT true,
  display_order INTEGER DEFAULT 0,
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(100) NOT NULL UNIQUE,
  value JSONB NOT NULL,
  description TEXT,
  updated_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  stripe_price_id VARCHAR(255),
  monthly_price DECIMAL(10,2),
  annual_price DECIMAL(10,2),
  vin_limit INTEGER,
  features JSONB DEFAULT '[]',
  is_active BOOLEAN DEFAULT true,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- GROUP B: Enterprise & Billing
-- =====================================================

CREATE TABLE IF NOT EXISTS enterprise_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  shop_ids INTEGER[] DEFAULT '{}',
  shared_mappings JSONB DEFAULT '{}',
  shared_integrations JSONB DEFAULT '{}',
  billing_settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS billing_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  enterprise_id UUID REFERENCES enterprise_accounts(id),
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  plan_id UUID REFERENCES platform_plans(id),
  status VARCHAR(50) DEFAULT 'active',
  trial_ends_at TIMESTAMPTZ,
  grace_period_ends_at TIMESTAMPTZ,
  vin_quota INTEGER DEFAULT 0,
  vins_used INTEGER DEFAULT 0,
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS billing_status_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  enterprise_id UUID REFERENCES enterprise_accounts(id),
  event_type VARCHAR(100) NOT NULL,
  old_status VARCHAR(50),
  new_status VARCHAR(50),
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id VARCHAR(255) UNIQUE NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  processed BOOLEAN DEFAULT false,
  processed_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- GROUP C: Support & Audit
-- =====================================================

CREATE TABLE IF NOT EXISTS support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  user_id UUID REFERENCES users(id),
  subject VARCHAR(500) NOT NULL,
  description TEXT,
  status VARCHAR(50) DEFAULT 'open',
  priority VARCHAR(20) DEFAULT 'normal',
  category VARCHAR(100),
  assigned_to UUID REFERENCES users(id),
  resolution TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  user_id UUID REFERENCES users(id),
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(100),
  resource_id VARCHAR(255),
  details JSONB DEFAULT '{}',
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_shop_created ON audit_logs(shop_id, created_at DESC);

-- =====================================================
-- GROUP D: Tekmetric Integration Data
-- =====================================================

CREATE TABLE IF NOT EXISTS tekmetric_work_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  external_shop_id INTEGER NOT NULL,
  work_order_id VARCHAR(100) NOT NULL,
  work_order_number VARCHAR(100),
  vin VARCHAR(17),
  status VARCHAR(100),
  status_code VARCHAR(50),
  label VARCHAR(100),
  label_color VARCHAR(50),
  customer_id INTEGER,
  vehicle_id INTEGER,
  customer_name VARCHAR(255),
  vehicle_year INTEGER,
  vehicle_make VARCHAR(100),
  vehicle_model VARCHAR(100),
  vehicle_submodel VARCHAR(100),
  mileage_in INTEGER,
  mileage_out INTEGER,
  created_date TIMESTAMPTZ,
  closed_date TIMESTAMPTZ,
  raw_data JSONB DEFAULT '{}',
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(external_shop_id, work_order_id)
);
CREATE INDEX IF NOT EXISTS idx_tek_wo_vin ON tekmetric_work_orders(vin);
CREATE INDEX IF NOT EXISTS idx_tek_wo_shop ON tekmetric_work_orders(shop_id);

CREATE TABLE IF NOT EXISTS tekmetric_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  external_shop_id INTEGER UNIQUE NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_type VARCHAR(50),
  expires_at TIMESTAMPTZ,
  scopes TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tekmetric_backfill_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  external_shop_id INTEGER NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  total_records INTEGER DEFAULT 0,
  processed_records INTEGER DEFAULT 0,
  last_page INTEGER DEFAULT 0,
  last_cursor VARCHAR(255),
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(external_shop_id, entity_type)
);

-- =====================================================
-- GROUP E: Protractor Integration Data
-- =====================================================

CREATE TABLE IF NOT EXISTS protractor_work_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  external_shop_id INTEGER NOT NULL,
  work_order_id VARCHAR(100) NOT NULL,
  work_order_number VARCHAR(100),
  vin VARCHAR(17),
  status VARCHAR(100),
  customer_id VARCHAR(100),
  vehicle_id VARCHAR(100),
  customer_name VARCHAR(255),
  vehicle_year INTEGER,
  vehicle_make VARCHAR(100),
  vehicle_model VARCHAR(100),
  mileage INTEGER,
  created_date TIMESTAMPTZ,
  closed_date TIMESTAMPTZ,
  raw_data JSONB DEFAULT '{}',
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(external_shop_id, work_order_id)
);
CREATE INDEX IF NOT EXISTS idx_prot_wo_vin ON protractor_work_orders(vin);

CREATE TABLE IF NOT EXISTS protractor_vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  external_shop_id INTEGER NOT NULL,
  vehicle_id VARCHAR(100) NOT NULL,
  vin VARCHAR(17),
  year INTEGER,
  make VARCHAR(100),
  model VARCHAR(100),
  license_plate VARCHAR(20),
  customer_id VARCHAR(100),
  raw_data JSONB DEFAULT '{}',
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(external_shop_id, vehicle_id)
);

CREATE TABLE IF NOT EXISTS protractor_canned_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  external_shop_id INTEGER NOT NULL,
  job_code VARCHAR(100) NOT NULL,
  job_name VARCHAR(255),
  description TEXT,
  labor_rate DECIMAL(10,2),
  labor_hours DECIMAL(10,2),
  parts JSONB DEFAULT '[]',
  category VARCHAR(100),
  raw_data JSONB DEFAULT '{}',
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(external_shop_id, job_code)
);

CREATE TABLE IF NOT EXISTS protractor_deferred_work (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  external_shop_id INTEGER NOT NULL,
  work_order_id VARCHAR(100),
  vin VARCHAR(17),
  deferred_items JSONB DEFAULT '[]',
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

-- =====================================================
-- GROUP F: AutoVitals Integration
-- =====================================================

CREATE TABLE IF NOT EXISTS autovitals_vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  external_id VARCHAR(100) NOT NULL,
  vin VARCHAR(17),
  year INTEGER,
  make VARCHAR(100),
  model VARCHAR(100),
  license_plate VARCHAR(20),
  raw_data JSONB DEFAULT '{}',
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS autovitals_inspections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  vehicle_id UUID REFERENCES autovitals_vehicles(id),
  external_id VARCHAR(100) NOT NULL,
  vin VARCHAR(17),
  inspection_type VARCHAR(100),
  status VARCHAR(50),
  findings JSONB DEFAULT '[]',
  recommendations JSONB DEFAULT '[]',
  images JSONB DEFAULT '[]',
  inspector_name VARCHAR(255),
  inspected_at TIMESTAMPTZ,
  raw_data JSONB DEFAULT '{}',
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- GROUP G: Queues & Processing
-- =====================================================

CREATE TABLE IF NOT EXISTS enrichment_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  vin VARCHAR(17) NOT NULL,
  priority INTEGER DEFAULT 0,
  status VARCHAR(50) DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_enrichment_queue_status ON enrichment_queue(status, priority DESC);

CREATE TABLE IF NOT EXISTS ingestion_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  source VARCHAR(100) NOT NULL,
  entity_type VARCHAR(100),
  entity_id VARCHAR(255),
  error_type VARCHAR(100),
  error_message TEXT,
  stack_trace TEXT,
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_name VARCHAR(100) NOT NULL,
  shop_id UUID REFERENCES shops(id),
  status VARCHAR(50) DEFAULT 'running',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  records_processed INTEGER DEFAULT 0,
  errors INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}'
);

-- =====================================================
-- GROUP H: Caches (Simple key-value style)
-- =====================================================

CREATE TABLE IF NOT EXISTS cached_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key VARCHAR(500) UNIQUE NOT NULL,
  shop_id UUID REFERENCES shops(id),
  vin VARCHAR(17),
  mileage INTEGER,
  plan_data JSONB NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cached_plans_key ON cached_plans(cache_key);
CREATE INDEX IF NOT EXISTS idx_cached_plans_expires ON cached_plans(expires_at);

CREATE TABLE IF NOT EXISTS plan_prefetch_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key VARCHAR(500) UNIQUE NOT NULL,
  shop_id UUID REFERENCES shops(id),
  vin VARCHAR(17),
  data JSONB NOT NULL,
  priority INTEGER DEFAULT 0,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recommendations_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key VARCHAR(500) UNIQUE NOT NULL,
  vin VARCHAR(17),
  recommendations JSONB NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS maintenance_analysis_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key VARCHAR(500) UNIQUE NOT NULL,
  vin VARCHAR(17),
  analysis JSONB NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_analysis_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key VARCHAR(500) UNIQUE NOT NULL,
  input_hash VARCHAR(64),
  analysis JSONB NOT NULL,
  model VARCHAR(100),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- GROUP I: Stickers & Media
-- =====================================================

CREATE TABLE IF NOT EXISTS sticker_generations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  vin VARCHAR(17),
  vehicle_id UUID REFERENCES vehicles(id),
  sticker_type VARCHAR(50) DEFAULT 'oil',
  qr_code_url TEXT,
  image_url TEXT,
  settings JSONB DEFAULT '{}',
  printed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sticker_qr_scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sticker_id UUID REFERENCES sticker_generations(id),
  shop_id UUID REFERENCES shops(id),
  vin VARCHAR(17),
  scan_source VARCHAR(100),
  user_agent TEXT,
  ip_address VARCHAR(45),
  geo_data JSONB DEFAULT '{}',
  scanned_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shop_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  media_type VARCHAR(50) NOT NULL,
  filename VARCHAR(255),
  url TEXT,
  storage_key VARCHAR(500),
  mime_type VARCHAR(100),
  size_bytes INTEGER,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- GROUP J: Analytics & Events
-- =====================================================

CREATE TABLE IF NOT EXISTS recommendation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  enterprise_id UUID REFERENCES enterprise_accounts(id),
  vin VARCHAR(17),
  vehicle_id UUID,
  work_order_id VARCHAR(100),
  work_order_number VARCHAR(100),
  provider VARCHAR(50),
  event_type VARCHAR(100) NOT NULL,
  recommendation_type VARCHAR(50),
  service_code VARCHAR(100),
  service_name VARCHAR(255),
  line_item_id VARCHAR(100),
  price DECIMAL(10,2),
  labor_price DECIMAL(10,2),
  parts_price DECIMAL(10,2),
  total_price DECIMAL(10,2),
  added_by VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rec_events_shop ON recommendation_events(shop_id, created_at DESC);

CREATE TABLE IF NOT EXISTS extension_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  user_id UUID REFERENCES users(id),
  event_type VARCHAR(100) NOT NULL,
  event_data JSONB DEFAULT '{}',
  extension_version VARCHAR(20),
  browser VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sync_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  provider VARCHAR(50) NOT NULL,
  sync_type VARCHAR(50),
  records_synced INTEGER DEFAULT 0,
  duration_ms INTEGER,
  errors INTEGER DEFAULT 0,
  error_details JSONB DEFAULT '[]',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- GROUP K: External API & CARFAX
-- =====================================================

CREATE TABLE IF NOT EXISTS carfax_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  vin VARCHAR(17) NOT NULL,
  report_type VARCHAR(50),
  report_data JSONB NOT NULL,
  quickvin_data JSONB,
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_carfax_vin ON carfax_reports(vin);

CREATE TABLE IF NOT EXISTS carfax_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  vin VARCHAR(17) NOT NULL,
  service_history JSONB DEFAULT '[]',
  accident_history JSONB DEFAULT '[]',
  owner_history JSONB DEFAULT '[]',
  fetched_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS external_api_appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  external_id VARCHAR(100),
  customer_id UUID REFERENCES customers(id),
  vehicle_id UUID REFERENCES vehicles(id),
  appointment_type VARCHAR(100),
  scheduled_at TIMESTAMPTZ,
  status VARCHAR(50) DEFAULT 'scheduled',
  notes TEXT,
  source VARCHAR(50),
  raw_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- GROUP L: Miscellaneous
-- =====================================================

CREATE TABLE IF NOT EXISTS counters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) UNIQUE NOT NULL,
  value BIGINT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pending_signups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL,
  token VARCHAR(255) UNIQUE NOT NULL,
  shop_name VARCHAR(255),
  signup_data JSONB DEFAULT '{}',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ratelimits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(500) UNIQUE NOT NULL,
  count INTEGER DEFAULT 0,
  window_start TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS api_usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  endpoint VARCHAR(255) NOT NULL,
  method VARCHAR(10),
  status_code INTEGER,
  response_time_ms INTEGER,
  request_size INTEGER,
  response_size INTEGER,
  user_id UUID REFERENCES users(id),
  ip_address VARCHAR(45),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_usage_shop ON api_usage_logs(shop_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dashboard_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  update_type VARCHAR(100) NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS data_quality_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id),
  report_type VARCHAR(100) NOT NULL,
  issues JSONB DEFAULT '[]',
  summary JSONB DEFAULT '{}',
  generated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS part_cross_ref (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_part_number VARCHAR(100) NOT NULL,
  cross_ref_part_number VARCHAR(100) NOT NULL,
  manufacturer VARCHAR(100),
  part_type VARCHAR(100),
  notes TEXT,
  verified BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_part_cross_ref ON part_cross_ref(original_part_number);

-- =====================================================
-- Create indexes for foreign keys if not exists
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_billing_settings_shop ON billing_settings(shop_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_shop ON support_tickets(shop_id);
CREATE INDEX IF NOT EXISTS idx_tek_wo_external_shop ON tekmetric_work_orders(external_shop_id);
CREATE INDEX IF NOT EXISTS idx_prot_wo_external_shop ON protractor_work_orders(external_shop_id);
