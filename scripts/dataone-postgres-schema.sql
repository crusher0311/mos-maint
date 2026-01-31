-- DataOne PostgreSQL Schema
-- Converted from MySQL DDL provided by DataOne
-- Tables prefixed with 'dataone_' to avoid conflicts
-- Note: Most text columns allow NULL since DataOne CSVs have empty values

-- VIN Reference - Main VIN decoding table
CREATE TABLE IF NOT EXISTS dataone_vin_reference (
  vin_id SERIAL PRIMARY KEY,
  vehicle_id INTEGER DEFAULT 0,
  vin_pattern VARCHAR(10),
  year SMALLINT DEFAULT 0,
  make VARCHAR(24),
  model VARCHAR(32),
  trim VARCHAR(48),
  style VARCHAR(128),
  mfr_model_num VARCHAR(12),
  mfr_package_code VARCHAR(12),
  doors SMALLINT DEFAULT 0,
  drive_type VARCHAR(3),
  vehicle_type VARCHAR(24),
  rear_axle VARCHAR(6),
  body_type VARCHAR(32),
  body_subtype VARCHAR(32),
  bed_length VARCHAR(8),
  engine_id INTEGER DEFAULT 0,
  engine_name VARCHAR(128),
  engine_size REAL DEFAULT 0,
  engine_block CHAR(1),
  engine_cylinders SMALLINT DEFAULT 0,
  engine_valves SMALLINT DEFAULT 0,
  engine_induction VARCHAR(32),
  engine_aspiration VARCHAR(32),
  engine_cam_type VARCHAR(8),
  fuel_type VARCHAR(12),
  trans_id INTEGER DEFAULT 0,
  trans_name VARCHAR(64),
  trans_type VARCHAR(3),
  trans_speeds SMALLINT DEFAULT 0,
  wheelbase REAL DEFAULT 0,
  gross_vehicle_weight_range VARCHAR(20),
  restraint_type VARCHAR(255),
  brake_system VARCHAR(18),
  country_of_mfr VARCHAR(24),
  plant VARCHAR(32)
);

CREATE INDEX IF NOT EXISTS idx_vin_reference_vin_pattern ON dataone_vin_reference(vin_pattern);
CREATE INDEX IF NOT EXISTS idx_vin_reference_vehicle_id ON dataone_vin_reference(vehicle_id);

-- Vehicle Trim Styles
CREATE TABLE IF NOT EXISTS dataone_veh_trim_styles (
  vehicle_id SERIAL PRIMARY KEY,
  style_complete VARCHAR(1) NOT NULL DEFAULT 'N',
  fleet VARCHAR(2) NOT NULL DEFAULT 'N',
  year SMALLINT NOT NULL DEFAULT 0,
  make VARCHAR(24) NOT NULL DEFAULT '',
  model VARCHAR(32) NOT NULL DEFAULT '',
  trim VARCHAR(48) NOT NULL DEFAULT '',
  drive_type VARCHAR(10) NOT NULL DEFAULT '',
  style VARCHAR(128) NOT NULL DEFAULT '',
  vehicle_type VARCHAR(24) NOT NULL DEFAULT '',
  body_type VARCHAR(32) NOT NULL DEFAULT '',
  body_subtype VARCHAR(32) NOT NULL DEFAULT '',
  oem_body_style VARCHAR(64) NOT NULL DEFAULT '',
  doors SMALLINT NOT NULL DEFAULT 0,
  oem_doors SMALLINT NOT NULL DEFAULT 0,
  mfr_model_num VARCHAR(32) NOT NULL DEFAULT '',
  mfr_package_code VARCHAR(12) NOT NULL DEFAULT ''
);

-- Maintenance Definitions
CREATE TABLE IF NOT EXISTS dataone_def_maintenance (
  maintenance_id SERIAL PRIMARY KEY,
  maintenance_category VARCHAR(128) NOT NULL DEFAULT '',
  maintenance_name TEXT NOT NULL DEFAULT '',
  maintenance_notes TEXT NOT NULL DEFAULT ''
);

-- Maintenance Schedule (OEM naming)
CREATE TABLE IF NOT EXISTS dataone_def_maintenance_schedule (
  maintenance_schedule_id SERIAL PRIMARY KEY,
  schedule_name VARCHAR(255) NOT NULL DEFAULT '',
  schedule_description TEXT NOT NULL DEFAULT ''
);

