const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { EcgCleaner } = require('./ecg_filter');

// Measured hardware rate is ~497 SPS (see [Serial Stats]); override with ECG_FS if needed
const ecgCleaner = new EcgCleaner(parseFloat(process.env.ECG_FS) || 497);

const EDGE_PORT = process.env.EDGE_PORT || 3001;
const CLOUD_WS_URL = process.env.CLOUD_WS_URL || 'ws://localhost:3000';
const CLOUD_HTTP_URL = process.env.CLOUD_HTTP_URL || CLOUD_WS_URL.replace('wss://', 'https://').replace('ws://', 'http://');
const DEVICE_ID = process.env.DEVICE_ID || 'esp32-max30001-edge';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());

// Port 3001 is the Local Hardware Admin Viewer
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// Global state
let currentPortPath = '/dev/cu.usbserial-02E4CA0A';
let activePort = null;
let activeParser = null;
let serialConnected = false;
let lastSerialDataTime = 0;
let synthArrhythmiaMode = true;
let isCloudRecording = false;
let recordingStartTime = 0;

let latestTelemetry = {
  ecg: 0.0,
  bioz: 0.0,
  hr: 0,
  rr: 0,
  lead_off: false,
  timestamp: Date.now(),
  source: 'offline',
  pvc_mode: synthArrhythmiaMode
};

// =============================================================================
// Local WebSocket Server (Serves admin.html on port 3001)
// =============================================================================
function broadcastLocal(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify(latestTelemetry));

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'ble_telemetry') {
        handleTelemetryPacket({
          ecg: data.ecg || 0.0,
          bioz: 0.0,
          hr: data.hr || 0,
          rr: data.rr || 0,
          lead_off: !!data.lead_off,
          timestamp: Date.now(),
          source: 'Web-BLE Wireless'
        });
      } else if (data.type === 'toggle_pvc_mode') {
        synthArrhythmiaMode = !synthArrhythmiaMode;
        latestTelemetry.pvc_mode = synthArrhythmiaMode;
        broadcastLocal(latestTelemetry);
        if (cloudWs && cloudWs.readyState === WebSocket.OPEN) {
          cloudWs.send(JSON.stringify({ type: 'toggle_pvc_mode' }));
        }
      }
    } catch (e) {}
  });
});

// Central dispatcher for both local clients and cloud uplink
function handleTelemetryPacket(packet) {
  packet.is_recording = isCloudRecording;
  if (isCloudRecording && recordingStartTime > 0) {
    packet.recording_duration_sec = Math.floor((Date.now() - recordingStartTime) / 1000);
  } else {
    packet.recording_duration_sec = 0;
  }
  latestTelemetry = packet;
  broadcastLocal(packet);
  sendTelemetryToCloud(packet);
}

// =============================================================================
// Cloud Uplink (WebSocket Client)
// =============================================================================
let cloudWs = null;
let isCloudConnected = false;
let reconnectTimer = null;

function connectToCloud() {
  if (cloudWs) {
    try { cloudWs.terminate(); } catch (e) {}
  }

  console.log(`[Edge Uplink] Connecting to Cloud Hub at ${CLOUD_WS_URL}...`);
  try {
    cloudWs = new WebSocket(CLOUD_WS_URL);
  } catch (err) {
    console.error(`[Edge Uplink] Connection error: ${err.message}`);
    scheduleCloudReconnect();
    return;
  }

  cloudWs.on('open', () => {
    isCloudConnected = true;
    console.log(`[Edge Uplink] Connected to Cloud Hub! Registering as ${DEVICE_ID}...`);

    cloudWs.send(JSON.stringify({
      type: 'edge_handshake',
      deviceId: DEVICE_ID,
      port: currentPortPath,
      source: serialConnected ? `Hardware (${currentPortPath})` : 'Edge Synthetic Generator'
    }));
  });

  cloudWs.on('message', (msg) => {
    try {
      const cmd = JSON.parse(msg);
      if (cmd.type === 'toggle_pvc_mode') {
        synthArrhythmiaMode = !synthArrhythmiaMode;
        latestTelemetry.pvc_mode = synthArrhythmiaMode;
        broadcastLocal(latestTelemetry);
        console.log(`[Edge] Cloud commanded PVC mode toggle: ${synthArrhythmiaMode ? 'ON' : 'OFF'}`);
      } else if (cmd.type === 'start_recording') {
        isCloudRecording = true;
        recordingStartTime = Date.now();
        latestTelemetry.is_recording = true;
        latestTelemetry.recording_duration_sec = 0;
        broadcastLocal(latestTelemetry);
        console.log(`[Edge] Cloud recording started: ${cmd.title}`);
      } else if (cmd.type === 'stop_recording') {
        isCloudRecording = false;
        recordingStartTime = 0;
        latestTelemetry.is_recording = false;
        latestTelemetry.recording_duration_sec = 0;
        broadcastLocal(latestTelemetry);
        console.log(`[Edge] Cloud recording stopped.`);
      }
    } catch (e) {}
  });

  cloudWs.on('close', () => {
    if (isCloudConnected) {
      console.log('[Edge Uplink] Disconnected from Cloud Hub. Will reconnect...');
    }
    isCloudConnected = false;
    scheduleCloudReconnect();
  });

  cloudWs.on('error', (err) => {
    // Handled in close event
  });
}

function scheduleCloudReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectToCloud, 2500);
}

// Forward telemetry to cloud hub
function sendTelemetryToCloud(packet) {
  if (cloudWs && cloudWs.readyState === WebSocket.OPEN) {
    cloudWs.send(JSON.stringify({
      type: 'edge_telemetry',
      deviceId: DEVICE_ID,
      port: currentPortPath,
      data: packet
    }));
  }
}

// Heartbeat to cloud
setInterval(() => {
  if (cloudWs && cloudWs.readyState === WebSocket.OPEN) {
    cloudWs.send(JSON.stringify({ type: 'edge_heartbeat', deviceId: DEVICE_ID }));
  }
}, 2000);

// =============================================================================
// Serial Port Hardware Manager
// =============================================================================
async function findBestPort() {
  try {
    const ports = await SerialPort.list();
    console.log('[Serial/BT] Available system ports:', ports.map(p => p.path));

    let selectedPath = '';

    // Priority 1: Bluetooth SPP device
    let match = ports.find(p => p.path.toLowerCase().includes('esp32') || p.path.toLowerCase().includes('spp'));
    if (match) selectedPath = match.path;

    // Priority 2: USB Serial device
    if (!selectedPath) {
      match = ports.find(p => p.path.toLowerCase().includes('usbserial') || p.path.toLowerCase().includes('usbmodem'));
      if (match) selectedPath = match.path;
    }

    if (!selectedPath) selectedPath = '/dev/cu.usbserial-02E4CA0A';

    if (selectedPath.startsWith('/dev/tty.')) {
      selectedPath = selectedPath.replace('/dev/tty.', '/dev/cu.');
    }

    return selectedPath;
  } catch (err) {
    return '/dev/cu.usbserial-02E4CA0A';
  }
}

async function initSerialOrBluetoothPort(targetPath) {
  if (activePort && activePort.isOpen) {
    try { activePort.close(); } catch (e) {}
  }

  let portPath = targetPath || await findBestPort();
  if (portPath.startsWith('/dev/tty.')) {
    portPath = portPath.replace('/dev/tty.', '/dev/cu.');
  }

  currentPortPath = portPath;
  console.log(`[Serial/BT] Opening call-out port: ${portPath}...`);

  activePort = new SerialPort({
    path: portPath,
    baudRate: 921600,
    autoOpen: false
  });

  activeParser = activePort.pipe(new ReadlineParser({ delimiter: '\n' }));

  activePort.open((err) => {
    if (err) {
      console.log(`[Serial/BT] Port notice (${portPath}): ${err.message}. Retrying in 3s...`);
      serialConnected = false;
      setTimeout(() => initSerialOrBluetoothPort(), 3000);
      return;
    }
    console.log(`[Serial/BT] Successfully opened ${portPath} (capturing ECG telemetry...)`);
  });

  let serialLineCount = 0;
  setInterval(() => {
    if (serialConnected) {
      console.log(`[Serial Stats] ECG throughput: ${serialLineCount} lines/sec`);
      serialLineCount = 0;
    }
  }, 1000);

  activeParser.on('data', (line) => {
    serialLineCount++;
    line = line.trim();
    if (line.includes('ECG:')) {
      lastSerialDataTime = Date.now();
      serialConnected = true;
      const parts = line.split('|');
      let ecg = latestTelemetry.ecg;
      let hr = latestTelemetry.hr;
      let rr = latestTelemetry.rr;
      let lead_off = false;

      for (let part of parts) {
        part = part.trim();
        if (part.startsWith('ECG:')) {
          const val = parseFloat(part.replace('ECG:', '').replace('uV', '').trim());
          if (!isNaN(val)) ecg = val;
        } else if (part.startsWith('HR:')) {
          const val = parseInt(part.replace('HR:', '').replace('BPM', '').trim());
          if (!isNaN(val)) hr = val;
        } else if (part.startsWith('RR:')) {
          const val = parseInt(part.replace('RR:', '').replace('ms', '').trim());
          if (!isNaN(val)) rr = val;
        } else if (part.startsWith('Lead:')) {
          lead_off = part.includes('DISCONNECTED');
        }
      }

      if (!lead_off) ecg = ecgCleaner.process(ecg);
      else ecgCleaner.reset();

      handleTelemetryPacket({
        ecg,
        bioz: 0.0,
        hr,
        rr,
        lead_off,
        timestamp: Date.now(),
        source: portPath.includes('Bluetooth') || portPath.includes('ESP32') ? 'Bluetooth SPP' : 'USB Serial',
        pvc_mode: synthArrhythmiaMode
      });
    }
  });

  activePort.on('close', () => {
    console.log('[Serial/BT] Port closed. Reconnecting in 3s...');
    serialConnected = false;
    setTimeout(() => initSerialOrBluetoothPort(), 3000);
  });

  activePort.on('error', (err) => {
    console.log(`[Serial/BT] Error: ${err.message}`);
    serialConnected = false;
  });
}

