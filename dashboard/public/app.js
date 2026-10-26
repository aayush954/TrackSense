const $ = (id) => document.getElementById(id);
const pageTitles = {
  overview: 'Overview',
  location: 'Rooms & Fingerprint Map',
  signals: 'Wi-Fi Signals',
  history: 'History & Reports',
  device: 'Device & Power'
};

let latest = null;
let scanRows = [];
let toastTimer = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function formatClock(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString();
}

function hasNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function initializeTimeFilters() {
  ['filterFrom', 'filterTo'].forEach((prefix) => {
    const hourSelect = $(`${prefix}Hour`);
    const minuteSelect = $(`${prefix}Minute`);
    for (let hour = 1; hour <= 12; hour += 1) {
      const value = String(hour).padStart(2, '0');
      hourSelect.add(new Option(value, value));
    }
    for (let minute = 0; minute <= 59; minute += 1) {
      const value = String(minute).padStart(2, '0');
      minuteSelect.add(new Option(value, value));
    }
  });
}

function selectedFilterTime(prefix) {
  const hour = $(`${prefix}Hour`).value;
  const minute = $(`${prefix}Minute`).value;
  const period = $(`${prefix}Period`).value;
  const parts = [hour, minute, period];
  const selectedCount = parts.filter(Boolean).length;
  if (selectedCount === 0) return { value: null, partial: false };
  if (selectedCount !== parts.length) return { value: null, partial: true };
  const hour24 = (Number(hour) % 12) + (period === 'PM' ? 12 : 0);
  return { value: `${String(hour24).padStart(2, '0')}:${minute}`, partial: false };
}

function showToast(message, isError = false) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3500);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function go(page) {
  document.querySelectorAll('.page').forEach((section) => {
    section.classList.toggle('hidden', section.id !== `page-${page}`);
    section.classList.toggle('active', section.id === `page-${page}`);
  });
  document.querySelectorAll('.nav-link').forEach((button) => {
    button.classList.toggle('active', button.dataset.page === page);
  });
  $('pageTitle').textContent = pageTitles[page] || pageTitles.overview;
  if (page === 'history') loadScans();
}

document.querySelectorAll('.nav-link').forEach((button) => {
  button.addEventListener('click', () => go(button.dataset.page));
});
document.querySelectorAll('[data-open]').forEach((button) => {
  button.addEventListener('click', () => go(button.dataset.open));
});

function roomName(id) {
  return latest?.rooms?.find((room) => room.id === id)?.name || 'Unassigned';
}

function updateConnectionStatus(data) {
  const online = data.lastPacketAt && Date.now() - new Date(data.lastPacketAt).getTime() < 30000;
  const status = online ? 'Telemetry live' : data.lastPacketAt ? 'Telemetry stale' : 'Waiting for telemetry';
  ['sideDot', 'topDot'].forEach((id) => $(id).classList.toggle('online', Boolean(online)));
  $('sideStatus').textContent = status;
  $('topStatus').textContent = online ? 'Device online' : 'Device offline';
  $('sideDevice').textContent = `${data.deviceId || 'Tracker 01'} · ESP32-C6`;
}

