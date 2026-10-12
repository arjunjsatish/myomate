#include "wireless_stream.h"

const char WirelessStreamManager::INDEX_HTML[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ESP32 MAX30001 ECG & BioZ Live Monitor</title>
    <style>
        :root {
            --bg-color: #0b0f19;
            --card-bg: #111827;
            --text-main: #f3f4f6;
            --text-muted: #9ca3af;
            --ecg-green: #10b981;
            --grid-color: rgba(16, 185, 129, 0.12);
            --accent-blue: #3b82f6;
            --alert-red: #ef4444;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; }
        body { background-color: var(--bg-color); color: var(--text-main); display: flex; flex-direction: column; align-items: center; min-height: 100vh; padding: 20px; }

        header { width: 100%; max-width: 1100px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid #1f2937; padding-bottom: 15px; }
        h1 { font-size: 1.5rem; font-weight: 700; color: #ffffff; display: flex; align-items: center; gap: 10px; }
        .status-badge { font-size: 0.85rem; padding: 4px 12px; border-radius: 9999px; background-color: #374151; color: var(--text-muted); font-weight: 600; }
        .status-badge.connected { background-color: rgba(16, 185, 129, 0.2); color: var(--ecg-green); border: 1px solid var(--ecg-green); }

        .metrics-grid { width: 100%; max-width: 1100px; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 15px; margin-bottom: 20px; }
        .metric-card { background-color: var(--card-bg); border: 1px solid #1f2937; border-radius: 12px; padding: 18px; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3); }
        .metric-label { font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
        .metric-value { font-size: 2.2rem; font-weight: 800; color: #ffffff; font-family: monospace; }
        .metric-unit { font-size: 0.9rem; color: var(--text-muted); margin-left: 4px; font-weight: 400; }

        .chart-container { width: 100%; max-width: 1100px; background-color: var(--card-bg); border: 1px solid #1f2937; border-radius: 12px; padding: 20px; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.4); }
        .chart-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
        canvas { width: 100%; height: 360px; background-color: #070a12; border-radius: 8px; border: 1px solid #1f2937; display: block; }

        .footer { margin-top: 30px; color: var(--text-muted); font-size: 0.85rem; text-align: center; }
    </style>
</head>
<body>
    <header>
        <h1><span>🫀</span> ESP32 MAX30001 ECG & BioZ Live Monitor</h1>
        <div id="statusBadge" class="status-badge">Connecting WebSocket...</div>
    </header>

    <div class="metrics-grid">
        <div class="metric-card">
            <div class="metric-label">Heart Rate</div>
            <div class="metric-value" id="valHR">-- <span class="metric-unit">BPM</span></div>
        </div>
        <div class="metric-card">
            <div class="metric-label">ECG Amplitude</div>
            <div class="metric-value" id="valECG">0.0 <span class="metric-unit">µV</span></div>
        </div>
        <div class="metric-card">
            <div class="metric-label">R-R Interval</div>
            <div class="metric-value" id="valRR">-- <span class="metric-unit">ms</span></div>
        </div>
        <div class="metric-card">
            <div class="metric-label">Bio-Impedance (BioZ)</div>
            <div class="metric-value" id="valBioZ">0.0 <span class="metric-unit">Ω</span></div>
        </div>
    </div>

    <div class="chart-container">
        <div class="chart-header">
            <h3 style="color: var(--text-muted); font-size: 1rem; font-weight: 600;">Real-Time Real ECG Waveform (128 SPS)</h3>
            <span style="font-size: 0.8rem; color: var(--ecg-green);">● LIVE STREAM</span>
        </div>
        <canvas id="ecgCanvas"></canvas>
    </div>

    <div class="footer">
        Adafruit ESP32 Feather + ProtoCentral MAX30001 Breakout | Wireless Bluetooth & Wi-Fi Engine
    </div>

    <script>
        const canvas = document.getElementById('ecgCanvas');
        const ctx = canvas.getContext('2d');
        
        function resizeCanvas() {
            canvas.width = canvas.clientWidth * window.devicePixelRatio;
            canvas.height = canvas.clientHeight * window.devicePixelRatio;
        }
        window.addEventListener('resize', resizeCanvas);
        resizeCanvas();

        const maxSamples = 500;
        const ecgBuffer = new Array(maxSamples).fill(0);
        let writeIndex = 0;

        function drawChart() {
            const w = canvas.width;
            const h = canvas.height;
            ctx.clearRect(0, 0, w, h);

            ctx.strokeStyle = 'rgba(16, 185, 129, 0.12)';
            ctx.lineWidth = 1;
            const gridSize = 25 * window.devicePixelRatio;
            for (let x = 0; x < w; x += gridSize) {
                ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
            }
            for (let y = 0; y < h; y += gridSize) {
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
            }

            let minVal = -300, maxVal = 300;
            for (let i = 0; i < maxSamples; i++) {
                if (ecgBuffer[i] < minVal) minVal = ecgBuffer[i];
                if (ecgBuffer[i] > maxVal) maxVal = ecgBuffer[i];
            }
            const range = Math.max(600, (maxVal - minVal) * 1.25);
            const centerY = h / 2;
            const scaleY = h / range;

            ctx.strokeStyle = '#10b981';
            ctx.lineWidth = 2 * window.devicePixelRatio;
            ctx.shadowBlur = 8;
            ctx.shadowColor = '#10b981';
            ctx.beginPath();

            const step = w / maxSamples;
            for (let i = 0; i < maxSamples; i++) {
                const x = i * step;
                const y = centerY - (ecgBuffer[i] * scaleY);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.shadowBlur = 0;

            requestAnimationFrame(drawChart);
        }
        requestAnimationFrame(drawChart);

        const wsUrl = `ws://${window.location.hostname}:81/`;
        let ws;

        function connectWS() {
            ws = new WebSocket(wsUrl);
            const statusBadge = document.getElementById('statusBadge');

            ws.onopen = () => {
                statusBadge.textContent = 'Connected (Wi-Fi WebSocket)';
                statusBadge.classList.add('connected');
            };

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.ecg !== undefined) {
                        ecgBuffer[writeIndex] = msg.ecg;
                        writeIndex = (writeIndex + 1) % maxSamples;
                        document.getElementById('valECG').innerHTML = `${msg.ecg.toFixed(1)} <span class="metric-unit">µV</span>`;
                    }
                    if (msg.bioz !== undefined) {
                        document.getElementById('valBioZ').innerHTML = `${msg.bioz.toFixed(1)} <span class="metric-unit">Ω</span>`;
                    }
                    if (msg.hr !== undefined) {
                        if (msg.hr >= 30 && msg.hr <= 220) {
                            document.getElementById('valHR').innerHTML = `${msg.hr} <span class="metric-unit">BPM</span>`;
                        } else {
                            document.getElementById('valHR').innerHTML = `-- <span class="metric-unit">BPM</span>`;
                        }
                    }
                    if (msg.rr !== undefined) {
                        if (msg.rr > 0) {
                            document.getElementById('valRR').innerHTML = `${msg.rr} <span class="metric-unit">ms</span>`;
                        } else {
                            document.getElementById('valRR').innerHTML = `-- <span class="metric-unit">ms</span>`;
                        }
                    }
                } catch(e) {}
            };

            ws.onclose = () => {
                statusBadge.textContent = 'Disconnected (Reconnecting...)';
                statusBadge.classList.remove('connected');
                setTimeout(connectWS, 2000);
            };
        }
        connectWS();
    </script>
</body>
</html>
)rawliteral";

class BLEServerCallbacksHandler : public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) override {}
    void onDisconnect(BLEServer* pServer) override {
        BLEDevice::startAdvertising();
    }
};

WirelessStreamManager::WirelessStreamManager()
    : _webServer(HTTP_SERVER_PORT), _webSocket(WEBSOCKET_PORT),
      _pBLEServer(nullptr), _pHeartRateChar(nullptr), _pECGDataChar(nullptr), _pNUSTXChar(nullptr),
      _bleClientConnected(false) {
}

void WirelessStreamManager::begin() {
    setupWiFi();
    setupWebServer();
    setupBluetooth();
    setupBLE();
}

void WirelessStreamManager::setupWiFi() {
    WiFi.softAP(WIFI_AP_SSID, WIFI_AP_PASS);
    IPAddress IP = WiFi.softAPIP();
    Serial.print("[WiFi] Access Point started! IP address: ");
    Serial.println(IP);
}

void WirelessStreamManager::setupWebServer() {
    _webServer.on("/", [this]() {
        _webServer.send_P(200, "text/html", INDEX_HTML);
    });
    _webServer.begin();

    _webSocket.begin();
    Serial.println("[WebSockets] Server initialized on port 81");
}

void WirelessStreamManager::setupBluetooth() {
#if !defined(CONFIG_IDF_TARGET_ESP32C3)
    if (_serialBT.begin(BT_SPP_NAME)) {
        Serial.println("[Bluetooth SPP] Started device name: " BT_SPP_NAME);
    } else {
        Serial.println("[Bluetooth SPP] Error starting Bluetooth Serial");
    }
#else
    Serial.println("[Bluetooth SPP] Skipping SPP on ESP32-C3 (BLE active)");
#endif
}

void WirelessStreamManager::setupBLE() {
    BLEDevice::init(BLE_DEVICE_NAME);
    _pBLEServer = BLEDevice::createServer();
    _pBLEServer->setCallbacks(new BLEServerCallbacksHandler());

    // 1. Standard Heart Rate Service
    BLEService *pHRService = _pBLEServer->createService(HEART_RATE_SERVICE_UUID);
    _pHeartRateChar = pHRService->createCharacteristic(
        HEART_RATE_CHAR_UUID,
        BLECharacteristic::PROPERTY_NOTIFY
    );
    _pHeartRateChar->addDescriptor(new BLE2902());
    pHRService->start();

    // 2. Custom ECG Data Service
    BLEService *pECGService = _pBLEServer->createService(ECG_SERVICE_UUID);
    _pECGDataChar = pECGService->createCharacteristic(
        ECG_DATA_CHAR_UUID,
        BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ
    );
    _pECGDataChar->addDescriptor(new BLE2902());
    pECGService->start();

    // 3. Nordic UART Service (NUS) for Universal BLE Serial
    BLEService *pNUSService = _pBLEServer->createService(NUS_SERVICE_UUID);
    _pNUSTXChar = pNUSService->createCharacteristic(
        NUS_TX_CHAR_UUID,
        BLECharacteristic::PROPERTY_NOTIFY
    );
    _pNUSTXChar->addDescriptor(new BLE2902());
    pNUSService->start();

    BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(HEART_RATE_SERVICE_UUID);
    pAdvertising->addServiceUUID(ECG_SERVICE_UUID);
    pAdvertising->addServiceUUID(NUS_SERVICE_UUID);
    pAdvertising->setScanResponse(true);
    pAdvertising->setMinPreferred(0x06);
    pAdvertising->setMinPreferred(0x12);
    BLEDevice::startAdvertising();
    
    Serial.println("[BLE] Advertising started for " BLE_DEVICE_NAME);
}

void WirelessStreamManager::update() {
    _webServer.handleClient();
    _webSocket.loop();
}

void WirelessStreamManager::broadcastData(const MAX30001_Data &data) {
    // 1. WebSockets Stream
    char jsonBuf[128];
    snprintf(jsonBuf, sizeof(jsonBuf),
             "{\"ecg\":%.2f,\"bioz\":%.2f,\"hr\":%u,\"rr\":%u,\"lead_off\":%s}",
             data.ecg_uV, data.bioz_ohms, data.heart_rate_bpm, data.rtor_ms,
             data.lead_off ? "true" : "false");
    _webSocket.broadcastTXT(jsonBuf);

    // 2. Bluetooth Serial (SPP) Stream
    char serialLine[128];
    snprintf(serialLine, sizeof(serialLine), "ECG: %7.2f uV | HR: %3u BPM | RR: %4u ms | Lead: %s\n",
             data.ecg_uV, data.heart_rate_bpm, data.rtor_ms,
             data.lead_off ? "DISCONNECTED" : "CONNECTED");

#if !defined(CONFIG_IDF_TARGET_ESP32C3)
    if (_serialBT.hasClient()) {
        _serialBT.print(serialLine);
    }
#endif

    // 3. Nordic UART BLE Stream (NUS)
    if (_pNUSTXChar != nullptr) {
        _pNUSTXChar->setValue((uint8_t*)serialLine, strlen(serialLine));
        _pNUSTXChar->notify();
    }

    // 4. BLE Characteristic Notifications
    if (_pECGDataChar != nullptr) {
        float val = data.ecg_uV;
        _pECGDataChar->setValue((uint8_t*)&val, sizeof(val));
        _pECGDataChar->notify();
    }

    if (data.new_rtor && _pHeartRateChar != nullptr && data.heart_rate_bpm >= 30 && data.heart_rate_bpm <= 220) {
        uint8_t hrFlags = 0x00;
        uint8_t hrData[2] = { hrFlags, (uint8_t)data.heart_rate_bpm };
        _pHeartRateChar->setValue(hrData, 2);
        _pHeartRateChar->notify();
    }
}
