const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:5005';
const DATA_DIR = path.join(__dirname, 'data');
const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings');
const INDEX_FILE = path.join(DATA_DIR, 'sessions.json');

// Ensure data storage directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
if (!fs.existsSync(INDEX_FILE)) fs.writeFileSync(INDEX_FILE, JSON.stringify([], null, 2));

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Increase JSON body limits for ECG session payloads
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Global state
let isRecording = false;
let activeSession = null; // { id, title, notes, startTime, samples: [], hrList: [] }

let latestTelemetry = {
  ecg: 0.0,
  bioz: 0.0,
  hr: 0,
  rr: 0,
  lead_off: false,
  timestamp: Date.now(),
  source: 'offline',
  is_recording: false,
  session_title: '',
  recording_duration_sec: 0,
  pvc_mode: true
};

// Edge Gateway tracking
const edgeSockets = new Set();
let edgeStatus = {
  connected: false,
  deviceId: null,
  activePort: null,
  source: 'No Edge Gateway Connected',
  lastSeen: 0
};

// Broadcast to connected web browser viewers
function broadcastToViewers(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    // Only send to non-edge clients (viewers)
    if (!edgeSockets.has(client) && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// Forward commands down to connected edge gateway(s)
function sendToEdge(commandObj) {
  const payload = JSON.stringify(commandObj);
  edgeSockets.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// Ingest incoming telemetry packet (from Edge Gateway or Web-BLE)
function processTelemetryUpdate(packet) {
  latestTelemetry = {
    ...packet,
    is_recording: isRecording,
    session_title: isRecording && activeSession ? activeSession.title : '',
    recording_duration_sec: isRecording && activeSession ? Math.floor((Date.now() - activeSession.startTime) / 1000) : 0,
    edge_connected: edgeStatus.connected,
    edge_port: edgeStatus.activePort
  };

  if (isRecording && activeSession) {
    activeSession.samples.push({
      t: packet.timestamp || Date.now(),
      ecg: packet.ecg,
      hr: packet.hr,
      rr: packet.rr,
      lead_off: packet.lead_off
    });

    if (packet.hr && packet.hr >= 30 && packet.hr <= 220) {
      activeSession.hrList.push(packet.hr);
    }

    // Only stream real-time data packets to remote viewers while recording is active
    broadcastToViewers(latestTelemetry);
  }
}

// Periodically check edge gateway liveness
setInterval(() => {
  if (edgeStatus.connected && Date.now() - edgeStatus.lastSeen > 5000) {
    console.log('[Cloud] Edge Gateway heartbeat timed out (>5s)');
    edgeStatus.connected = false;
    edgeStatus.source = 'Offline (Edge Disconnected)';
    latestTelemetry.source = 'offline';
    broadcastToViewers({
      type: 'edge_status',
      ...edgeStatus
    });
  }
}, 2000);

// =============================================================================
// WebSocket Multiplexing Handler
// =============================================================================
wss.on('connection', (ws, req) => {
  // Send current state to newly connected client
  ws.send(JSON.stringify({
    ...(isRecording ? latestTelemetry : { ecg: 0.0, bioz: 0.0, hr: 0, rr: 0, lead_off: false, source: 'idle' }),
    type: 'init_state',
    is_recording: isRecording,
    session_title: isRecording && activeSession ? activeSession.title : '',
    recording_duration_sec: isRecording && activeSession ? Math.floor((Date.now() - activeSession.startTime) / 1000) : 0,
    edge_status: edgeStatus
  }));

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);

      // --- Messages from Edge Gateway ---
      if (data.type === 'edge_handshake') {
        edgeSockets.add(ws);
        edgeStatus.connected = true;
        edgeStatus.deviceId = data.deviceId || 'esp32-edge-01';
        edgeStatus.activePort = data.port || 'Unknown';
        edgeStatus.source = data.source || 'Edge Hardware Gateway';
        edgeStatus.lastSeen = Date.now();
        console.log(`[Cloud] Edge Gateway registered! Device: ${edgeStatus.deviceId}, Port: ${edgeStatus.activePort}`);

        broadcastToViewers({
          type: 'edge_status',
          ...edgeStatus
        });
        return;
      }

      if (data.type === 'edge_heartbeat') {
        edgeStatus.lastSeen = Date.now();
        return;
      }

      if (data.type === 'edge_telemetry') {
        edgeSockets.add(ws); // Ensure marked as edge
        edgeStatus.connected = true;
        edgeStatus.lastSeen = Date.now();
        if (data.port) edgeStatus.activePort = data.port;
        if (data.data && data.data.source) edgeStatus.source = data.data.source;
        processTelemetryUpdate(data.data);
        return;
      }

      // --- Messages from Web Browser Viewers ---
      if (data.type === 'ble_telemetry') {
        processTelemetryUpdate({
          ecg: data.ecg || 0.0,
          bioz: 0.0,
          hr: data.hr || 0,
          rr: data.rr || 0,
          lead_off: !!data.lead_off,
          timestamp: Date.now(),
          source: 'Web-BLE Wireless'
        });
      } else if (data.type === 'toggle_pvc_mode') {
        // Forward toggle to edge server
        sendToEdge({ type: 'toggle_pvc_mode' });
      } else if (data.type === 'start_recording') {
        handleStartRecording(data.title, data.notes);
      } else if (data.type === 'stop_recording') {
        handleStopRecording();
      }
    } catch (e) {
      console.error('[Cloud WS] Error processing message:', e.message);
    }
  });

  ws.on('close', () => {
    if (edgeSockets.has(ws)) {
      edgeSockets.delete(ws);
      if (edgeSockets.size === 0) {
        edgeStatus.connected = false;
        edgeStatus.source = 'Offline (Edge Disconnected)';
        console.log('[Cloud] Edge Gateway connection closed.');
        broadcastToViewers({
          type: 'edge_status',
          ...edgeStatus
        });
      }
    }
  });
});