function render(data) {
  latest = data || {};
  const aps = Array.isArray(latest.aps) ? latest.aps : [];
  const rooms = Array.isArray(latest.rooms) ? latest.rooms : [];
  updateConnectionStatus(latest);

  const estimate = latest.location || {};
  const locationRoom = rooms.find((room) => room.id === estimate.roomId);
  $('currentLocation').textContent = estimate.roomId
    ? `${locationRoom?.name || 'Room'} · ${estimate.label || 'Estimated position'}`
    : (estimate.label || 'Waiting for a calibrated fingerprint');
  $('locationConfidence').textContent = estimate.confidence
    ? `${String(estimate.confidence).toUpperCase()} CONFIDENCE`
    : 'NOT CALIBRATED';
  $('lastUpdate').textContent = latest.lastPacketAt
    ? `Last scan ${formatClock(latest.lastPacketAt)}${Number.isFinite(estimate.x) && Number.isFinite(estimate.y) ? ` · ${estimate.x.toFixed(1)}, ${estimate.y.toFixed(1)} m` : ''}${Number.isFinite(Number(estimate.matchedAPs)) ? ` · ${estimate.matchedAPs} AP matches` : ''}`
    : 'No telemetry received yet.';

  const telemetryLive = latest.lastPacketAt && Date.now() - new Date(latest.lastPacketAt).getTime() < 30000;
  $('wifiStatus').textContent = latest.wifiConnected ? 'Connected' : 'Offline';
  $('wifiDetail').textContent = telemetryLive
    ? (latest.deviceIp || 'Uplink active')
    : 'No recent upload';
  $('motionValue').textContent = latest.motionSensor ? (latest.motion ? 'Moving' : 'Stationary') : 'Unavailable';
  $('motionDetail').textContent = latest.motionSensor ? 'Sensor ready' : 'Check LIS3DH power / I²C';
  $('apCount').textContent = aps.length;
  $('scanAge').textContent = latest.lastPacketAt ? `Last scan ${formatClock(latest.lastPacketAt)}` : 'No scan data';
  $('batteryValue').textContent = 'Not monitored';
  $('batteryDetail').textContent = 'No battery measurement circuit';

  $('deviceId').textContent = latest.deviceId || '—';
  $('deviceWifi').textContent = latest.wifiConnected ? 'Connected' : 'Offline / scanning';
  $('deviceLastSeen').textContent = formatDateTime(latest.lastPacketAt);
  $('deviceIp').textContent = latest.deviceIp || '—';
  $('deviceSensor').textContent = latest.motionSensor ? 'LIS3DH verified' : 'LIS3DH not detected';
  $('storageMode').textContent = latest.storage === 'postgresql' ? 'PostgreSQL connected' : 'Local files';
  $('storageDetail').textContent = latest.storage === 'postgresql'
    ? 'Telemetry and dashboard configuration are saved in the server database.'
    : 'This server saves locally. Configure DATABASE_URL to store data in PostgreSQL.';

  renderRoomSelects(rooms);
  renderRooms(rooms, latest.signals || [], latest.fingerprints || [], estimate);
  renderSignals(aps);
  renderSavedConfiguration(latest.signals || [], latest.fingerprints || []);
  renderRecentRows(aps);
  $('latestScanLabel').textContent = latest.lastPacketAt
    ? `${aps.length} AP${aps.length === 1 ? '' : 's'} · ${formatClock(latest.lastPacketAt)}`
    : 'Waiting for the next scan';
}

function renderRoomSelects(rooms) {
  document.querySelectorAll('.room-select').forEach((select) => {
    const selected = select.value;
    const optional = select.closest('#signalForm') ? '<option value="">No room selected</option>' : '<option value="">Select a room</option>';
    select.innerHTML = optional + rooms.map((room) =>
      `<option value="${escapeHtml(room.id)}">${escapeHtml(room.name)} (${Number(room.widthM).toFixed(1)} × ${Number(room.heightM).toFixed(1)} m)</option>`
    ).join('');
    if (rooms.some((room) => room.id === selected)) select.value = selected;
  });
}

function makeMarker(kind, label, x, y, room) {
  const left = Math.min(98, Math.max(2, (Number(x) / Number(room.widthM)) * 100));
  const top = Math.min(98, Math.max(2, 100 - (Number(y) / Number(room.heightM)) * 100));
  return `<span class="map-marker ${kind}" style="left:${left}%;top:${top}%" title="${escapeHtml(label)}"><small>${escapeHtml(label)}</small></span>`;
}

