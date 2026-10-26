-- TrackSense PostgreSQL schema. The server also creates these tables at startup.
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'TrackSense device',
  last_seen TIMESTAMPTZ,
  last_ip TEXT,
  motion BOOLEAN NOT NULL DEFAULT FALSE,
  sensor_ok BOOLEAN NOT NULL DEFAULT FALSE,
  wifi_connected BOOLEAN NOT NULL DEFAULT FALSE,
  battery_voltage REAL,
  battery_percent REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS scan_observations (
  id BIGSERIAL PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(device_id),
  observed_at TIMESTAMPTZ NOT NULL,
  bssid TEXT NOT NULL,
  ssid TEXT,
  rssi_dbm INTEGER NOT NULL,
  channel INTEGER,
  motion BOOLEAN NOT NULL DEFAULT FALSE,
  sensor_ok BOOLEAN NOT NULL DEFAULT FALSE,
  wifi_connected BOOLEAN NOT NULL DEFAULT FALSE,
  battery_voltage REAL,
  battery_percent REAL,
  source_ip TEXT,
  room_name TEXT,
  signal_room_name TEXT,
  scan_id TEXT,
  sequence BIGINT,
  device_timestamp_ms BIGINT,
  firmware_version TEXT
);
CREATE INDEX IF NOT EXISTS scan_observations_time_idx ON scan_observations(observed_at DESC);
CREATE INDEX IF NOT EXISTS scan_observations_device_idx ON scan_observations(device_id, observed_at DESC);
CREATE TABLE IF NOT EXISTS telemetry_scans (
  device_id TEXT NOT NULL REFERENCES devices(device_id),
  scan_id TEXT NOT NULL,
  sequence BIGINT,
  device_timestamp_ms BIGINT,
  firmware_version TEXT,
  received_at TIMESTAMPTZ NOT NULL,
  motion_state TEXT NOT NULL DEFAULT 'unavailable',
  sensor_status TEXT NOT NULL DEFAULT 'unavailable',
  wifi_connected BOOLEAN NOT NULL DEFAULT FALSE,
  battery_voltage REAL,
  battery_percent REAL,
  source_ip TEXT,
  PRIMARY KEY (device_id, scan_id)
);
CREATE INDEX IF NOT EXISTS telemetry_scans_received_idx ON telemetry_scans(received_at DESC);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  width_m DOUBLE PRECISION NOT NULL,
  height_m DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS fingerprints (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  x DOUBLE PRECISION,
  y DOUBLE PRECISION,
  rssi JSONB NOT NULL,
  room_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS signal_config (
  bssid TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  x DOUBLE PRECISION,
  y DOUBLE PRECISION,
  tx_power REAL NOT NULL DEFAULT -59,
  path_loss REAL NOT NULL DEFAULT 2.2,
  room_id TEXT
);
