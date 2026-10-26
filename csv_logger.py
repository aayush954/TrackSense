import socket
import csv
import os
from datetime import datetime

UDP_PORT = 5005
CSV_FILE = "wifi_rssi_log.csv"
MISSING_RSSI = -999

known_aps = []      # list of MACs, in column order
ap_info = {}        # mac -> (ssid, channel)

if os.path.exists(CSV_FILE):
    with open(CSV_FILE, "r") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        if header:
            for h in header[1:]:
                mac = h.split(" ")[0]
                known_aps.append(mac)
                # try to recover ssid/ch from existing header text
                if "(" in h and ")" in h:
                    inner = h.split("(", 1)[1].rsplit(")", 1)[0]
                    if ", Ch" in inner:
                        ssid_part, ch_part = inner.rsplit(", Ch", 1)
                        ap_info[mac] = (ssid_part, ch_part)

def make_header(mac):
    ssid, ch = ap_info.get(mac, ("", ""))
    return f"{mac} ({ssid}, Ch{ch})"

def rewrite_csv():
    """Rewrite the CSV with current headers (used when new AP added or info changed)."""
    file_exists = os.path.exists(CSV_FILE)
    old_rows = []
    if file_exists:
        with open(CSV_FILE, "r") as f:
            reader = csv.reader(f)
            next(reader, None)
            old_rows = list(reader)

    with open(CSV_FILE, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["timestamp"] + [make_header(m) for m in known_aps])
        for row in old_rows:
            padded = row + [str(MISSING_RSSI)] * (len(known_aps) - (len(row) - 1))
            writer.writerow(padded[:len(known_aps) + 1])

s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("0.0.0.0", UDP_PORT))
print(f"Listening on UDP {UDP_PORT}... writing to {CSV_FILE}")

while True:
    data, addr = s.recvfrom(3072)
    msg = data.decode(errors="ignore").strip()
    if not msg:
        continue

    scan = {}
    info_changed = False

    for entry in msg.split(";"):
        entry = entry.strip()
        if not entry:
            continue
        parts = entry.split("|")
        if len(parts) != 4:
            continue
        mac, ssid, rssi, ch = parts
        try:
            scan[mac] = int(rssi)
        except ValueError:
            continue

        prev = ap_info.get(mac)
        if prev != (ssid, ch):
            ap_info[mac] = (ssid, ch)
            if mac in known_aps:  # existing AP with changed info
                info_changed = True

    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    new_aps = [mac for mac in scan if mac not in known_aps]
    if new_aps:
        known_aps.extend(new_aps)

    if new_aps or info_changed:
        rewrite_csv()

    row = [timestamp]
    for mac in known_aps:
        row.append(str(scan.get(mac, MISSING_RSSI)))

    with open(CSV_FILE, "a", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(row)

    note = []
    if new_aps:
        note.append(f"{len(new_aps)} new")
    if info_changed:
        note.append("header updated")
    note_str = f" ({', '.join(note)})" if note else ""
    print(f"{timestamp}: logged {len(scan)} APs{note_str}")