-- Maintenance Intervals
CREATE TABLE IF NOT EXISTS dataone_def_maintenance_interval (
  maintenance_interval_id SERIAL PRIMARY KEY,
  interval_type VARCHAR(32) NOT NULL DEFAULT '',
  value REAL NOT NULL DEFAULT 0,
  units VARCHAR(32) NOT NULL DEFAULT '',
  initial_value REAL NOT NULL DEFAULT 0
);

-- Operating Parameters (dusty conditions, towing, etc.)
CREATE TABLE IF NOT EXISTS dataone_def_maintenance_operating_parameter (
  maintenance_operating_parameter_id SERIAL PRIMARY KEY,
  operating_parameter TEXT NOT NULL DEFAULT '',
  operating_parameter_notes TEXT NOT NULL DEFAULT ''
);

-- Computer Codes (dashboard indicators)
CREATE TABLE IF NOT EXISTS dataone_def_maintenance_computer_code (
  maintenance_computer_code_id SERIAL PRIMARY KEY,
  computer_code VARCHAR(32) NOT NULL DEFAULT ''
);

-- Maintenance Events
CREATE TABLE IF NOT EXISTS dataone_def_maintenance_event (
  maintenance_event_id SERIAL PRIMARY KEY,
  event VARCHAR(255) NOT NULL DEFAULT ''
);