function renderRooms(rooms, signals, fingerprints, estimate) {
  const output = rooms.length ? rooms.map((room) => {
    const roomSignals = signals.filter((signal) => signal.roomId === room.id && hasNumber(signal.x) && hasNumber(signal.y));
    const roomFingerprints = fingerprints.filter((point) => point.roomId === room.id && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)));
    let markers = roomSignals.map((signal) => makeMarker('ap-marker', signal.label, signal.x, signal.y, room)).join('');
    markers += roomFingerprints.map((point) => makeMarker('fingerprint', point.label, point.x, point.y, room)).join('');
    if (estimate.roomId === room.id && Number.isFinite(Number(estimate.x)) && Number.isFinite(Number(estimate.y))) {
      markers += makeMarker('tracker', 'Live estimate', estimate.x, estimate.y, room);
    }
    return `<article class="room-card">
      <div class="room-card-head"><div><strong>${escapeHtml(room.name)}</strong><small>${Number(room.widthM).toFixed(1)} m × ${Number(room.heightM).toFixed(1)} m</small></div>
      <button class="danger-button" type="button" data-delete-room="${escapeHtml(room.id)}">Remove</button></div>
      <div class="room-stage" role="img" aria-label="${escapeHtml(room.name)} floor grid, ${Number(room.widthM).toFixed(1)} meters wide and ${Number(room.heightM).toFixed(1)} meters high">${markers || '<span class="empty-state">No placed signals or fingerprints yet.</span>'}</div>
      <div class="room-axis"><span>0 m</span><span>X · ${Number(room.widthM).toFixed(1)} m</span><span>Y · ${Number(room.heightM).toFixed(1)} m</span></div>
      <div class="sub">${roomSignals.length} signal${roomSignals.length === 1 ? '' : 's'} · ${roomFingerprints.length} fingerprint point${roomFingerprints.length === 1 ? '' : 's'}</div>
    </article>`;
  }).join('') : '<div class="empty-state">Create a room to begin mapping.</div>';

  $('roomMaps').innerHTML = output;
  $('overviewMap').innerHTML = rooms.length
    ? rooms.map((room) => {
      const roomSignals = signals.filter((signal) => signal.roomId === room.id && hasNumber(signal.x) && hasNumber(signal.y));
      const roomFingerprints = fingerprints.filter((point) => point.roomId === room.id && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)));
      let markers = roomSignals.map((signal) => makeMarker('ap-marker', signal.label, signal.x, signal.y, room)).join('');
      markers += roomFingerprints.map((point) => makeMarker('fingerprint', point.label, point.x, point.y, room)).join('');
      if (estimate.roomId === room.id && Number.isFinite(Number(estimate.x)) && Number.isFinite(Number(estimate.y))) markers += makeMarker('tracker', 'Live', estimate.x, estimate.y, room);
      return `<article class="room-card"><div class="room-card-head"><div><strong>${escapeHtml(room.name)}</strong><small>${Number(room.widthM).toFixed(1)} m × ${Number(room.heightM).toFixed(1)} m</small></div></div><div class="room-stage">${markers || '<span class="empty-state">Room ready for calibration</span>'}</div></article>`;
    }).join('')
    : '<div class="empty-state">Add a room and capture fingerprint points to create the map.</div>';

  document.querySelectorAll('[data-delete-room]').forEach((button) => {
    button.addEventListener('click', () => deleteRoom(button.dataset.deleteRoom));
  });
  renderSavedLists(fingerprints);
}