// =============================================================================
// Recording Logic Helpers
// =============================================================================
function getSessionsIndex() {
  try {
    if (fs.existsSync(INDEX_FILE)) {
      return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    }
  } catch (e) {}
  return [];
}

function saveSessionsIndex(sessions) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(sessions, null, 2));
}

function handleStartRecording(title, notes) {
  if (isRecording) return activeSession;

  const defaultTitle = latestTelemetry.pvc_mode ? 'PVC Arrhythmia Session' : 'Normal Sinus Rhythm';
  const sessionTitle = title && title.trim() ? title.trim() : `${defaultTitle} ${new Date().toLocaleTimeString()}`;
  activeSession = {
    id: `rec_${Date.now()}`,
    title: sessionTitle,
    notes: notes || '',
    startTime: Date.now(),
    samples: [],
    hrList: []
  };
  isRecording = true;
  console.log(`[Cloud Recording] Started session: "${sessionTitle}" (${activeSession.id})`);

  // Inform edge device if needed
  sendToEdge({ type: 'start_recording', title: sessionTitle, notes });

  processTelemetryUpdate(latestTelemetry);
  return activeSession;
}

function handleStopRecording() {
  if (!isRecording || !activeSession) return null;

  const endTime = Date.now();
  const durationSec = Math.max(1, Math.floor((endTime - activeSession.startTime) / 1000));
  const hrList = activeSession.hrList;

  const avgHR = hrList.length > 0 ? Math.round(hrList.reduce((a, b) => a + b, 0) / hrList.length) : 0;
  const minHR = hrList.length > 0 ? Math.min(...hrList) : 0;
  const maxHR = hrList.length > 0 ? Math.max(...hrList) : 0;

  const sessionMeta = {
    id: activeSession.id,
    title: activeSession.title,
    notes: activeSession.notes,
    startTime: activeSession.startTime,
    endTime: endTime,
    durationSec: durationSec,
    sampleCount: activeSession.samples.length,
    avgHR: avgHR,
    minHR: minHR,
    maxHR: maxHR
  };

  const sessionFile = path.join(RECORDINGS_DIR, `${activeSession.id}.json`);
  fs.writeFileSync(sessionFile, JSON.stringify({ meta: sessionMeta, samples: activeSession.samples }, null, 2));

  const sessions = getSessionsIndex();
  sessions.unshift(sessionMeta);
  saveSessionsIndex(sessions);

  console.log(`[Cloud Recording] Saved session: "${sessionMeta.title}" (${sessionMeta.sampleCount} samples, ${durationSec}s)`);

  const stopped = activeSession;
  isRecording = false;
  activeSession = null;

  // Inform edge device
  sendToEdge({ type: 'stop_recording' });

  // Inform remote viewers that stream is idle (waiting for next recorded session)
  broadcastToViewers({
    type: 'recording_status',
    is_recording: false,
    session_title: '',
    recording_duration_sec: 0,
    edge_connected: edgeStatus.connected,
    edge_port: edgeStatus.activePort,
    source: 'idle'
  });

  return { meta: sessionMeta, path: sessionFile };
}

// =============================================================================
// Cloud REST APIs
// =============================================================================
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    server: 'MyoMate Cloud Telemetry & AI Hub',
    edge_connected: edgeStatus.connected,
    edge_device: edgeStatus.deviceId,
    active_port: edgeStatus.activePort,
    edge_source: edgeStatus.source,
    is_recording: isRecording,
    active_session: activeSession ? { id: activeSession.id, title: activeSession.title, sampleCount: activeSession.samples.length } : null,
    ai_service_url: AI_SERVICE_URL
  });
});

app.get('/api/ports', (req, res) => {
  res.json({
    ports: edgeStatus.activePort ? [{ path: edgeStatus.activePort, manufacturer: 'ESP32 Device' }] : [],
    activePort: edgeStatus.activePort,
    edgeConnected: edgeStatus.connected,
    edgeDeviceId: edgeStatus.deviceId
  });
});