-- VIN to Maintenance Lookup (~40M rows)
CREATE TABLE IF NOT EXISTS dataone_lkp_vin_maintenance (
  vin_maintenance_id SERIAL PRIMARY KEY,
  squish VARCHAR(16) NOT NULL DEFAULT '',
  trans_notes VARCHAR(255) NOT NULL DEFAULT '',
  trim_notes TEXT NOT NULL DEFAULT '',
  maintenance_schedule_id INTEGER NOT NULL DEFAULT 0,
  maintenance_id INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_lkp_vin_maintenance_squish ON dataone_lkp_vin_maintenance(squish);
CREATE INDEX IF NOT EXISTS idx_lkp_vin_maintenance_maintenance_id ON dataone_lkp_vin_maintenance(maintenance_id);

-- VIN Maintenance Intervals (~75M rows)
CREATE TABLE IF NOT EXISTS dataone_lkp_vin_maintenance_interval (
  vin_maintenance_interval_id SERIAL PRIMARY KEY,
  vin_maintenance_id INTEGER NOT NULL DEFAULT 0,
  maintenance_interval_id INTEGER NOT NULL DEFAULT 0,
  maintenance_operating_parameter_id INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_lkp_vin_maint_interval_vin_maint_id ON dataone_lkp_vin_maintenance_interval(vin_maintenance_id);

-- VIN Maintenance Event/Computer Code Lookup
CREATE TABLE IF NOT EXISTS dataone_lkp_vin_maintenance_event_computer_code (
  vin_maintenance_event_computer_code_id SERIAL PRIMARY KEY,
  maintenance_computer_code_id INTEGER NOT NULL DEFAULT 0,
  maintenance_event_id INTEGER NOT NULL DEFAULT 0,
  vin_maintenance_id INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_lkp_vin_maint_event_cc_vin_maint_id ON dataone_lkp_vin_maintenance_event_computer_code(vin_maintenance_id);

-- YMM (Year/Make/Model) Maintenance Lookup
CREATE TABLE IF NOT EXISTS dataone_lkp_ymm_maintenance (
  ymm_maintenance_id SERIAL PRIMARY KEY,
  year SMALLINT NOT NULL DEFAULT 0,
  make VARCHAR(24) NOT NULL DEFAULT '',
  model VARCHAR(32) NOT NULL DEFAULT '',
  eng_notes VARCHAR(128) NOT NULL DEFAULT '',
  trans_notes VARCHAR(255) NOT NULL DEFAULT '',
  trim_notes TEXT NOT NULL DEFAULT '',
  maintenance_schedule_id INTEGER NOT NULL DEFAULT 0,
  maintenance_id INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_lkp_ymm_maintenance_ymm ON dataone_lkp_ymm_maintenance(year, make, model);

-- YMM Maintenance Intervals
CREATE TABLE IF NOT EXISTS dataone_lkp_ymm_maintenance_interval (
  ymm_maintenance_interval_id SERIAL PRIMARY KEY,
  ymm_maintenance_id INTEGER NOT NULL DEFAULT 0,
  maintenance_interval_id INTEGER NOT NULL DEFAULT 0,
  maintenance_operating_parameter_id INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_lkp_ymm_maint_interval_ymm_maint_id ON dataone_lkp_ymm_maintenance_interval(ymm_maintenance_id);

-- YMM Maintenance Event/Computer Code Lookup
CREATE TABLE IF NOT EXISTS dataone_lkp_ymm_maintenance_event_computer_code (
  ymm_maintenance_event_computer_code_id SERIAL PRIMARY KEY,
  maintenance_computer_code_id INTEGER NOT NULL DEFAULT 0,
  maintenance_event_id INTEGER NOT NULL DEFAULT 0,
  ymm_maintenance_id INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_lkp_ymm_maint_event_cc_ymm_maint_id ON dataone_lkp_ymm_maintenance_event_computer_code(ymm_maintenance_id);

-- NHTSA Recall Definitions
CREATE TABLE IF NOT EXISTS dataone_def_nhtsa_recall (
  nhtsa_recall_id INTEGER PRIMARY KEY,
  nhtsa_campaign_number VARCHAR(16) NOT NULL DEFAULT '',
  mfr_campaign_number VARCHAR(32) NOT NULL DEFAULT '',
  component_description VARCHAR(256) NOT NULL DEFAULT '',
  report_manufacturer VARCHAR(64) NOT NULL DEFAULT '',
  manufacturing_start_date DATE,
  manufacturing_end_date DATE,
  recall_type_code VARCHAR(4) NOT NULL DEFAULT '',
  potential_units_affected INTEGER NOT NULL DEFAULT 0,
  owner_notification_date DATE,
  recall_initiator VARCHAR(4) NOT NULL DEFAULT '',
  product_manufacturer VARCHAR(64) NOT NULL DEFAULT '',
  report_received_date DATE,
  record_creation_date DATE,
  regulation_part_number VARCHAR(4) NOT NULL DEFAULT '',
  fmvvs_number VARCHAR(16) NOT NULL DEFAULT '',
  defect_summary TEXT NOT NULL DEFAULT '',
  consequence_summary TEXT NOT NULL DEFAULT '',
  corrective_action_summary TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  recalled_component_id VARCHAR(32) NOT NULL DEFAULT ''
);

-- Vehicle to NHTSA Recall Lookup
CREATE TABLE IF NOT EXISTS dataone_lkp_veh_nhtsa_recall (
  veh_nhtsa_recall_id SERIAL PRIMARY KEY,
  vehicle_id INTEGER NOT NULL DEFAULT 0,
  nhtsa_recall_id INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_lkp_veh_nhtsa_recall_vehicle_id ON dataone_lkp_veh_nhtsa_recall(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_lkp_veh_nhtsa_recall_nhtsa_recall_id ON dataone_lkp_veh_nhtsa_recall(nhtsa_recall_id);

-- Vehicle Model Number Lookup
CREATE TABLE IF NOT EXISTS dataone_lkp_veh_model_number (
  veh_mfr_model_num_id SERIAL PRIMARY KEY,
  vehicle_id INTEGER NOT NULL DEFAULT 0,
  mfr_model_num VARCHAR(32) NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_lkp_veh_model_number_vehicle_id ON dataone_lkp_veh_model_number(vehicle_id);

-- Vehicle Specifications
CREATE TABLE IF NOT EXISTS dataone_def_specification (
  specification_id INTEGER PRIMARY KEY,
  specification_category VARCHAR(32) NOT NULL DEFAULT '',
  specification_name VARCHAR(32) NOT NULL DEFAULT '',
  specification_value VARCHAR(32) NOT NULL DEFAULT '',
  is_ancillary VARCHAR(1) NOT NULL DEFAULT 'N'
);

-- Vehicle to Specification Lookup
CREATE TABLE IF NOT EXISTS dataone_lkp_veh_standard_specification (
  veh_specification_id SERIAL PRIMARY KEY,
  vehicle_id INTEGER NOT NULL DEFAULT 0,
  specification_id INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_lkp_veh_standard_spec_vehicle_id ON dataone_lkp_veh_standard_specification(vehicle_id);

-- Metadata table to track last sync
CREATE TABLE IF NOT EXISTS dataone_sync_metadata (
  id SERIAL PRIMARY KEY,
  last_sync_at TIMESTAMP WITH TIME ZONE,
  sync_status VARCHAR(32) NOT NULL DEFAULT 'pending',
  file_name VARCHAR(255),
  file_size_bytes BIGINT,
  rows_imported JSONB,
  duration_seconds INTEGER,
  error_message TEXT
);
