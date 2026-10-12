import os
import sys
import time
import json
import threading
import serial
from http.server import HTTPServer, BaseHTTPRequestHandler

SERIAL_PORT = "/dev/cu.usbserial-02E4CA0A"
BAUD_RATE = 115200

# Global latest data buffer
current_state = {
    "ecg": 0.0,
    "bioz": 0.0,
    "hr": 0,
    "rr": 0,
    "lead_off": False
}

def serial_reader_thread():
    global current_state
    while True:
        try:
            ser = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=1)
            print(f"[Python] Connected to USB serial port {SERIAL_PORT}")
            while True:
                if ser.in_waiting:
                    line = ser.readline().decode('utf-8', errors='ignore').strip()
                    # Example line: ECG:  307.81 uV | HR:  57 BPM | RR: 1039 ms | Lead: CONNECTED
                    if "ECG:" in line:
                        parts = line.split("|")
                        for part in parts:
                            part = part.strip()
                            if part.startswith("ECG:"):
                                val_str = part.replace("ECG:", "").replace("uV", "").strip()
                                try: current_state["ecg"] = float(val_str)
                                except: pass
                            elif part.startswith("HR:"):
                                val_str = part.replace("HR:", "").replace("BPM", "").strip()
                                try: current_state["hr"] = int(val_str)
                                except: pass
                            elif part.startswith("RR:"):
                                val_str = part.replace("RR:", "").replace("ms", "").strip()
                                try: current_state["rr"] = int(val_str)
                                except: pass
                            elif part.startswith("Lead:"):
                                current_state["lead_off"] = ("DISCONNECTED" in part)
                else:
                    time.sleep(0.005)
        except Exception as e:
            print(f"[Python] Serial connection error: {e}. Retrying in 2 seconds...")
            time.sleep(2)

HTML_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>ESP32 MAX30001 USB Live Oscilloscope</title>
    <style>
        body { background: #0b0f19; color: #f3f4f6; font-family: system-ui, sans-serif; display: flex; flex-direction: column; align-items: center; padding: 20px; }
        header { width: 100%; max-width: 1000px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #1f2937; padding-bottom: 15px; margin-bottom: 20px; }
        .grid { width: 100%; max-width: 1000px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 20px; }
        .card { background: #111827; border: 1px solid #1f2937; border-radius: 10px; padding: 15px; }
        .label { font-size: 0.8rem; color: #9ca3af; text-transform: uppercase; }
        .val { font-size: 2rem; font-weight: 800; font-family: monospace; margin-top: 5px; }
        canvas { width: 100%; max-width: 1000px; height: 380px; background: #070a12; border: 1px solid #1f2937; border-radius: 10px; }
    </style>
</head>
<body>
    <header>
        <h2>🫀 ESP32 MAX30001 USB Real-Time Oscilloscope</h2>
        <span id="badge" style="color: #10b981; font-weight: 600;">● STREAMING LIVE (USB)</span>
    </header>
    <div class="grid">
        <div class="card"><div class="label">Heart Rate</div><div class="val" id="hr">-- BPM</div></div>
        <div class="card"><div class="label">ECG Amplitude</div><div class="val" id="ecg">0.0 µV</div></div>
        <div class="card"><div class="label">R-R Interval</div><div class="val" id="rr">-- ms</div></div>
        <div class="card"><div class="label">Lead Status</div><div class="val" id="lead" style="color: #10b981;">OK</div></div>
    </div>
    <canvas id="cv"></canvas>
    <script>
        const canvas = document.getElementById('cv');
        const ctx = canvas.getContext('2d');
        function resize() { canvas.width = canvas.clientWidth * window.devicePixelRatio; canvas.height = canvas.clientHeight * window.devicePixelRatio; }
        window.addEventListener('resize', resize); resize();

        const buf = new Array(500).fill(0);
        let idx = 0;

        function draw() {
            const w = canvas.width, h = canvas.height;
            ctx.clearRect(0, 0, w, h);
            ctx.strokeStyle = 'rgba(16, 185, 129, 0.15)'; ctx.lineWidth = 1;
            for (let x = 0; x < w; x += 30) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
            for (let y = 0; y < h; y += 30) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

            let minV = -300, maxV = 300;
            for (let i = 0; i < 500; i++) { if (buf[i] < minV) minV = buf[i]; if (buf[i] > maxV) maxV = buf[i]; }
            const range = Math.max(600, (maxV - minV) * 1.3);
            const centerY = h / 2, scaleY = h / range, step = w / 500;

            ctx.strokeStyle = '#10b981'; ctx.lineWidth = 2.5 * window.devicePixelRatio;
            ctx.shadowBlur = 10; ctx.shadowColor = '#10b981'; ctx.beginPath();
            for (let i = 0; i < 500; i++) {
                const x = i * step, y = centerY - (buf[i] * scaleY);
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke(); ctx.shadowBlur = 0;
            requestAnimationFrame(draw);
        }
        requestAnimationFrame(draw);

        async function poll() {
            try {
                const res = await fetch('/api/data');
                const data = await res.json();
                buf[idx] = data.ecg; idx = (idx + 1) % 500;
                document.getElementById('ecg').textContent = data.ecg.toFixed(1) + ' µV';
                document.getElementById('hr').textContent = (data.hr > 0 && data.hr < 250) ? (data.hr + ' BPM') : '-- BPM';
                document.getElementById('rr').textContent = (data.rr > 0) ? (data.rr + ' ms') : '-- ms';
            } catch(e) {}
            setTimeout(poll, 10);
        }
        poll();
    </script>
</body>
</html>"""

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args): return
    def do_GET(self):
        if self.path == '/api/data':
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(current_state).encode('utf-8'))
        else:
            self.send_response(200)
            self.send_header('Content-type', 'text/html')
            self.end_headers()
            self.wfile.write(HTML_PAGE.encode('utf-8'))

if __name__ == '__main__':
    t = threading.Thread(target=serial_reader_thread, daemon=True)
    t.start()
    server = HTTPServer(('0.0.0.0', 8000), Handler)
    print("Local Mac Oscilloscope Server running at http://localhost:8000")
    try: server.serve_forever()
    except KeyboardInterrupt: pass
