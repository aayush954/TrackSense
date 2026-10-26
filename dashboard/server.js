const express = require('express');
const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const HTTP_PORT = Number(process.env.PORT || 3000);
const UDP_PORT = Number(process.env.UDP_PORT || 5005);
const DEVICE_API_KEY = process.env.DEVICE_API_KEY || '';
const NODE_ENV = process.env.NODE_ENV || 'development';
if (NODE_ENV === 'production' && !DEVICE_API_KEY) {
  throw new Error('Production requires DEVICE_API_KEY.');
}
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SCAN_LOG = path.join(DATA_DIR, 'scans.jsonl');
const SCAN_CSV = path.join(DATA_DIR, 'scans.csv');
const MAX_MEMORY_HISTORY = 5000;
const MAX_RECENT_SCAN_IDS = 5000;
fs.mkdirSync(DATA_DIR, { recursive: true });

const databaseSsl = process.env.DATABASE_SSL === 'disable'
  ? false
  : { rejectUnauthorized: process.env.DATABASE_SSL !== 'require' };
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: databaseSsl,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000
}) : null;
let dbReady = false;
let state = { lastPacketAt: null, deviceIp: null, deviceId: 'tracksense-001', motion: false, motionSensor: false, wifiConnected: false, batteryVoltage: null, batteryPercent: null, aps: {}, rooms: [], signals: [], fingerprints: [], history: [] };
try { if (fs.existsSync(STATE_FILE)) state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch (e) { console.warn('State file load warning:', e.message); }
if (!Array.isArray(state.rooms)) state.rooms = [];
if (!Array.isArray(state.signals)) state.signals = [];
if (!Array.isArray(state.fingerprints)) state.fingerprints = [];
if (!Array.isArray(state.processedScanIds)) state.processedScanIds = [];
if (!state.aps || typeof state.aps !== 'object') state.aps = {};
const processedScanIds = new Set(state.processedScanIds);

async function initDb() {
  if (!pool) { console.log('DATABASE_URL not configured: using local JSON/JSONL storage.'); return; }
  await pool.query(`CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT 'TrackSense device', last_seen TIMESTAMPTZ,
    last_ip TEXT, motion BOOLEAN NOT NULL DEFAULT FALSE, sensor_ok BOOLEAN NOT NULL DEFAULT FALSE,
    wifi_connected BOOLEAN NOT NULL DEFAULT FALSE, battery_voltage REAL, battery_percent REAL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('ALTER TABLE devices ADD COLUMN IF NOT EXISTS wifi_connected BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query(`CREATE TABLE IF NOT EXISTS scan_observations (
    id BIGSERIAL PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(device_id), observed_at TIMESTAMPTZ NOT NULL,
    bssid TEXT NOT NULL, ssid TEXT, rssi_dbm INTEGER NOT NULL, channel INTEGER, motion BOOLEAN NOT NULL DEFAULT FALSE,
    sensor_ok BOOLEAN NOT NULL DEFAULT FALSE, wifi_connected BOOLEAN NOT NULL DEFAULT FALSE,
    battery_voltage REAL, battery_percent REAL, source_ip TEXT, room_name TEXT, signal_room_name TEXT
  )`);
  await pool.query('ALTER TABLE scan_observations ADD COLUMN IF NOT EXISTS wifi_connected BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query('ALTER TABLE scan_observations ADD COLUMN IF NOT EXISTS room_name TEXT');
  await pool.query('ALTER TABLE scan_observations ADD COLUMN IF NOT EXISTS signal_room_name TEXT');
  await pool.query('ALTER TABLE scan_observations ADD COLUMN IF NOT EXISTS scan_id TEXT');
  await pool.query('ALTER TABLE scan_observations ADD COLUMN IF NOT EXISTS sequence BIGINT');
  await pool.query('ALTER TABLE scan_observations ADD COLUMN IF NOT EXISTS device_timestamp_ms BIGINT');
  await pool.query('ALTER TABLE scan_observations ADD COLUMN IF NOT EXISTS firmware_version TEXT');
  await pool.query('CREATE INDEX IF NOT EXISTS scan_observations_time_idx ON scan_observations(observed_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS scan_observations_device_idx ON scan_observations(device_id, observed_at DESC)');
  await pool.query(`CREATE TABLE IF NOT EXISTS telemetry_scans (
    device_id TEXT NOT NULL REFERENCES devices(device_id), scan_id TEXT NOT NULL,
    sequence BIGINT, device_timestamp_ms BIGINT, firmware_version TEXT,
    received_at TIMESTAMPTZ NOT NULL, motion_state TEXT NOT NULL DEFAULT 'unavailable',
    sensor_status TEXT NOT NULL DEFAULT 'unavailable', wifi_connected BOOLEAN NOT NULL DEFAULT FALSE,
    battery_voltage REAL, battery_percent REAL, source_ip TEXT,
    PRIMARY KEY(device_id, scan_id)
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS telemetry_scans_received_idx ON telemetry_scans(received_at DESC)');
  await pool.query(`CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, width_m DOUBLE PRECISION NOT NULL,
    height_m DOUBLE PRECISION NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fingerprints (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, x DOUBLE PRECISION, y DOUBLE PRECISION,
    rssi JSONB NOT NULL, room_id TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('ALTER TABLE fingerprints ADD COLUMN IF NOT EXISTS room_id TEXT');
  await pool.query(`CREATE TABLE IF NOT EXISTS signal_config (
    bssid TEXT PRIMARY KEY, label TEXT NOT NULL, x DOUBLE PRECISION, y DOUBLE PRECISION,
    tx_power REAL NOT NULL DEFAULT -59, path_loss REAL NOT NULL DEFAULT 2.2, room_id TEXT
  )`);
  await pool.query('ALTER TABLE signal_config ADD COLUMN IF NOT EXISTS room_id TEXT');
  await pool.query(`INSERT INTO devices(device_id) VALUES($1) ON CONFLICT(device_id) DO NOTHING`, [state.deviceId || 'tracksense-001']);
  for (const room of state.rooms) {
    await pool.query('INSERT INTO rooms(id,name,width_m,height_m) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',
      [room.id, room.name, room.widthM, room.heightM]);
  }
  for (const signal of state.signals) {
    await pool.query(`INSERT INTO signal_config(bssid,label,x,y,tx_power,path_loss,room_id) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(bssid) DO NOTHING`,
    [signal.bssid, signal.label, signal.x, signal.y, signal.txPower ?? -59, signal.pathLoss ?? 2.2, signal.roomId || null]);
  }
  for (const fingerprint of state.fingerprints) {
    await pool.query(`INSERT INTO fingerprints(id,label,x,y,rssi,room_id,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(id) DO NOTHING`,
    [fingerprint.id, fingerprint.label, fingerprint.x, fingerprint.y, JSON.stringify(fingerprint.rssi || {}),
      fingerprint.roomId || null, fingerprint.updatedAt || new Date().toISOString()]);
  }
  const rooms = await pool.query('SELECT id,name,width_m,height_m FROM rooms ORDER BY name');
  state.rooms = rooms.rows.map(r => ({id:r.id,name:r.name,widthM:r.width_m,heightM:r.height_m}));
  const fps = await pool.query('SELECT id,label,x,y,rssi,room_id,updated_at FROM fingerprints ORDER BY updated_at');
  state.fingerprints = fps.rows.map(r => ({id:r.id,label:r.label,x:r.x,y:r.y,roomId:r.room_id,rssi:r.rssi,updatedAt:r.updated_at}));
  const sigs = await pool.query('SELECT bssid,label,x,y,tx_power,path_loss,room_id FROM signal_config ORDER BY label');
  state.signals = sigs.rows.map(r=>({bssid:r.bssid,label:r.label,x:r.x,y:r.y,txPower:r.tx_power,pathLoss:r.path_loss,roomId:r.room_id}));
  const latest = await pool.query(`SELECT device_id, observed_at, bssid, ssid, rssi_dbm, channel, motion, sensor_ok, wifi_connected, source_ip, battery_voltage, battery_percent
    FROM scan_observations ORDER BY observed_at DESC LIMIT 500`);
  if (latest.rows.length) {
    const sorted = latest.rows.reverse();
    const last = sorted[sorted.length-1];
    state.lastPacketAt = new Date(last.observed_at).toISOString(); state.deviceId = last.device_id; state.deviceIp = last.source_ip;
    state.motion = last.motion; state.motionSensor = last.sensor_ok; state.batteryVoltage = last.battery_voltage; state.batteryPercent = last.battery_percent;
    state.wifiConnected = last.wifi_connected;
    const currentAt = state.lastPacketAt; state.aps = {};
    for (const r of sorted.filter(r => new Date(r.observed_at).getTime() >= new Date(currentAt).getTime()-30000)) state.aps[r.bssid] = {bssid:r.bssid,ssid:r.ssid,rssi:r.rssi_dbm,channel:r.channel,lastSeen:new Date(r.observed_at).toISOString()};
    state.history = sorted.map(r=>({at:new Date(r.observed_at).toISOString(), strongestRssi:r.rssi_dbm, apCount:1, motion:r.motion})).slice(-MAX_MEMORY_HISTORY);
  }
  const latestScan = await pool.query(`SELECT device_id,scan_id,received_at,motion_state,sensor_status,
    wifi_connected,battery_voltage,battery_percent,source_ip FROM telemetry_scans
    ORDER BY received_at DESC LIMIT 1`);
  if (latestScan.rows.length) {
    const scan=latestScan.rows[0];
    const receivedAt=new Date(scan.received_at).toISOString();
    if (!state.lastPacketAt || Date.parse(receivedAt)>=Date.parse(state.lastPacketAt)) {
      state.deviceId=scan.device_id; state.deviceIp=scan.source_ip; state.lastPacketAt=receivedAt;
      state.motion=scan.motion_state==='moving'; state.motionSensor=scan.sensor_status==='ok';
      state.wifiConnected=scan.wifi_connected; state.batteryVoltage=scan.battery_voltage;
      state.batteryPercent=scan.battery_percent; state.aps={};
      const latestAps=await pool.query(`SELECT bssid,ssid,rssi_dbm,channel FROM scan_observations
        WHERE device_id=$1 AND scan_id=$2 ORDER BY id`,[scan.device_id,scan.scan_id]);
      for(const ap of latestAps.rows) state.aps[ap.bssid]={bssid:ap.bssid,ssid:ap.ssid,rssi:ap.rssi_dbm,channel:ap.channel,lastSeen:receivedAt};
      const recentScans=await pool.query(`SELECT t.received_at,t.motion_state,
        (SELECT MAX(o.rssi_dbm) FROM scan_observations o WHERE o.device_id=t.device_id AND o.scan_id=t.scan_id) AS strongest_rssi,
        (SELECT COUNT(*)::int FROM scan_observations o WHERE o.device_id=t.device_id AND o.scan_id=t.scan_id) AS ap_count
        FROM telemetry_scans t WHERE t.device_id=$1 ORDER BY t.received_at DESC LIMIT 120`,[scan.device_id]);
      state.history=recentScans.rows.reverse().map(row=>({
        at:new Date(row.received_at).toISOString(),strongestRssi:row.strongest_rssi,
        apCount:row.ap_count,motion:row.motion_state==='moving'
      }));
    }
  }
  dbReady = true;
  console.log('PostgreSQL persistence enabled.');
}
function persistState() { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { console.error('State persistence failed:', e.message); } }
function publish() { io.emit('state', publicState()); persistState(); }
function approximateDistance(rssi, txPower=-59, n=2.2) { return Math.pow(10, (txPower-rssi)/(10*n)); }
const CSV_HEADER = ['timestamp','device_id','device_ip','wifi_connected','motion','motion_sensor','battery_voltage','battery_percent','bssid','ssid','rssi_dbm','channel','distance_m','observed_room','signal_room','scan_id','sequence','device_timestamp_ms','firmware_version'];
function csvCell(value) {
  const normalized = typeof value === 'string' && /^[\t\r=+\-@]/.test(value) ? `'${value}` : value;
  return `"${String(normalized ?? '').replace(/"/g, '""')}"`;
}
function distanceMeters(bssid, rssi) {
  const config=state.signals.find(signal=>signal.bssid.toLowerCase()===String(bssid||'').toLowerCase());
  return approximateDistance(Number(rssi),config?config.txPower:-59,config?config.pathLoss:2.2);
}
function scanCsvRow(r) {
  const rssi=r.rssi??r.rssi_dbm;
  return [r.timestamp||r.observed_at,r.deviceId||r.device_id,r.deviceIp||r.device_ip,r.wifiConnected??r.wifi_connected,r.motion,r.motionSensor??r.motion_sensor,r.batteryVoltage??r.battery_voltage,r.batteryPercent??r.battery_percent,r.bssid,r.ssid,rssi,r.channel,distanceMeters(r.bssid,rssi),r.roomName||r.room_name||r.observedRoom||r.observed_room||'Unknown / not calibrated',r.signalRoomName||r.signal_room_name||r.signalRoom||r.signal_room||'Not assigned',r.scanId||r.scan_id,r.sequence,r.deviceTimestampMs??r.device_timestamp_ms,r.firmwareVersion||r.firmware_version];
}
function initializeScanCsv() {
  if (fs.existsSync(SCAN_CSV)) {
    const existing=fs.readFileSync(SCAN_CSV,'utf8').trim().split(/\r?\n/);
    if(existing.length>1) return;
  }
  const records=fs.existsSync(SCAN_LOG)
    ? fs.readFileSync(SCAN_LOG,'utf8').split(/\r?\n/).filter(Boolean).map(line=>{try{return JSON.parse(line)}catch{return null}}).filter(Boolean)
    : [];
  const rows=[CSV_HEADER,...records.map(scanCsvRow)];
  fs.writeFileSync(SCAN_CSV,rows.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n','utf8');
}
function parseCsv(text) {
  const records=[];
  let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++) {
    const char=text[i];
    if(quoted) {
      if(char==='"'&&text[i+1]==='"') { cell+='"'; i++; }
      else if(char==='"') quoted=false;
      else cell+=char;
    } else if(char==='"'&&cell==='') quoted=true;
    else if(char===',') { row.push(cell); cell=''; }
    else if(char==='\n') { row.push(cell.replace(/\r$/,'')); records.push(row); row=[]; cell=''; }
    else cell+=char;
  }
  if(cell||row.length) { row.push(cell.replace(/\r$/,'')); records.push(row); }
  return records;
}
function observationKey(record) {
  return `${record.timestamp||record.observed_at}\u0000${record.deviceId||record.device_id}\u0000${String(record.bssid||'').toLowerCase()}`;
}
function enrichScanRooms(records) {
  const groups=new Map();
  for(const record of records) {
    const key=`${record.timestamp||record.observed_at}\u0000${record.deviceId||record.device_id}`;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(record);
  }
  for(const group of groups.values()) {
    const savedRoom=group.find(record=>record.roomName||record.room_name||record.room);
    let roomName=savedRoom?.roomName||savedRoom?.room_name||savedRoom?.room;
    if(!roomName) {
      const location=estimateLocation(group.map(record=>({bssid:record.bssid,rssi:Number(record.rssi??record.rssi_dbm)})));
      roomName=state.rooms.find(room=>room.id===location.roomId)?.name||'Unknown / not calibrated';
    }
    for(const record of group) {
      record.roomName=roomName;
      if(!record.signalRoomName&&!record.signal_room_name&&!record.signal_room) {
        const signal=state.signals.find(item=>item.bssid.toLowerCase()===String(record.bssid||'').toLowerCase());
        record.signalRoomName=state.rooms.find(room=>room.id===signal?.roomId)?.name||'Not assigned';
      }
    }
  }
  return records;
}
function migrateScanCsvRooms() {
  if(!fs.existsSync(SCAN_CSV))return;
  const rows=parseCsv(fs.readFileSync(SCAN_CSV,'utf8'));
  if(!rows.length)return;
  const header=rows[0];
  const observedRoomIndex=header.findIndex(value=>['room','observed_room','room_name'].includes(value.trim().toLowerCase()));
  const signalRoomIndex=header.findIndex(value=>['signal_room','signal_room_name'].includes(value.trim().toLowerCase()));
  if(observedRoomIndex>=0&&signalRoomIndex>=0&&CSV_HEADER.every(field=>header.includes(field))&&rows.slice(1).every(row=>row[observedRoomIndex]&&row[signalRoomIndex]))return;
  const records=fs.existsSync(SCAN_LOG)
    ? fs.readFileSync(SCAN_LOG,'utf8').split(/\r?\n/).filter(Boolean).map(line=>{try{return JSON.parse(line)}catch{return null}}).filter(Boolean)
    : [];
  const roomByObservation=new Map(enrichScanRooms(records).map(record=>[observationKey(record),record.roomName]));
  const signalRoomByObservation=new Map(records.map(record=>[observationKey(record),record.signalRoomName]));
  if(observedRoomIndex<0)header.push('observed_room');
  else header[observedRoomIndex]='observed_room';
  if(signalRoomIndex<0)header.push('signal_room');
  else header[signalRoomIndex]='signal_room';
  for(const field of CSV_HEADER)if(!header.includes(field))header.push(field);
  const migratedObservedRoomIndex=header.findIndex(value=>value.trim().toLowerCase()==='observed_room');
  const migratedSignalRoomIndex=header.findIndex(value=>value.trim().toLowerCase()==='signal_room');
  const timestampIndex=header.findIndex(value=>value.trim().toLowerCase()==='timestamp');
  const deviceIndex=header.findIndex(value=>value.trim().toLowerCase()==='device_id');
  const bssidIndex=header.findIndex(value=>value.trim().toLowerCase()==='bssid');
  for(const row of rows.slice(1)) {
    while(row.length<header.length)row.push('');
    const key=observationKey({timestamp:row[timestampIndex],deviceId:row[deviceIndex],bssid:row[bssidIndex]});
    if(!row[migratedObservedRoomIndex])row[migratedObservedRoomIndex]=roomByObservation.get(key)||'Unknown / not calibrated';
    if(!row[migratedSignalRoomIndex])row[migratedSignalRoomIndex]=signalRoomByObservation.get(key)||'Not assigned';
  }
  const csv=rows.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
  const temporaryPath=`${SCAN_CSV}.tmp`;
  fs.writeFileSync(temporaryPath,csv,'utf8');
  fs.renameSync(temporaryPath,SCAN_CSV);
}
function appendScanCsv(records) {
  if (!fs.existsSync(SCAN_CSV)) initializeScanCsv();
  const rows = records.map(scanCsvRow);
  fs.appendFileSync(SCAN_CSV, rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n', 'utf8');
}
function estimateLocation(aps) {
  if (!state.fingerprints.length || !aps.length) return {label:'Not calibrated',x:null,y:null,confidence:'none',note:'Capture multiple fingerprints at known indoor coordinates to enable location estimation.'};
  const current = Object.fromEntries(aps.map(a=>[String(a.bssid).toLowerCase(),a.rssi]));
  const scored = state.fingerprints.map(fp => {
    const entries = Object.keys(fp.rssi||{}).filter(k=>current[k]!==undefined);
    if (!entries.length) return {fp,score:Infinity,matched:0};
    const mse=entries.reduce((sum,k)=>sum+Math.pow(current[k]-Number(fp.rssi[k]),2),0)/entries.length;
    return {fp,score:mse,matched:entries.length};
  }).sort((a,b)=>a.score-b.score);
  const valid=scored.filter(s=>Number.isFinite(s.score)).slice(0,3);
  if (!valid.length) return {label:'No matching fingerprint',x:null,y:null,confidence:'none',note:'No overlap between live access points and stored fingerprints.'};
  // Inverse-error weighted k-nearest fingerprints; multiple calibration points can contribute.
  const roomId=valid[0].fp.roomId||null;
  const weighted=valid.filter(s=>(s.fp.roomId||null)===roomId&&Number.isFinite(Number(s.fp.x))&&Number.isFinite(Number(s.fp.y)));
  if (!weighted.length) return {label:valid[0].fp.label,roomId,x:valid[0].fp.x,y:valid[0].fp.y,confidence:'low',matchedAPs:valid[0].matched,mse:Math.round(valid[0].score),note:'Fingerprints need a room and numeric X/Y coordinates in meters for mapped location estimates.'};
  const weights=weighted.map(s=>1/(s.score+1)); const total=weights.reduce((a,b)=>a+b,0);
  const x=weighted.reduce((sum,s,i)=>sum+Number(s.fp.x)*weights[i],0)/total;
  const y=weighted.reduce((sum,s,i)=>sum+Number(s.fp.y)*weights[i],0)/total;
  const best=valid[0];
  const confidence=best.score<49&&best.matched>=3?'high':best.score<144&&best.matched>=2?'moderate':'low';
  return {label:best.fp.label,roomId,x,y,confidence,matchedAPs:best.matched,mse:Math.round(best.score),neighbors:weighted.map(s=>({label:s.fp.label,x:s.fp.x,y:s.fp.y,mse:Math.round(s.score),matchedAPs:s.matched})),note:'Estimated from up to three nearest fingerprints in the same room; coordinates and distances are approximate.'};
}
try { initializeScanCsv(); migrateScanCsvRooms(); } catch(e) { console.error('CSV archive initialization failed:',e.message); }
function publicState() {
  const aps=Object.values(state.aps).map(a=>{const cfg=state.signals.find(s=>s.bssid.toLowerCase()===a.bssid.toLowerCase());return {...a,distanceM:approximateDistance(a.rssi,cfg?cfg.txPower:-59,cfg?cfg.pathLoss:2.2),label:cfg?cfg.label:null,roomId:cfg?cfg.roomId||null:null};}).sort((a,b)=>b.rssi-a.rssi);
  return {lastPacketAt:state.lastPacketAt,deviceIp:state.deviceIp,deviceId:state.deviceId,motion:state.motion,motionSensor:state.motionSensor,wifiConnected:state.wifiConnected,batteryVoltage:state.batteryVoltage,batteryPercent:state.batteryPercent,aps,rooms:state.rooms,signals:state.signals,fingerprints:state.fingerprints.map(f=>({id:f.id,label:f.label,x:f.x,y:f.y,roomId:f.roomId||null,updatedAt:f.updatedAt})),history:state.history.slice(-120),best:aps[0]||null,location:estimateLocation(aps),storage:dbReady?'postgresql':'local-jsonl'};
}
function parseLegacyPayload(text, deviceId) {
  const aps=[];
  let motion=false,sensorOk=false,wifiConnected=false,batteryVoltage=null,batteryPercent=null,metaSeen=false;
  for (const raw of String(text).split(';')) {
    const p=raw.trim().split('|'); if (!p.length||!p[0]) continue;
    if (p[0]==='META') {
      if (p.length < 7) return null;
      metaSeen=true; motion=p[2]==='1'; sensorOk=p[3]==='1';
      if (p[4]&&Number.isFinite(Number(p[4]))) batteryVoltage=Number(p[4]);
      if (p[5]&&Number.isFinite(Number(p[5]))) batteryPercent=Number(p[5]);
      wifiConnected=p[6]==='1'; continue;
    }
    if (p.length!==4 || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(p[0])) continue;
    const [bssid,ssid,rssiRaw,channelRaw]=p;
    const rssi=Number(rssiRaw),channel=Number(channelRaw);
    if (!Number.isInteger(rssi)||rssi < -127||rssi > 0) continue;
    aps.push({bssid:bssid.toLowerCase(),ssid:(ssid||'(hidden)').slice(0,32),rssi,channel:Number.isInteger(channel)&&channel>=1&&channel<=196?channel:null});
  }
  if (!aps.length && !metaSeen) return null;
  return {
    scanId:crypto.randomUUID(),sequence:null,deviceTimestampMs:null,firmwareVersion:null,
    aps,motion,sensorOk,wifiConnected:metaSeen?wifiConnected:true,batteryVoltage,batteryPercent,
    motionState:sensorOk?(motion?'moving':'stationary'):'unavailable',
    sensorStatus:sensorOk?'ok':'unavailable',deviceId,legacy:true
  };
}

function parsePayload(text, deviceId) {
  const content=String(text).trim();
  if (!content.startsWith('{')) return parseLegacyPayload(content,deviceId);
  let payload;
  try { payload=JSON.parse(content); } catch { return null; }
  if (!payload || payload.schemaVersion!==1 ||
      typeof payload.scanId!=='string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(payload.scanId) ||
      !Number.isSafeInteger(payload.sequence) || payload.sequence<0 ||
      !Number.isSafeInteger(payload.deviceTimestampMs) || payload.deviceTimestampMs<0 ||
      (payload.deviceId!==undefined &&
        (typeof payload.deviceId!=='string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(payload.deviceId) || payload.deviceId!==deviceId)) ||
      typeof payload.wifiConnected!=='boolean' ||
      !['moving','stationary','unavailable'].includes(payload.motionState) ||
      !['ok','unavailable','error'].includes(payload.sensorStatus) ||
      !Array.isArray(payload.observations) || payload.observations.length>100) return null;
  const aps=[];
  for (const observation of payload.observations) {
    if (!observation || typeof observation.bssid!=='string' ||
        !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(observation.bssid) ||
        !Number.isInteger(observation.rssi) || observation.rssi < -127 || observation.rssi > 0 ||
        (observation.channel!==null && observation.channel!==undefined &&
          (!Number.isInteger(observation.channel)||observation.channel<1||observation.channel>196)) ||
        (observation.ssid!==undefined && typeof observation.ssid!=='string')) return null;
    aps.push({
      bssid:observation.bssid.toLowerCase(),
      ssid:String(observation.ssid||'(hidden)').slice(0,32),
      rssi:observation.rssi,
      channel:Number.isInteger(observation.channel)?observation.channel:null
    });
  }
  const optionalNumber=(value,min,max)=>value===null||value===undefined||
    (typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max);
  if (!optionalNumber(payload.batteryVoltage,0,10) || !optionalNumber(payload.batteryPercent,0,100) ||
      (payload.firmwareVersion!==undefined && typeof payload.firmwareVersion!=='string')) return null;
  return {
    scanId:payload.scanId,sequence:payload.sequence,deviceTimestampMs:payload.deviceTimestampMs,
    firmwareVersion:String(payload.firmwareVersion||'').slice(0,80),aps,
    motion:payload.motionState==='moving',sensorOk:payload.sensorStatus==='ok',
    wifiConnected:payload.wifiConnected,batteryVoltage:payload.batteryVoltage??null,
    batteryPercent:payload.batteryPercent??null,motionState:payload.motionState,
    sensorStatus:payload.sensorStatus,deviceId,legacy:false
  };
}

async function processPayload(text, sourceIp, deviceId='tracksense-001') {
  const parsed=parsePayload(text,deviceId);
  if (!parsed) return {ok:false,reason:'invalid_telemetry_payload'};
  const dedupeKey=`${deviceId}:${parsed.scanId}`;
  if ((!pool||!dbReady)&&processedScanIds.has(dedupeKey)) {
    return {ok:true,duplicate:true,observations:0,scanId:parsed.scanId};
  }
  const at=new Date().toISOString();
  const wifiConnected=parsed.wifiConnected;
  const scanLocation=estimateLocation(parsed.aps);
  const roomName=state.rooms.find(room=>room.id===scanLocation.roomId)?.name||'Unknown / not calibrated';
  const records=parsed.aps.map(a=>{
    const signal=state.signals.find(item=>item.bssid.toLowerCase()===a.bssid.toLowerCase());
    const signalRoomName=state.rooms.find(room=>room.id===signal?.roomId)?.name||'Not assigned';
    return {timestamp:at,scanId:parsed.scanId,sequence:parsed.sequence,deviceTimestampMs:parsed.deviceTimestampMs,
      firmwareVersion:parsed.firmwareVersion,deviceId,deviceIp:sourceIp,wifiConnected,motion:parsed.motion,
      motionSensor:parsed.sensorOk,batteryVoltage:parsed.batteryVoltage,batteryPercent:parsed.batteryPercent,
      roomName,signalRoomName,...a};
  });
  if (pool && dbReady) {
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO devices(device_id,last_seen,last_ip,motion,sensor_ok,wifi_connected,battery_voltage,battery_percent)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(device_id) DO UPDATE SET last_seen=EXCLUDED.last_seen,last_ip=EXCLUDED.last_ip,
        motion=EXCLUDED.motion,sensor_ok=EXCLUDED.sensor_ok,wifi_connected=EXCLUDED.wifi_connected,
        battery_voltage=EXCLUDED.battery_voltage,battery_percent=EXCLUDED.battery_percent`,
      [deviceId,at,sourceIp,parsed.motion,parsed.sensorOk,wifiConnected,parsed.batteryVoltage,parsed.batteryPercent]);
      const inserted=await client.query(`INSERT INTO telemetry_scans(device_id,scan_id,sequence,device_timestamp_ms,
        firmware_version,received_at,motion_state,sensor_status,wifi_connected,battery_voltage,battery_percent,source_ip)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT(device_id,scan_id) DO NOTHING RETURNING scan_id`,
      [deviceId,parsed.scanId,parsed.sequence,parsed.deviceTimestampMs,parsed.firmwareVersion,at,parsed.motionState,
        parsed.sensorStatus,wifiConnected,parsed.batteryVoltage,parsed.batteryPercent,sourceIp]);
      if (!inserted.rowCount) {
        await client.query('ROLLBACK');
        return {ok:true,duplicate:true,observations:0,scanId:parsed.scanId};
      }
      for (const record of records) await client.query(`INSERT INTO scan_observations(device_id,observed_at,bssid,ssid,rssi_dbm,
        channel,motion,sensor_ok,wifi_connected,battery_voltage,battery_percent,source_ip,room_name,signal_room_name,
        scan_id,sequence,device_timestamp_ms,firmware_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [deviceId,at,record.bssid,record.ssid,record.rssi,record.channel,parsed.motion,parsed.sensorOk,wifiConnected,
        parsed.batteryVoltage,parsed.batteryPercent,sourceIp,roomName,record.signalRoomName,parsed.scanId,
        parsed.sequence,parsed.deviceTimestampMs,parsed.firmwareVersion]);
      await client.query('COMMIT');
    } catch(e) {
      try { await client.query('ROLLBACK'); } catch(rollbackError) { console.error('Database scan rollback failed:',rollbackError.message); }
      console.error('Database scan insert failed:',e.message);
      throw e;
    } finally { client.release(); }
  }
  processedScanIds.add(dedupeKey);
  state.processedScanIds.push(dedupeKey);
  if(state.processedScanIds.length>MAX_RECENT_SCAN_IDS) {
    const removed=state.processedScanIds.splice(0,state.processedScanIds.length-MAX_RECENT_SCAN_IDS);
    removed.forEach(id=>processedScanIds.delete(id));
  }
  state.deviceId=deviceId; state.deviceIp=sourceIp||state.deviceIp; state.lastPacketAt=at;
  state.motion=parsed.motion; state.motionSensor=parsed.sensorOk; state.wifiConnected=wifiConnected;
  state.batteryVoltage=parsed.batteryVoltage; state.batteryPercent=parsed.batteryPercent;
  state.aps=Object.fromEntries(parsed.aps.map(a=>[a.bssid,{...a,lastSeen:at}]));
  state.history.push({at,strongestRssi:parsed.aps.length?Math.max(...parsed.aps.map(a=>a.rssi)):null,
    apCount:parsed.aps.length,motion:parsed.motion});
  if(state.history.length>MAX_MEMORY_HISTORY)state.history=state.history.slice(-MAX_MEMORY_HISTORY);
  if (records.length) {
    try { fs.appendFileSync(SCAN_LOG,records.map(r=>JSON.stringify(r)).join('\n')+'\n','utf8'); }
    catch(e) { console.error('Scan JSONL log write failed:',e.message); }
    try { appendScanCsv(records); }
    catch(e) { console.error('Scan CSV archive update failed:',e.message); }
  }
  publish();
  return {ok:true,duplicate:false,observations:records.length,scanId:parsed.scanId,at};
}

app.use(express.json({limit:'256kb'}));
app.use(express.text({type:['text/plain','application/octet-stream','application/x-www-form-urlencoded'],limit:'16kb'}));
function getPayloadBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') {
    if (req.body.schemaVersion === 1) return JSON.stringify(req.body);
    if (typeof req.body.payload === 'string') return req.body.payload;
    const values = Object.values(req.body);
    if (values.length === 1 && typeof values[0] === 'string') return values[0];
  }
  return '';
}
function constantTimeStringEqual(supplied, expected) {
  const actualBuffer = Buffer.from(String(supplied || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));
  return actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

app.use(express.static(path.join(__dirname,'public')));
app.get('/health',(_req,res)=>res.json({ok:true,storage:dbReady?'postgresql':pool?'postgresql-connecting':'local-jsonl',time:new Date().toISOString()}));
app.get('/api/state',(_req,res)=>res.json(publicState()));
function roomById(id) { return state.rooms.find(room => room.id === id); }
function validRoomPoint(room, x, y) {
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= room.widthM && y <= room.heightM;
}
app.post('/api/rooms',async(req,res)=>{
  const name=String(req.body?.name||'').trim().slice(0,80);
  const widthM=Number(req.body?.widthM),heightM=Number(req.body?.heightM);
  if(!name||!Number.isFinite(widthM)||!Number.isFinite(heightM)||widthM<=0||heightM<=0||widthM>1000||heightM>1000) return res.status(400).json({error:'Room name and positive dimensions in meters (up to 1000 m) are required.'});
  const room={id:crypto.randomUUID(),name,widthM,heightM};
  try {
    if(pool&&dbReady) await pool.query('INSERT INTO rooms(id,name,width_m,height_m) VALUES($1,$2,$3,$4)',[room.id,room.name,room.widthM,room.heightM]);
    state.rooms.push(room); publish(); res.json({ok:true,room});
  } catch(e) { console.error('Room save failed:',e.message); res.status(500).json({error:'Room could not be saved'}); }
});
app.delete('/api/rooms/:id',async(req,res)=>{
  const room=roomById(req.params.id);
  if(!room) return res.status(404).json({error:'Room not found'});
  try {
    if(pool&&dbReady) {
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE signal_config SET room_id=NULL WHERE room_id=$1',[room.id]);
        await client.query('UPDATE fingerprints SET room_id=NULL WHERE room_id=$1',[room.id]);
        await client.query('DELETE FROM rooms WHERE id=$1',[room.id]);
        await client.query('COMMIT');
      } catch(e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    }
    state.signals=state.signals.map(signal=>signal.roomId===room.id?{...signal,roomId:null}:signal);
    state.fingerprints=state.fingerprints.map(fp=>fp.roomId===room.id?{...fp,roomId:null}:fp);
    state.rooms=state.rooms.filter(item=>item.id!==room.id); publish(); res.json({ok:true});
  } catch(e) { console.error('Room delete failed:',e.message); res.status(500).json({error:'Room could not be deleted'}); }
});
app.post('/api/telemetry/raw',async(req,res)=>{
  if(!DEVICE_API_KEY || !constantTimeStringEqual(req.get('x-device-key'), DEVICE_API_KEY)) return res.status(401).json({error:'Invalid or unconfigured device key'});
  let text=getPayloadBody(req);
  if (!text && !req.readableEnded) {
    try {
      const chunks=[];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
      text=Buffer.concat(chunks).toString('utf8');
    } catch (e) {
      console.error('Telemetry body stream failed:', e.message);
      return res.status(400).json({error:'Payload body could not be read'});
    }
  }
  const deviceId=String(req.get('x-device-id')||'tracksense-001');
  if(!/^[A-Za-z0-9._:-]{1,80}$/.test(deviceId))return res.status(400).json({error:'Device ID contains unsupported characters.'});
  try { const result=await processPayload(text,req.ip,deviceId); if(!result.ok)return res.status(400).json({error:'Payload contained no valid scan data'}); res.json(result); }
  catch(e){console.error('Telemetry route failed:',e.message);res.status(500).json({error:'Telemetry could not be stored'});}
});
app.post('/api/signals',async(req,res)=>{
  const {bssid,label,x,y,txPower,pathLoss,roomId}=req.body||{}; if(!bssid||!label)return res.status(400).json({error:'BSSID and label are required'});
  const bssidValue=String(bssid).toLowerCase().trim();
  if(!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(bssidValue))return res.status(400).json({error:'BSSID must be a six-byte MAC address.'});
  const room=roomId?roomById(String(roomId)):null;
  if(roomId&&!room)return res.status(400).json({error:'Selected room does not exist.'});
  const hasX=x!==undefined&&x!==null&&x!=='';
  const hasY=y!==undefined&&y!==null&&y!=='';
  if(hasX!==hasY)return res.status(400).json({error:'Enter both signal coordinates, or leave both blank.'});
  const hasPoint=hasX&&hasY;
  const pointX=hasPoint?Number(x):null,pointY=hasPoint?Number(y):null;
  if(hasPoint&&(!room||!validRoomPoint(room,pointX,pointY)))return res.status(400).json({error:'Signal coordinates must be within the selected room, in meters.'});
  const parsedTx=Number(txPower),parsedPathLoss=Number(pathLoss);
  const item={bssid:bssidValue,label:String(label).trim().slice(0,80),x:pointX,y:pointY,txPower:Number.isFinite(parsedTx)?parsedTx:-59,pathLoss:Number.isFinite(parsedPathLoss)&&parsedPathLoss>0?parsedPathLoss:2.2,roomId:room?.id||null};
  try {
    if(pool&&dbReady)await pool.query(`INSERT INTO signal_config(bssid,label,x,y,tx_power,path_loss,room_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(bssid) DO UPDATE SET label=EXCLUDED.label,x=EXCLUDED.x,y=EXCLUDED.y,tx_power=EXCLUDED.tx_power,path_loss=EXCLUDED.path_loss,room_id=EXCLUDED.room_id`,[item.bssid,item.label,item.x,item.y,item.txPower,item.pathLoss,item.roomId]);
    const i=state.signals.findIndex(s=>s.bssid===item.bssid); if(i>=0)state.signals[i]=item;else state.signals.push(item);
    publish();res.json({ok:true,signal:item});
  } catch(e) { console.error('Signal save failed:',e.message); res.status(500).json({error:'Wi-Fi signal could not be saved'}); }
});
app.delete('/api/signals/:bssid',async(req,res)=>{
  const bssid=req.params.bssid.toLowerCase();
  try {
    if(pool&&dbReady)await pool.query('DELETE FROM signal_config WHERE bssid=$1',[bssid]);
    state.signals=state.signals.filter(s=>s.bssid!==bssid);publish();res.json({ok:true});
  } catch(e) { console.error('Signal delete failed:',e.message); res.status(500).json({error:'Wi-Fi signal could not be deleted'}); }
});
app.post('/api/fingerprints',async(req,res)=>{
  const {label,x,y,roomId}=req.body||{}; if(!label||!Object.keys(state.aps).length)return res.status(400).json({error:'Wait for a live scan and enter a location label.'});
  const room=roomById(String(roomId||''));
  const pointX=Number(x),pointY=Number(y);
  if(!room||!validRoomPoint(room,pointX,pointY))return res.status(400).json({error:'Choose a room and valid X/Y coordinates in meters within that room.'});
  const fp={id:crypto.randomUUID(),label:String(label).trim().slice(0,80),x:pointX,y:pointY,roomId:room.id,rssi:Object.fromEntries(Object.values(state.aps).map(a=>[a.bssid,a.rssi])),updatedAt:new Date().toISOString()};
  try {
    if(pool&&dbReady)await pool.query('INSERT INTO fingerprints(id,label,x,y,rssi,room_id,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[fp.id,fp.label,fp.x,fp.y,JSON.stringify(fp.rssi),fp.roomId,fp.updatedAt]);
    state.fingerprints.push(fp);publish();res.json({ok:true,fingerprint:{id:fp.id,label:fp.label,x:fp.x,y:fp.y,roomId:fp.roomId}});
  } catch(e) { console.error('Fingerprint save failed:',e.message); res.status(500).json({error:'Fingerprint could not be saved'}); }
});
app.delete('/api/fingerprints/:id',async(req,res)=>{
  try {
    if(pool&&dbReady)await pool.query('DELETE FROM fingerprints WHERE id=$1',[req.params.id]);
    state.fingerprints=state.fingerprints.filter(f=>f.id!==req.params.id);publish();res.json({ok:true});
  } catch(e) { console.error('Fingerprint delete failed:',e.message); res.status(500).json({error:'Fingerprint could not be deleted'}); }
});
function scanDateRange(req,res) {
  const parseBound=(value,name)=>{
    if(value===undefined)return null;
    if(typeof value!=='string'||!value.trim()) {
      res.status(400).json({error:`${name} must be a valid date and time.`});
      return NaN;
    }
    const timestamp=Date.parse(value);
    if(!Number.isFinite(timestamp)) {
      res.status(400).json({error:`${name} must be a valid date and time.`});
      return NaN;
    }
    return new Date(timestamp).toISOString();
  };
  const from=parseBound(req.query.from,'Start time');
  if(Number.isNaN(from))return null;
  const to=parseBound(req.query.to,'End time');
  if(Number.isNaN(to))return null;
  if(from&&to&&Date.parse(from)>Date.parse(to)) {
    res.status(400).json({error:'Start time must be before or equal to end time.'});
    return null;
  }
  return {from,to};
}
async function readScanRecords(range,limit) {
  if(pool&&dbReady) {
    const parameters=[range.from,range.to];
    const where='WHERE ($1::timestamptz IS NULL OR observed_at >= $1) AND ($2::timestamptz IS NULL OR observed_at <= $2)';
    const count=await pool.query(`SELECT COUNT(*)::bigint AS total FROM scan_observations ${where}`,parameters);
    let query=`SELECT observed_at AS timestamp,device_id AS "deviceId",source_ip AS "deviceIp",motion,sensor_ok AS "motionSensor",wifi_connected AS "wifiConnected",battery_voltage AS "batteryVoltage",battery_percent AS "batteryPercent",bssid,ssid,rssi_dbm AS rssi,channel,room_name AS "roomName",signal_room_name AS "signalRoomName",scan_id AS "scanId",sequence,device_timestamp_ms AS "deviceTimestampMs",firmware_version AS "firmwareVersion" FROM scan_observations ${where} ORDER BY observed_at DESC,id DESC`;
    if(limit!==null) {
      parameters.push(limit);
      query+=' LIMIT $3';
    }
    const result=await pool.query(query,parameters);
    return {scans:enrichScanRooms(result.rows).map(row=>({...row,distanceM:distanceMeters(row.bssid,row.rssi)})),total:Number(count.rows[0].total),storage:'postgresql'};
  }
  if(!fs.existsSync(SCAN_LOG))return {scans:[],total:0,storage:'local-jsonl'};
  const from=range.from?Date.parse(range.from):null;
  const to=range.to?Date.parse(range.to):null;
  const matching=fs.readFileSync(SCAN_LOG,'utf8').split(/\r?\n/).filter(Boolean).map(line=>{
    try{return JSON.parse(line)}catch{return null}
  }).filter(row=>{
    if(!row)return false;
    const timestamp=Date.parse(row.timestamp||row.observed_at);
    return Number.isFinite(timestamp)&&(from===null||timestamp>=from)&&(to===null||timestamp<=to);
  });
  matching.reverse();
  const selected=limit===null?matching:matching.slice(0,limit);
  return {scans:enrichScanRooms(selected).map(row=>({...row,distanceM:distanceMeters(row.bssid,row.rssi??row.rssi_dbm)})),total:matching.length,storage:'local-jsonl'};
}
app.get('/api/scans',async(req,res)=>{
  const limit=Math.min(10000,Math.max(1,Number(req.query.limit)||500));
  const range=scanDateRange(req,res);
  if(!range)return;
  try {
    res.json(await readScanRecords(range,limit));
  }catch(e){console.error('Scan query failed:',e.message);res.status(500).json({error:'Could not read scan history'});}
});
app.get('/api/export.csv',async(req,res)=>{
  const range=scanDateRange(req,res);
  if(!range)return;
  try {
    const result=await readScanRecords(range,null);
    const rows=[CSV_HEADER,...result.scans.reverse().map(scanCsvRow)];
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition','attachment; filename="tracksense_scan_history.csv"');
    res.send(rows.map(r=>r.map(csvCell).join(',')).join('\r\n'));
  }catch(e){console.error('Export failed:',e.message);res.status(500).send('Could not export scan history');}
});
app.get('/api/metrics',async(_req,res)=>{try{if(pool&&dbReady){const r=await pool.query(`SELECT COUNT(*)::bigint total,COUNT(DISTINCT bssid)::int aps,COUNT(DISTINCT device_id)::int devices,MIN(observed_at) first_seen,MAX(observed_at) last_seen FROM scan_observations`);return res.json({...r.rows[0],storage:'postgresql'});}const n=fs.existsSync(SCAN_LOG)?fs.readFileSync(SCAN_LOG,'utf8').split(/\r?\n/).filter(Boolean).length:0;res.json({total:n,aps:new Set(Object.keys(state.aps)).size,devices:state.lastPacketAt?1:0,first_seen:null,last_seen:state.lastPacketAt,storage:'local-jsonl'});}catch(e){res.status(500).json({error:'Metrics unavailable'});}});

const udp=dgram.createSocket('udp4');
udp.on('error',err=>console.error('UDP receiver error:',err.message));
udp.on('message',(msg,rinfo)=>{
  const text=msg.toString('utf8');
  let deviceId='tracksense-001';
  if(text.trimStart().startsWith('{')) {
    try {
      const payload=JSON.parse(text);
      if(typeof payload.deviceId==='string'&&/^[A-Za-z0-9._:-]{1,80}$/.test(payload.deviceId))deviceId=payload.deviceId;
    } catch { /* The payload validator reports malformed telemetry on processing. */ }
  }
  processPayload(text,rinfo.address,deviceId).catch(e=>console.error('UDP processing failed:',e.message));
});
udp.bind(UDP_PORT,'0.0.0.0',()=>console.log(`Local UDP telemetry listening on 0.0.0.0:${UDP_PORT}`));
(async()=>{try{await initDb();server.listen(HTTP_PORT,'0.0.0.0',()=>console.log(`TrackSense dashboard listening on port ${HTTP_PORT}`));}catch(e){console.error('Database initialization failed:',e.message);process.exit(1);}})();