// =============================================================================
// Calibrated 128 SPS Synthetic Fallback Generator (When cable unplugged)
// =============================================================================
let synthPhase = 0;
let beatCounter = 0;
const SAMPLES_PER_BEAT = 102;

setInterval(() => {
  const serialActive = serialConnected && (Date.now() - lastSerialDataTime < 2000);
  if (!serialActive) {
    synthPhase = (synthPhase + 1) % SAMPLES_PER_BEAT;
    const t = synthPhase / parseFloat(SAMPLES_PER_BEAT);
    let ecg = ((Math.random() * 8.0) - 4.0);

    const isPVCBeat = synthArrhythmiaMode && (beatCounter % 4 === 3);

    if (isPVCBeat) {
      if (t > 0.15 && t < 0.45) {
        ecg += 1650.0 * Math.sin((t - 0.15) / 0.30 * Math.PI);
      } else if (t > 0.45 && t < 0.75) {
        ecg -= 450.0 * Math.sin((t - 0.45) / 0.30 * Math.PI);
      }
    } else {
      if (t > 0.15 && t < 0.25) ecg += 140.0 * Math.sin((t - 0.15) / 0.10 * Math.PI);
      else if (t > 0.35 && t < 0.38) ecg -= 110.0 * Math.sin((t - 0.35) / 0.03 * Math.PI);
      else if (t > 0.38 && t < 0.44) ecg += 1250.0 * Math.sin((t - 0.38) / 0.06 * Math.PI);
      else if (t > 0.44 && t < 0.48) ecg -= 230.0 * Math.sin((t - 0.44) / 0.04 * Math.PI);
      else if (t > 0.65 && t < 0.82) ecg += 260.0 * Math.sin((t - 0.65) / 0.17 * Math.PI);
    }

    if (synthPhase === 0) beatCounter++;

    handleTelemetryPacket({
      ecg: parseFloat(ecg.toFixed(2)),
      bioz: 0.0,
      hr: isPVCBeat ? 104 : 75,
      rr: isPVCBeat ? 520 : 800,
      lead_off: false,
      timestamp: Date.now(),
      synthetic: true,
      source: synthArrhythmiaMode ? 'Edge Synthetic PVC' : 'Edge Synthetic Normal',
      pvc_mode: synthArrhythmiaMode
    });
  }
}, 8);

// =============================================================================
// Local Edge REST Endpoints (Local Admin Controls)
// =============================================================================
app.get('/api/ports', async (req, res) => {
  try {
    const ports = await SerialPort.list();
    res.json({
      ports,
      activePort: currentPortPath,
      connected: serialConnected,
      cloudUplink: isCloudConnected
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/connect-port', async (req, res) => {
  const { path: targetPath } = req.body;
  if (!targetPath) return res.status(400).json({ error: 'Port path required' });

  console.log(`[Edge Admin] Switching hardware port to: ${targetPath}`);
  await initSerialOrBluetoothPort(targetPath);
  res.json({ success: true, activePort: currentPortPath });
});

app.get('/api/edge/status', (req, res) => {
  res.json({
    edgePort: EDGE_PORT,
    deviceId: DEVICE_ID,
    hardwarePort: currentPortPath,
    serialConnected,
    cloudUplink: isCloudConnected,
    cloudWsUrl: CLOUD_WS_URL,
    lastSerialDataAgoMs: Date.now() - lastSerialDataTime
  });
});

// Proxy sessions, recordings, and AI requests from local admin panel to Cloud Hub
app.use(['/api/recordings', '/api/record', '/api/sessions', '/api/ai'], async (req, res) => {
  try {
    const targetUrl = `${CLOUD_HTTP_URL}${req.originalUrl}`;
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;

    const fetchOptions = {
      method: req.method,
      headers
    };

    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && Object.keys(req.body).length > 0) {
      headers['content-type'] = 'application/json';
      fetchOptions.body = JSON.stringify(req.body);
    }

    const cloudRes = await fetch(targetUrl, fetchOptions);
    const contentType = cloudRes.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const json = await cloudRes.json();
      res.status(cloudRes.status).json(json);
    } else {
      const text = await cloudRes.text();
      res.status(cloudRes.status).send(text);
    }
  } catch (err) {
    res.status(502).json({ error: 'Cloud Hub unreachable from Edge Gateway', details: err.message });
  }
});

// Start Edge Server
server.listen(EDGE_PORT, () => {
  console.log('===========================================================');
  console.log(`  MyoMate Local Edge Gateway`);
  console.log(`  Local Admin UI:  http://localhost:${EDGE_PORT}/admin.html`);
  console.log(`  Local WS Server: ws://localhost:${EDGE_PORT}`);
  console.log(`  Cloud Uplink:    ${CLOUD_WS_URL}`);
  console.log(`  Hardware Port:   ${currentPortPath}`);
  console.log('===========================================================');

  initSerialOrBluetoothPort();
  connectToCloud();
});
