# TrackSense deployment checklist

- [ ] Create Render Blueprint from `render.yaml`.
- [ ] Confirm `tracksense-db` is available and the web service `/health` returns `ok: true`.
- [ ] Save the generated device API key privately. The dashboard does not use browser-password authentication; restrict public access with an identity-aware proxy or network controls if needed.
- [ ] Copy the deployed HTTPS URL and device API key into TrackSense menuconfig, then build/flash using ESP-IDF v6.1.
- [ ] Check serial logs for `Cloud telemetry accepted (HTTP 200)`.
- [ ] Confirm scans occur at startup, when motion is detected, and every 10 seconds while stationary.
- [ ] Temporarily make the uplink unavailable: confirm scans continue and the serial monitor reports buffered payloads; reconnect and confirm the queue drains.
- [ ] Confirm Wi-Fi modem power save is enabled and measure actual battery runtime with the intended scan interval.
- [ ] Open the dashboard and confirm new observations appear in scan history.
- [ ] Add room dimensions in meters, place signal access points, and capture at least 5-10 labelled fingerprints across known room coordinates.
- [ ] Confirm `dashboard/data/scans.csv` is populated in local mode and Download CSV contains the full history.
- [ ] Use Print / Save as PDF to create a report from the dashboard.
- [ ] Validate location accuracy at known held-out positions before making accuracy claims.
- [ ] Confirm sensor WHO_AM_I is `0x33`; otherwise stop and check wiring/part identity.
- [ ] Battery voltage and percentage are not measured; no battery measurement circuit is used.
- [ ] Configure database backup/retention and rotate API keys before sharing publicly.