function renderSignals(aps) {
  const sorted = [...aps].sort((a, b) => Number(b.rssi) - Number(a.rssi));
  const detectedSelect = $('detectedAccessPoint');
  const selectedBssid = detectedSelect.value;
  detectedSelect.innerHTML = '<option value="">Choose a detected network to fill its details</option>' + sorted.map((ap) =>
    `<option value="${escapeHtml(ap.bssid)}">${escapeHtml(ap.ssid || 'Hidden')} · ${Number(ap.rssi)} dBm · ${escapeHtml(ap.bssid)}</option>`
  ).join('');
  if (sorted.some((ap) => ap.bssid === selectedBssid)) detectedSelect.value = selectedBssid;
  const configuredCount = sorted.filter((ap) => ap.roomId).length;
  const strongCount = sorted.filter((ap) => Number(ap.rssi) >= -65).length;
  const weakCount = sorted.filter((ap) => Number(ap.rssi) < -75).length;
  $('scanQualitySummary').innerHTML = sorted.length ? `
    <div class="quality-stat" title="Access points assigned to a room"><span>Mapped</span><strong>${configuredCount}/${sorted.length}</strong></div>
    <div class="quality-stat" title="RSSI at least -65 dBm"><span>Strong</span><strong>${strongCount}</strong></div>
    <div class="quality-stat" title="RSSI below -75 dBm"><span>Weak</span><strong>${weakCount}</strong></div>`
    : `<div class="quality-stat empty-quality">${latest?.lastPacketAt ? 'No access points detected' : 'No scan data'}</div>`;
  $('signalSnapshot').innerHTML = sorted.length ? sorted.slice(0, 6).map((ap) => `
    <div class="signal-row"><span class="signal-network"><strong>${escapeHtml(ap.label || ap.ssid || 'Hidden')}</strong><small>${escapeHtml(roomName(ap.roomId))}</small></span><div class="bar"><i style="width:${Math.max(5, Math.min(100, 100 + Number(ap.rssi)))}%"></i></div><b>${Number(ap.rssi)} dBm</b></div>`
  ).join('') : '<div class="empty-state">No access points in the latest scan.</div>';
  $('signalRows').innerHTML = sorted.length ? sorted.map((ap) => `
    <tr><td>${escapeHtml(ap.ssid || 'Hidden')}</td><td>${escapeHtml(ap.bssid)}</td><td>${escapeHtml(roomName(ap.roomId))}</td><td class="rssi">${Number(ap.rssi)} dBm</td><td>${ap.channel ?? '—'}</td><td>${Number.isFinite(Number(ap.distanceM)) ? `${Number(ap.distanceM).toFixed(2)} m` : '—'}</td><td><span class="quality">${signalQuality(ap.rssi)}</span></td></tr>`
  ).join('') : '<tr><td colspan="7" class="empty-state">No access points in the latest scan.</td></tr>';
  $('scanSummary').textContent = latest?.lastPacketAt
    ? `${sorted.length} access point records · latest scan ${formatDateTime(latest.lastPacketAt)}`
    : 'Waiting for the next scan';
  $('apOptions').innerHTML = sorted.map((ap) =>
    `<option value="${escapeHtml(ap.bssid)}">${escapeHtml(ap.ssid || 'Hidden')} · ${Number(ap.rssi)} dBm</option>`
  ).join('');
}

function signalQuality(rssi) {
  const value = Number(rssi);
  if (value >= -50) return 'Excellent';
  if (value >= -65) return 'Good';
  if (value >= -75) return 'Fair';
  return 'Weak';
}

function renderRecentRows(aps) {
  const estimate = latest.location || {};
  const observedRoom = latest.rooms?.find((room) => room.id === estimate.roomId)?.name || 'Unknown';
  $('recentRows').innerHTML = aps.length ? [...aps].sort((a, b) => Number(b.rssi) - Number(a.rssi)).slice(0, 8).map((ap) => `
      <tr><td>${formatClock(latest.lastPacketAt)}</td><td>${escapeHtml(ap.ssid || 'Hidden')}</td><td>${escapeHtml(observedRoom)}</td><td>${escapeHtml(roomName(ap.roomId))}</td><td class="rssi">${Number(ap.rssi)} dBm</td><td>${Number.isFinite(Number(ap.distanceM)) ? `${Number(ap.distanceM).toFixed(2)} m` : '—'}</td><td>${latest.motionSensor ? (latest.motion ? 'Moving' : 'Stationary') : 'Unavailable'}</td></tr>`
    ).join('') : '<tr><td colspan="7" class="empty-state">No access points in the latest scan.</td></tr>';
}

function renderSavedConfiguration(signals, fingerprints) {
  $('signalConfigList').innerHTML = signals.length ? signals.map((signal) => `
    <div class="saved-item"><div><strong>${escapeHtml(signal.label)}</strong><small>${escapeHtml(signal.bssid)} · ${escapeHtml(roomName(signal.roomId))}${hasNumber(signal.x) && hasNumber(signal.y) ? ` · ${Number(signal.x).toFixed(1)}, ${Number(signal.y).toFixed(1)} m` : ''}</small></div><button class="danger-button" type="button" data-delete-signal="${escapeHtml(signal.bssid)}">Remove</button></div>`
  ).join('') : '<div class="empty-state">No Wi-Fi signal configurations saved.</div>';
  document.querySelectorAll('[data-delete-signal]').forEach((button) => {
    button.addEventListener('click', () => deleteSignal(button.dataset.deleteSignal));
  });
  renderSavedLists(fingerprints);
}

