# TrackSense

TrackSense combines an ESP32-C6, a LIS3DH motion sensor, and a Docker-hosted dashboard to collect Wi-Fi access-point RSSI scans and estimate indoor location from fingerprints.

## Features

- Starts Wi-Fi scans at boot, when motion is detected, and at least every 10 seconds.
- Continues scanning while disconnected from the telemetry network; buffers up to three scans in RAM for retry.
- Sends versioned telemetry over local UDP or HTTPS to a Node.js dashboard.
- Stores scan metadata and observations in PostgreSQL; also writes CSV and JSONL archives.
- Provides room maps, AP configuration, fingerprint calibration, scan filtering, CSV export, and print-to-PDF reporting.
- Supports battery-powered operation, but does not measure battery voltage or charge.

Location and RSSI-derived distance are estimates. Calibrate fingerprints in the installation environment and verify sensor, battery runtime, and accuracy on the actual hardware.

## Requirements

- Docker Desktop with Docker Compose.
- ESP-IDF v6.1 and an ESP32-C6 development board.
- A LIS3DH breakout wired for I²C if motion-triggered scans are required.

## Start the dashboard

From the project root, copy `.env.example` to `.env`. Set strong, private values for `POSTGRES_PASSWORD` and `DEVICE_API_KEY`; do not commit `.env`.

```powershell
Copy-Item .env.example .env
```

Build and start the dashboard and database:

```powershell
docker compose up --build -d
docker compose ps
docker compose logs -f dashboard
```

Open `http://localhost:3000` (or the host port set by `PORT` in `.env`). **The dashboard does not require a browser password.** The telemetry API still requires `DEVICE_API_KEY`. Keep the dashboard on a trusted local network; configure a TLS reverse proxy and network access controls before exposing it outside that network.

PostgreSQL is persisted in a named Docker volume. CSV and JSONL scan archives are stored in `DATA_DIR` (by default, `dashboard/data`). `docker compose down` stops services without deleting the database. Do not use `docker compose down -v` unless you intend to remove the database volume.

If ports 3000 or 5005 are already used, choose available host ports in `.env`, for example:

```dotenv
PORT=3001
UDP_PORT=5006
DATA_DIR=./dashboard/docker-data
```

The dashboard container listens on internal UDP port 5005 and Docker maps the host's `UDP_PORT` to it. Set the firmware UDP port to the host value. Keep `DATA_DIR` separate if another local dashboard is already writing scan files.

### Change the PostgreSQL password

Changing `POSTGRES_PASSWORD` in `.env` alone does **not** change the password for a database that has already been initialized. Update the PostgreSQL role and the dashboard connection string together:

1. Stop the dashboard so it does not make new database connections:

   ```powershell
   docker compose stop dashboard
   ```

2. Open PostgreSQL's interactive prompt:

   ```powershell
   docker compose exec database psql -U tracksense -d tracksense
   ```

3. At the `psql` prompt, run:

   ```text
   \password tracksense
   ```

   Enter the new strong, alphanumeric password twice. Then exit `psql` with `\q`.

4. Put the same new password in `.env` on the `POSTGRES_PASSWORD=` line. Save the file, then recreate the dashboard container:

   ```powershell
   docker compose up -d --force-recreate dashboard
   docker compose ps
   ```

   Check that both services are healthy. Keep the new password private. Do not delete the PostgreSQL volume during this change.

## Configure and flash the ESP32-C6

1. Find the computer's LAN IPv4 address using `ipconfig`. Use the address on the same network as the ESP32, not `localhost`.
2. From an ESP-IDF PowerShell in the project root, open menuconfig:

   ```powershell
   idf.py reconfigure
   idf.py menuconfig
   ```

3. Under **TrackSense configuration**, set:
   - **Telemetry Wi-Fi SSID** and **Telemetry Wi-Fi password**: network the ESP32 uses to reach the dashboard.
   - **Local UDP receiver IPv4 address**: computer's LAN IPv4 address.
   - **Local UDP receiver port**: the `UDP_PORT` value from `.env`.
   - **HTTPS telemetry API URL** and **Device API key**: leave empty for local UDP.
   - **Device identifier**: keep `tracksense-001`, or select a unique ID.
4. Keep **NVS Encryption** and **Enable flash encryption on boot** disabled for this prototype. Flash encryption can permanently change device flash and complicate reflashing if not provisioned intentionally.
5. Save menuconfig and build/flash (replace `COMx` with the board's serial port):

   ```powershell
   idf.py build
   idf.py -p COMx flash
   idf.py -p COMx monitor
   ```

6. Allow the configured UDP port through Windows Firewall on the private LAN if prompted. Check the dashboard's latest scan and `docker compose logs -f dashboard`.

Cloud uploads use HTTPS and require the endpoint URL and device key. The server's public web service is not a UDP listener; use UDP only on the local network.

## Rooms and fingerprint setup

1. In **Rooms & Map**, add rooms and their dimensions in meters.
2. In **Wi-Fi Signals**, select an AP from recent scans or enter its BSSID; label it and assign a room. Coordinates are optional.
3. Stand the device at a known point, choose the room and X/Y position in meters, and capture a fingerprint. Repeat at multiple points in each room.
4. View the estimated location and confidence in the dashboard. RSSI distance and fingerprint-based location are approximate, not guaranteed measurements.
5. Use **History & Reports** to filter scans by date/time, download CSV, or print/save a PDF. Each AP observation is also appended to `scans.csv` and `scans.jsonl`.

## Sensor and battery notes

- The firmware only treats the accelerometer as a LIS3DH if its `WHO_AM_I` value is `0x33`. For the typical XIAO ESP32-C6 I²C wiring, check SDA D4/GPIO22, SCL D5/GPIO23, CS high, and SA0 address selection. Verify the exact board and breakout pinout.
- The device can be powered from a correctly connected battery. This project has no battery measurement circuit; battery voltage and charge are not reported.
- The current offline queue holds up to three scans in RAM and is lost on reboot or power loss.

## Security and data

- `.env`, `sdkconfig`, build outputs, local scan archives, and Docker scan data are excluded from Git. Keep credentials and firmware images private.
- The browser dashboard has no login by design. Do not expose it publicly without adding suitable access controls and TLS.
- `POST /api/telemetry/raw` requires the `X-Device-Key` header and accepts version-1 JSON telemetry. Do not share the device API key.
- A new PostgreSQL database is initialized automatically. Existing local room, signal, and fingerprint configuration is seeded when its database rows are missing. Historical local CSV/JSONL scans are preserved but are not imported automatically.
- Back up both the PostgreSQL volume and scan archive directory.

## Useful commands

```powershell
docker compose ps
docker compose logs -f dashboard
docker compose restart dashboard
docker compose down
```

## Project layout

- `main/ak_wifi_rssi_main.c` — ESP-IDF scanner, motion sensor, and telemetry.
- `main/Kconfig.projbuild` — ESP-IDF Wi-Fi and telemetry settings.
- `dashboard/server.js` — dashboard/API server, UDP receiver, and PostgreSQL persistence.
- `dashboard/public/` — dashboard interface.
- `dashboard/schema.sql` — PostgreSQL schema reference.
- `docker-compose.yml` — dashboard and PostgreSQL services.
- `.env.example` — safe configuration template.