app.post('/api/record/start', (req, res) => {
  const { title, notes } = req.body;
  const session = handleStartRecording(title, notes);
  res.json({ success: true, session });
});

app.post('/api/record/stop', (req, res) => {
  const result = handleStopRecording();
  if (result) {
    res.json({ success: true, session: result.meta });
  } else {
    res.status(400).json({ success: false, message: 'No recording in progress' });
  }
});

app.get('/api/record/status', (req, res) => {
  res.json({
    is_recording: isRecording,
    session: activeSession ? {
      id: activeSession.id,
      title: activeSession.title,
      startTime: activeSession.startTime,
      durationSec: Math.floor((Date.now() - activeSession.startTime) / 1000),
      samplesCaptured: activeSession.samples.length
    } : null
  });
});

// Session & Recording Aliases
app.post('/api/recordings/start', (req, res) => {
  const { title, notes } = req.body;
  const session = handleStartRecording(title, notes);
  res.json({ success: true, session });
});

app.post('/api/recordings/stop', (req, res) => {
  const result = handleStopRecording();
  if (result) {
    res.json({ success: true, session: result.meta });
  } else {
    res.status(400).json({ success: false, message: 'No recording in progress' });
  }
});

app.get(['/api/sessions', '/api/recordings'], (req, res) => {
  res.json({ sessions: getSessionsIndex() });
});

app.get(['/api/sessions/:id', '/api/recordings/:id'], (req, res) => {
  const sessionFile = path.join(RECORDINGS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(sessionFile)) {
    return res.status(404).json({ error: 'Session not found' });
  }
  const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  res.json(data);
});

app.delete(['/api/sessions/:id', '/api/recordings/:id'], (req, res) => {
  const sessionFile = path.join(RECORDINGS_DIR, `${req.params.id}.json`);
  if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);

  let sessions = getSessionsIndex();
  sessions = sessions.filter(s => s.id !== req.params.id);
  saveSessionsIndex(sessions);

  res.json({ success: true, id: req.params.id });
});

app.get(['/api/sessions/:id/download', '/api/recordings/:id/export'], (req, res) => {
  const sessionFile = path.join(RECORDINGS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(sessionFile)) {
    return res.status(404).json({ error: 'Session not found' });
  }
  const format = req.query.format || 'json';
  if (format === 'csv') {
    const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    let csv = 'Timestamp_ms,ECG_uV,HR_BPM,RR_ms,LeadOff\n';
    (data.samples || []).forEach(s => {
      csv += `${s.t},${s.ecg},${s.hr || 0},${s.rr || 0},${s.lead_off ? 1 : 0}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}.csv"`);
    return res.send(csv);
  }
  res.download(sessionFile, `${req.params.id}.json`);
});

app.get('/api/recordings/compare/paired', (req, res) => {
  const { id1, id2 } = req.query;
  const f1 = path.join(RECORDINGS_DIR, `${id1}.json`);
  const f2 = path.join(RECORDINGS_DIR, `${id2}.json`);
  if (!fs.existsSync(f1) || !fs.existsSync(f2)) {
    return res.status(404).json({ error: 'One or both sessions not found' });
  }
  const s1 = JSON.parse(fs.readFileSync(f1, 'utf8'));
  const s2 = JSON.parse(fs.readFileSync(f2, 'utf8'));
  res.json({
    session1: s1,
    session2: s2,
    sessionA: s1,
    sessionB: s2
  });
});

// Proxy AI Arrhythmia analysis to Python AI Microservice
app.post('/api/ai/analyze', async (req, res) => {
  try {
    let payload = req.body;
    if (payload.recording_id && !payload.session) {
      const sessionFile = path.join(RECORDINGS_DIR, `${payload.recording_id}.json`);
      if (fs.existsSync(sessionFile)) {
        payload = { session: JSON.parse(fs.readFileSync(sessionFile, 'utf8')) };
      }
    }

    const aiRes = await fetch(`${AI_SERVICE_URL}/api/ai/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return res.status(aiRes.status).json({ error: `AI Microservice returned HTTP ${aiRes.status}`, details: errText });
    }

    const data = await aiRes.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'AI microservice offline', details: err.message });
  }
});

app.post('/api/ai/compare', async (req, res) => {
  try {
    const aiRes = await fetch(`${AI_SERVICE_URL}/api/ai/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return res.status(aiRes.status).json({ error: `AI Microservice returned HTTP ${aiRes.status}`, details: errText });
    }

    const data = await aiRes.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'AI microservice offline', details: err.message });
  }
});

// Start Cloud Server
server.listen(PORT, () => {
  console.log('===========================================================');
  console.log(`  MyoMate Cloud Telemetry & AI Hub`);
  console.log(`  Remote Viewer URL: http://localhost:${PORT}`);
  console.log(`  AI Engine URL:     ${AI_SERVICE_URL}`);
  console.log(`  Edge Ingest WS:    ws://localhost:${PORT}`);
  console.log('===========================================================');
});