function renderSavedLists(fingerprints) {
  $('fingerprintList').innerHTML = fingerprints.length ? fingerprints.map((point) => `
    <div class="saved-item"><div><strong>${escapeHtml(point.label)}</strong><small>${escapeHtml(roomName(point.roomId))} · ${Number(point.x).toFixed(1)}, ${Number(point.y).toFixed(1)} m</small></div><button class="danger-button" type="button" data-delete-fingerprint="${escapeHtml(point.id)}">Remove</button></div>`
  ).join('') : '<div class="empty-state">No fingerprints captured.</div>';
  document.querySelectorAll('[data-delete-fingerprint]').forEach((button) => {
    button.addEventListener('click', () => deleteFingerprint(button.dataset.deleteFingerprint));
  });
}

async function loadScans() {
  try {
    const fromDateValue = $('filterFromDate').value;
    const toDateValue = $('filterToDate').value;
    const fromTime = selectedFilterTime('filterFrom');
    const toTime = selectedFilterTime('filterTo');
    if (fromTime.partial || toTime.partial) {
      showToast('Choose hour, minute, and AM/PM for each time filter.', true);
      return;
    }
    if ((fromTime.value && !fromDateValue) || (toTime.value && !toDateValue)) {
      showToast('Choose a date for each time filter.', true);
      return;
    }
    const fromDate = fromDateValue
      ? new Date(`${fromDateValue}T${fromTime.value || '00:00'}`)
      : null;
    const toDate = toDateValue
      ? new Date(`${toDateValue}T${toTime.value || '00:00'}`)
      : null;
    if ((fromDate && Number.isNaN(fromDate.getTime())) || (toDate && Number.isNaN(toDate.getTime()))) {
      showToast('Enter valid dates and times.', true);
      return;
    }
    if (fromDate && toDate && fromDate > toDate) {
      showToast('Start time must be before or equal to end time.', true);
      return;
    }
    const params = new URLSearchParams({ limit: fromDate || toDate ? '10000' : '500' });
    const exportParams = new URLSearchParams();
    if (fromDate) {
      params.set('from', fromDate.toISOString());
      exportParams.set('from', fromDate.toISOString());
    }
    if (toDate) {
      const [year, month, day] = toDateValue.split('-').map(Number);
      const endOfRange = toTime.value
        ? new Date(toDate.getTime() + 60_000 - 1)
        : new Date(year, month - 1, day + 1, 0, 0, 0, -1);
      const inclusiveEnd = endOfRange.toISOString();
      params.set('to', inclusiveEnd);
      exportParams.set('to', inclusiveEnd);
    }
    $('historyCsvButton').href = `/api/export.csv${exportParams.toString() ? `?${exportParams.toString()}` : ''}`;
    const response = await api(`/api/scans?${params.toString()}`);
    scanRows = response.scans || [];
    const total = Number(response.total || 0);
    const resultCount = scanRows.length;
    const rangeDescription = fromDate || toDate
      ? ` · ${fromDate ? formatDateTime(fromDate) : 'Beginning'} to ${toDate ? (toTime.value ? formatDateTime(toDate) : toDateValue) : 'Now'}`
      : '';
    $('historySummary').textContent = `${total.toLocaleString()} matching AP observations${total > resultCount ? ` · displaying latest ${resultCount.toLocaleString()}` : ''}${rangeDescription} · ${response.storage || 'local-jsonl'} storage`;
    $('historyRows').innerHTML = scanRows.length ? scanRows.map((row) => `
      <tr><td>${formatDateTime(row.timestamp)}</td><td>${escapeHtml(row.deviceId || row.device_id || '—')}</td><td>${escapeHtml(row.roomName || row.room_name || 'Unknown / not calibrated')}</td><td>${escapeHtml(row.signalRoomName || row.signal_room_name || 'Not assigned')}</td><td>${escapeHtml(row.ssid || 'Hidden')}</td><td>${escapeHtml(row.bssid)}</td><td class="rssi">${Number(row.rssi ?? row.rssi_dbm)} dBm</td><td>${row.channel ?? '—'}</td><td>${Number.isFinite(Number(row.distanceM)) ? `${Number(row.distanceM).toFixed(2)} m` : '—'}</td><td>${row.motion ? 'Moving' : 'Stationary'}</td><td>${row.wifiConnected ? 'Connected' : 'Offline / buffered'}</td></tr>`
    ).join('') : '<tr><td colspan="11" class="empty-state">No observations match the selected time range.</td></tr>';
  } catch (error) {
    showToast(error.message, true);
    $('historySummary').textContent = 'Could not load saved observations.';
  }
}

async function refreshState() {
  try {
    const data = await api('/api/state');
    render(data);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function deleteRoom(id) {
  if (!window.confirm('Remove this room? Its placed Wi-Fi signals and fingerprints will become unassigned.')) return;
  try { await api(`/api/rooms/${encodeURIComponent(id)}`, { method: 'DELETE' }); showToast('Room removed.'); }
  catch (error) { showToast(error.message, true); }
}

async function deleteSignal(bssid) {
  try { await api(`/api/signals/${encodeURIComponent(bssid)}`, { method: 'DELETE' }); showToast('Wi-Fi signal removed.'); }
  catch (error) { showToast(error.message, true); }
}

async function deleteFingerprint(id) {
  try { await api(`/api/fingerprints/${encodeURIComponent(id)}`, { method: 'DELETE' }); showToast('Fingerprint removed.'); }
  catch (error) { showToast(error.message, true); }
}

$('roomForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    await api('/api/rooms', { method: 'POST', body: JSON.stringify({
      name: form.get('name'), widthM: Number(form.get('widthM')), heightM: Number(form.get('heightM'))
    }) });
    formElement.reset();
    showToast('Room added to the meter-based map.');
  } catch (error) { $('mapNotice').textContent = error.message; showToast(error.message, true); }
});

$('fingerprintForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    await api('/api/fingerprints', { method: 'POST', body: JSON.stringify({
      label: form.get('label'), roomId: form.get('roomId'), x: Number(form.get('x')), y: Number(form.get('y'))
    }) });
    formElement.reset();
    showToast('Latest Wi-Fi scan captured at this room coordinate.');
  } catch (error) { showToast(error.message, true); }
});

$('signalForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const hasX = String(form.get('x')).trim() !== '';
  const hasY = String(form.get('y')).trim() !== '';
  if (hasX !== hasY) { showToast('Enter both signal coordinates, or leave both blank.', true); return; }
  try {
    await api('/api/signals', { method: 'POST', body: JSON.stringify({
      bssid: form.get('bssid'), label: form.get('label'), roomId: form.get('roomId') || null,
      x: hasX ? Number(form.get('x')) : null, y: hasY ? Number(form.get('y')) : null,
      txPower: Number(form.get('txPower')), pathLoss: Number(form.get('pathLoss'))
    }) });
    formElement.reset();
    formElement.elements.txPower.value = '-59';
    formElement.elements.pathLoss.value = '2.2';
    showToast(latest?.storage === 'postgresql'
      ? 'Wi-Fi signal saved to the server database.'
      : 'Wi-Fi signal saved on the local dashboard server.');
  } catch (error) { showToast(error.message, true); }
});

$('detectedAccessPoint').addEventListener('change', (event) => {
  const ap = latest?.aps?.find((item) => item.bssid === event.currentTarget.value);
  if (!ap) return;
  $('signalForm').elements.bssid.value = ap.bssid;
  $('signalForm').elements.label.value = ap.ssid && ap.ssid !== '(hidden)' ? ap.ssid : 'Wi-Fi signal';
});

$('refreshButton').addEventListener('click', () => {
  refreshState();
  loadScans();
});
$('historyFilterForm').addEventListener('submit', (event) => {
  event.preventDefault();
  loadScans();
});
$('clearHistoryFilters').addEventListener('click', () => {
  $('historyFilterForm').reset();
  loadScans();
});
$('pdfButton').addEventListener('click', () => window.print());
initializeTimeFilters();
document.querySelectorAll('.room-select').forEach((select) => select.addEventListener('change', () => {
  const room = latest?.rooms?.find((item) => item.id === select.value);
  if (!room) return;
  const form = select.closest('form');
  if (form.elements.x && form.elements.y) {
    form.elements.x.max = room.widthM;
    form.elements.y.max = room.heightM;
  }
}));

if (typeof io === 'function') {
  const socket = io();
  socket.on('state', render);
}
refreshState();
loadScans();
setInterval(refreshState, 5000);
