// ESP32 MAX30001 Wireless Bluetooth (SPP & BLE) + Internet WebSockets Visualizer, Recording & AI Diagnostic Engine

document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements (Safe Lookup)
    const canvas = document.getElementById('ecgCanvas');
    const ctx = canvas ? canvas.getContext('2d') : null;
    const heartPulseIcon = document.getElementById('heartPulse');
    const wsStatusElem = document.getElementById('wsStatus');
    const edgeStatusBadge = document.getElementById('edgeStatusBadge');
    const edgeStatusLabel = document.getElementById('edgeStatusLabel');
    const sourceTextElem = document.getElementById('sourceText');
    const btnBLE = document.getElementById('btnBLE');
    const btnDemo = document.getElementById('btnDemo');
    const btnTogglePVC = document.getElementById('btnTogglePVC');

    const valHR = document.getElementById('valHR');
    const valECG = document.getElementById('valECG');
    const valRR = document.getElementById('valRR');
    const valLead = document.getElementById('valLead');
    const leadDetail = document.getElementById('leadDetail');

    const minHRElem = document.getElementById('minHR');
    const avgHRElem = document.getElementById('avgHR');
    const maxHRElem = document.getElementById('maxHR');
    const peakECGElem = document.getElementById('peakECG');
    const gainDisplay = document.getElementById('gainDisplay');

    const btnPause = document.getElementById('btnPause');
    const btnClear = document.getElementById('btnClear');
    const selectGain = document.getElementById('selectGain');
    const selectSpeed = document.getElementById('selectSpeed');

    // Recording Controls Elements
    const btnRecordToggle = document.getElementById('btnRecordToggle');
    const recBtnText = document.getElementById('recBtnText');
    const inputSessionTitle = document.getElementById('inputSessionTitle');
    const recBadge = document.getElementById('recBadge');
    const recTimer = document.getElementById('recTimer');

    // History & Compare Elements
    const btnHistory = document.getElementById('btnHistory');
    const historyModal = document.getElementById('historyModal');
    const btnCloseHistory = document.getElementById('btnCloseHistory');
    const sessionTableBody = document.getElementById('sessionTableBody');
    const btnCompareSelected = document.getElementById('btnCompareSelected');

    // AI Card Elements
    const aiCard = document.getElementById('aiCard');
    const aiDiagnosisText = document.getElementById('aiDiagnosisText');
    const aiConfidenceBadge = document.getElementById('aiConfidenceBadge');
    const aiHrvText = document.getElementById('aiHrvText');
    const aiAnomaliesList = document.getElementById('aiAnomaliesList');

    // Comparison Elements
    const comparisonContainer = document.getElementById('comparisonContainer');
    const btnCloseCompare = document.getElementById('btnCloseCompare');
    const compTitleA = document.getElementById('compTitleA');
    const compMetaA = document.getElementById('compMetaA');
    const compTitleB = document.getElementById('compTitleB');
    const compMetaB = document.getElementById('compMetaB');
    const canvasCompareA = document.getElementById('canvasCompareA');
    const canvasCompareB = document.getElementById('canvasCompareB');

    // State Variables
    let isPaused = false;
    let demoMode = false;
    let userGain = 1.0;
    let userSpeedScale = 2.0; // Default 50mm/s
    const maxSamples = 4096;
    const ecgBuffer = new Array(maxSamples).fill(0);
    let writeIndex = 0;

    const hrHistory = [];
    let maxECGVal = 0.0;
    let smoothedECGValue = 0.0;
    let smoothRange = 600.0;

    let isRecordingLocal = false;
    let selectedForCompare = [];
    let isPvcModeActive = true;

    // Resizing Canvas
    function resizeCanvas() {
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = canvas.clientWidth * dpr;
        canvas.height = canvas.clientHeight * dpr;
    }
    if (canvas) {
        window.addEventListener('resize', resizeCanvas);
        resizeCanvas();
    }

    // Render Loop (60 FPS) with Medically Calibrated Timebase
    function renderScope() {
        if (!canvas || !ctx) return;

        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        const dpr = window.devicePixelRatio || 1;

        // Draw Standard Medical ECG Grid (5mm Large Boxes = 25px * dpr)
        ctx.strokeStyle = 'rgba(16, 185, 129, 0.12)';
        ctx.lineWidth = 1 * dpr;
        const gridSize = 25 * dpr;

        for (let x = 0; x < w; x += gridSize) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        }
        for (let y = 0; y < h; y += gridSize) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        }

        // Robust Medical Auto-scaling (Ignores Outlier Artifact Spikes)
        let sampleList = [];
        for (let i = 0; i < maxSamples; i++) {
            if (ecgBuffer[i] !== 0) sampleList.push(ecgBuffer[i]);
        }
        if (sampleList.length < 50) sampleList = ecgBuffer.slice();
        sampleList.sort((a, b) => a - b);

        const pLow = sampleList[Math.floor(sampleList.length * 0.03)] || -300;
        const pHigh = sampleList[Math.floor(sampleList.length * 0.97)] || 300;

        const rawRange = Math.max(100, pHigh - pLow);
        const targetRange = Math.min(3000, Math.max(400, rawRange * 1.35));
        smoothRange = (0.05 * targetRange) + (0.95 * smoothRange);
        const dynamicRange = smoothRange / userGain;

        const centerY = h / 2;
        const scaleY = h / dynamicRange;

        // Medically Calibrated Paper Speed (50 mm/s default at userSpeedScale = 2.0)
        // 1 sec = 5 large grid boxes * userSpeedScale = 5.0 * gridSize * userSpeedScale px/sec
        const pixelsPerSec = 5.0 * gridSize * userSpeedScale;
        const samplesPerSec = 512.0;
        const pixelsPerSample = pixelsPerSec / samplesPerSec;

        ctx.shadowBlur = 8 * dpr;
        ctx.shadowColor = '#10b981';
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 2.2 * dpr;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();

        const visibleSamples = Math.min(maxSamples, Math.max(50, Math.floor(w / pixelsPerSample)));
        const stepX = w / visibleSamples;

        if (visibleSamples > 1) {
            const startIdx = (writeIndex - visibleSamples + maxSamples) % maxSamples;
            let startY = centerY - (ecgBuffer[startIdx] * scaleY);
            ctx.moveTo(0, startY);

            for (let i = 1; i < visibleSamples; i++) {
                const sampleIdx = (startIdx + i) % maxSamples;
                const currX = i * stepX;
                const currY = centerY - (ecgBuffer[sampleIdx] * scaleY);
                ctx.lineTo(currX, currY);
            }
        }
        ctx.stroke();
        ctx.shadowBlur = 0;

        requestAnimationFrame(renderScope);
    }
    if (canvas) requestAnimationFrame(renderScope);

    // Synthetic Demo Generator
    let demoPhase = 0;
    setInterval(() => {
        if (demoMode && !isPaused) {
            demoPhase = (demoPhase + 1) % maxSamples;
            const t = demoPhase / maxSamples;
            let ecg = ((Math.random() * 10) - 5.0) * 1.5;

            if (t > 0.15 && t < 0.20) ecg += 140.0 * Math.sin((t - 0.15) / 0.05 * Math.PI);
            else if (t > 0.32 && t < 0.34) ecg -= 110.0 * Math.sin((t - 0.32) / 0.02 * Math.PI);
            else if (t > 0.34 && t < 0.38) ecg += 1150.0 * Math.sin((t - 0.34) / 0.04 * Math.PI);
            else if (t > 0.38 && t < 0.40) ecg -= 230.0 * Math.sin((t - 0.38) / 0.02 * Math.PI);
            else if (t > 0.55 && t < 0.65) ecg += 260.0 * Math.sin((t - 0.55) / 0.10 * Math.PI);

            updateTelemetryUI({
                ecg,
                hr: 72,
                rr: 833,
                lead_off: false,
                source: 'Demo Mode'
            });
            triggerHeartPulse();
        }
    }, 8);

    // Safe Telemetry Update Helper
    function updateTelemetryUI(data) {
        if (data.source && sourceTextElem) sourceTextElem.textContent = data.source;

        if (data.pvc_mode !== undefined && btnTogglePVC) {
            isPvcModeActive = data.pvc_mode;
            btnTogglePVC.textContent = isPvcModeActive ? '⚡ PVC Arrhythmia: ON' : '💚 Normal Rhythm';
            btnTogglePVC.style.background = isPvcModeActive ? 'rgba(245, 158, 11, 0.15)' : 'rgba(16, 185, 129, 0.15)';
            btnTogglePVC.style.color = isPvcModeActive ? '#f59e0b' : '#10b981';
            btnTogglePVC.style.borderColor = isPvcModeActive ? '#f59e0b' : '#10b981';
        }

        if (data.ecg !== undefined) {
            ecgBuffer[writeIndex] = data.ecg;
            writeIndex = (writeIndex + 1) % maxSamples;

            smoothedECGValue = (0.15 * data.ecg) + (0.85 * smoothedECGValue);
            if (valECG) valECG.textContent = smoothedECGValue.toFixed(1);

            if (Math.abs(data.ecg) > maxECGVal) {
                maxECGVal = Math.abs(data.ecg);
                if (peakECGElem) peakECGElem.textContent = `${maxECGVal.toFixed(1)} µV`;
            }
        }

        if (data.hr !== undefined && data.hr >= 30 && data.hr <= 220) {
            if (valHR) valHR.textContent = data.hr;
            triggerHeartPulse();

            hrHistory.push(data.hr);
            if (hrHistory.length > 500) hrHistory.shift();

            if (minHRElem) minHRElem.textContent = Math.min(...hrHistory);
            if (maxHRElem) maxHRElem.textContent = Math.max(...hrHistory);
            if (avgHRElem) avgHRElem.textContent = Math.round(hrHistory.reduce((a, b) => a + b, 0) / hrHistory.length);
        } else if (data.hr === 0) {
            if (valHR) valHR.textContent = '--';
        }

        if (data.rr !== undefined && data.rr > 0) {
            if (valRR) valRR.textContent = data.rr;
        } else {
            if (valRR) valRR.textContent = '--';
        }

        if (data.lead_off) {
            if (valLead) {
                valLead.textContent = 'LEAD OFF';
                valLead.className = 'value lead-off';
            }
            if (leadDetail) leadDetail.textContent = 'Attach 3 Chest Leads';
        } else {
            if (valLead) {
                valLead.textContent = 'CONNECTED';
                valLead.className = 'value lead-ok';
            }
            if (leadDetail) leadDetail.textContent = 'Active Telemetry Stream';
        }

        // Live Recording Status Sync
        if (data.is_recording) {
            isRecordingLocal = true;
            if (recBadge) recBadge.style.display = 'flex';
            if (recTimer) {
                const sec = data.recording_duration_sec || 0;
                const m = String(Math.floor(sec / 60)).padStart(2, '0');
                const s = String(sec % 60).padStart(2, '0');
                recTimer.textContent = `${m}:${s}`;
            }
            if (recBtnText) recBtnText.textContent = 'Stop & Save';
            if (btnRecordToggle) btnRecordToggle.style.background = '#dc2626';
        } else {
            if (isRecordingLocal) {
                isRecordingLocal = false;
                if (recBadge) recBadge.style.display = 'none';
                if (recBtnText) recBtnText.textContent = 'Record & Stream';
                if (btnRecordToggle) btnRecordToggle.style.background = '';
            }
        }
    }

    // Helper: Parse telemetry text line
    function parseTelemetryLine(line) {
        if (!line.includes('ECG:')) return;
        const parts = line.split('|');
        let ecg = 0.0, hr = 0, rr = 0, lead_off = false;

        for (let part of parts) {
            part = part.trim();
            if (part.startsWith('ECG:')) {
                ecg = parseFloat(part.replace('ECG:', '').replace('uV', '').trim()) || 0.0;
            } else if (part.startsWith('HR:')) {
                hr = parseInt(part.replace('HR:', '').replace('BPM', '').trim()) || 0;
            } else if (part.startsWith('RR:')) {
                rr = parseInt(part.replace('RR:', '').replace('ms', '').trim()) || 0;
            } else if (part.startsWith('Lead:')) {
                lead_off = part.includes('DISCONNECTED');
            }
        }

        updateTelemetryUI({ ecg, hr, rr, lead_off, source: 'Web-BLE Wireless' });

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ble_telemetry', ecg, hr, rr, lead_off }));
        }
    }

    // WebSocket Client
    let ws = null;
    function connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`;

        if (wsStatusElem) {
            wsStatusElem.className = 'status-indicator';
            wsStatusElem.querySelector('.label').textContent = 'Connecting...';
        }

        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log('[SPA] WebSocket Connected to Node.js Internet Server!');
            if (wsStatusElem) {
                wsStatusElem.className = 'status-indicator connected';
                wsStatusElem.querySelector('.label').textContent = 'LIVE INTERNET STREAM';
            }
        };

        function updateEdgeStatusUI(status) {
            if (!edgeStatusBadge || !edgeStatusLabel) return;
            if (status && status.connected) {
                edgeStatusBadge.className = 'status-indicator connected';
                const portName = (status.activePort || status.port || '').split('/').pop() || 'Hardware';
                edgeStatusLabel.textContent = `EDGE: ${portName}`;
                edgeStatusBadge.title = `Edge Device: ${status.deviceId || 'ESP32'} on ${status.activePort || status.port}`;
            } else {
                edgeStatusBadge.className = 'status-indicator';
                edgeStatusLabel.textContent = 'EDGE: OFFLINE';
                edgeStatusBadge.title = 'No local edge gateway streaming hardware telemetry';
            }
        }

        ws.onmessage = (event) => {
            if (isPaused || demoMode) return;
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'edge_status') {
                    updateEdgeStatusUI(data);
                    return;
                }
                if (data.type === 'init_state') {
                    if (data.edge_status) updateEdgeStatusUI(data.edge_status);
                }
                if (data.edge_connected !== undefined) {
                    updateEdgeStatusUI({ connected: data.edge_connected, activePort: data.edge_port });
                }
                updateTelemetryUI(data);
            } catch (err) {
                console.error('[SPA] Error parsing message:', err);
            }
        };

        ws.onclose = () => {
            if (wsStatusElem) {
                wsStatusElem.className = 'status-indicator';
                wsStatusElem.querySelector('.label').textContent = 'Reconnecting...';
            }
            setTimeout(connectWebSocket, 2000);
        };
    }

    // Heart Pulse Animation
    let pulseTimer = null;
    function triggerHeartPulse() {
        if (!heartPulseIcon) return;
        heartPulseIcon.classList.add('beat');
        clearTimeout(pulseTimer);
        pulseTimer = setTimeout(() => {
            heartPulseIcon.classList.remove('beat');
        }, 200);
    }

    // PVC Arrhythmia Generator Toggle Handler
    if (btnTogglePVC) {
        btnTogglePVC.addEventListener('click', async () => {
            try {
                const res = await fetch('/api/synthetic/pvc-toggle', { method: 'POST' });
                const data = await res.json();
                isPvcModeActive = data.pvc_mode;
                btnTogglePVC.textContent = isPvcModeActive ? '⚡ PVC Arrhythmia: ON' : '💚 Normal Rhythm';
                btnTogglePVC.style.background = isPvcModeActive ? 'rgba(245, 158, 11, 0.15)' : 'rgba(16, 185, 129, 0.15)';
                btnTogglePVC.style.color = isPvcModeActive ? '#f59e0b' : '#10b981';
                btnTogglePVC.style.borderColor = isPvcModeActive ? '#f59e0b' : '#10b981';
            } catch (e) {
                console.error('Error toggling PVC mode:', e);
            }
        });
    }

    // Recording Start/Stop Handlers
    if (btnRecordToggle) {
        btnRecordToggle.addEventListener('click', async () => {
            if (!isRecordingLocal) {
                const title = inputSessionTitle ? inputSessionTitle.value.trim() : '';
                try {
                    const res = await fetch('/api/recordings/start', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ title })
                    });
                    const data = await res.json();
                    if (data.success) {
                        isRecordingLocal = true;
                        if (recBadge) recBadge.style.display = 'flex';
                        if (recBtnText) recBtnText.textContent = 'Stop & Save';
                        if (btnRecordToggle) btnRecordToggle.style.background = '#dc2626';
                    }
                } catch(e) {
                    alert(`Error starting recording: ${e.message}`);
                }
            } else {
                try {
                    const res = await fetch('/api/recordings/stop', { method: 'POST' });
                    const data = await res.json();
                    if (data.success && data.session) {
                        isRecordingLocal = false;
                        if (recBadge) recBadge.style.display = 'none';
                        if (recBtnText) recBtnText.textContent = 'Record & Stream';
                        if (btnRecordToggle) btnRecordToggle.style.background = '';
                        alert(`Saved Session "${data.session.title}" (${data.session.durationSec}s, Avg HR: ${data.session.avgHR} BPM)`);
                    }
                } catch(e) {
                    alert(`Error stopping recording: ${e.message}`);
                }
            }
        });
    }

    // History & Compare Drawer Manager
    async function loadSessionsList() {
        if (!sessionTableBody) return;
        sessionTableBody.innerHTML = '<tr><td colspan="7" style="padding: 20px; text-align: center;">Loading sessions...</td></tr>';
        
        try {
            const res = await fetch('/api/recordings');
            const data = await res.json();
            const sessions = data.sessions || [];

            if (sessions.length === 0) {
                sessionTableBody.innerHTML = '<tr><td colspan="7" style="padding: 20px; text-align: center; color: var(--text-secondary);">No saved ECG sessions yet. Click "Record & Stream" to record a session.</td></tr>';
                return;
            }

            sessionTableBody.innerHTML = '';
            selectedForCompare = [];
            if (btnCompareSelected) btnCompareSelected.disabled = true;

            sessions.forEach(s => {
                const tr = document.createElement('tr');
                const dateStr = new Date(s.startTime).toLocaleString();
                
                tr.innerHTML = `
                    <td style="padding: 10px; text-align: center;">
                        <input type="checkbox" class="chk-compare" data-id="${s.id}">
                    </td>
                    <td style="padding: 10px;">${dateStr}</td>
                    <td style="padding: 10px; font-weight: 600; color: #fff;">${s.title}</td>
                    <td style="padding: 10px; font-family: var(--font-mono);">${s.durationSec}s</td>
                    <td style="padding: 10px; font-family: var(--font-mono); color: #10b981;">${s.avgHR || '--'} BPM</td>
                    <td style="padding: 10px; font-family: var(--font-mono);">${s.sampleCount}</td>
                    <td style="padding: 10px; display: flex; gap: 4px;">
                        <button class="btn btn-primary btn-ai-rec" data-id="${s.id}" style="padding: 3px 8px; font-size: 0.75rem;">🤖 AI</button>
                        <button class="btn btn-secondary btn-view-rec" data-id="${s.id}" style="padding: 3px 8px; font-size: 0.75rem;">👁️</button>
                        <a href="/api/recordings/${s.id}/export?format=csv" class="btn btn-secondary" style="padding: 3px 8px; font-size: 0.75rem; text-decoration: none;">📥</a>
                        <button class="btn btn-danger btn-del-rec" data-id="${s.id}" style="padding: 3px 8px; font-size: 0.75rem;">🗑️</button>
                    </td>
                `;
                sessionTableBody.appendChild(tr);
            });

            // Checkbox event listener for dual selection
            document.querySelectorAll('.chk-compare').forEach(chk => {
                chk.addEventListener('change', (e) => {
                    const elem = e.target.closest('[data-id]');
                    const id = elem ? elem.getAttribute('data-id') : null;
                    if (!id) return;

                    if (e.target.checked) {
                        if (selectedForCompare.length >= 2) {
                            e.target.checked = false;
                            alert('You can compare a maximum of 2 sessions at once.');
                            return;
                        }
                        selectedForCompare.push(id);
                    } else {
                        selectedForCompare = selectedForCompare.filter(x => x !== id);
                    }

                    if (btnCompareSelected) {
                        btnCompareSelected.disabled = (selectedForCompare.length !== 2);
                    }
                });
            });

            // AI Analysis Handler
            document.querySelectorAll('.btn-ai-rec').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const elem = e.target.closest('[data-id]');
                    const id = elem ? elem.getAttribute('data-id') : null;
                    if (id) runAIAnalysis(id);
                });
            });

            // View single recording handler
            document.querySelectorAll('.btn-view-rec').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const elem = e.target.closest('[data-id]');
                    const id = elem ? elem.getAttribute('data-id') : null;
                    if (id) loadAndRenderComparison(id, id);
                });
            });

            // Delete recording handler
            document.querySelectorAll('.btn-del-rec').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const elem = e.target.closest('[data-id]');
                    const id = elem ? elem.getAttribute('data-id') : null;
                    if (id && confirm('Delete this saved ECG recording session?')) {
                        await fetch(`/api/recordings/${id}`, { method: 'DELETE' });
                        loadSessionsList();
                    }
                });
            });

        } catch (e) {
            sessionTableBody.innerHTML = `<tr><td colspan="7" style="padding: 20px; text-align: center; color: #ef4444;">Error loading sessions: ${e.message}</td></tr>`;
        }
    }

    // Safe AI Analysis Function with Full Error Handling
    async function runAIAnalysis(sessionId) {
        if (!aiCard || !sessionId) return;
        aiCard.style.display = 'block';
        if (aiDiagnosisText) aiDiagnosisText.textContent = '🤖 Analyzing ECG waveform with 1D-CNN AI Engine...';
        if (aiConfidenceBadge) aiConfidenceBadge.textContent = 'Evaluating...';
        if (aiHrvText) aiHrvText.textContent = '--';
        if (aiAnomaliesList) aiAnomaliesList.textContent = 'Processing Pan-Tompkins beat segmentation and morphology...';

        try {
            const sessionRes = await fetch(`/api/recordings/${sessionId}`);
            if (!sessionRes.ok) {
                const text = await sessionRes.text();
                throw new Error(`Failed to load recording file (${sessionRes.status}): ${text.substring(0, 100)}`);
            }
            const sessionData = await sessionRes.json();

            const aiRes = await fetch('/api/ai/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session: sessionData })
            });

            if (!aiRes.ok) {
                const text = await aiRes.text();
                throw new Error(`AI Service error (${aiRes.status}): ${text.substring(0, 100)}`);
            }

            const result = await aiRes.json();

            if (result.status === 'success') {
                if (aiDiagnosisText) aiDiagnosisText.textContent = result.primary_diagnosis;
                if (aiConfidenceBadge) aiConfidenceBadge.textContent = `${Math.round(result.confidence_score * 100)}% Confidence`;
                
                const hrv = result.hrv_metrics || {};
                if (aiHrvText) aiHrvText.textContent = `SDNN: ${hrv.sdnn || '--'} ms | RMSSD: ${hrv.rmssd || '--'} ms | Avg HR: ${hrv.avg_hr || '--'} BPM`;

                const anomalies = result.anomalies || [];
                if (anomalies.length === 0) {
                    if (aiAnomaliesList) aiAnomaliesList.innerHTML = '✅ <strong style="color: #10b981;">Normal ECG Morphology</strong>: Standard sinus P-Q-R-S-T complexes with stable baseline and normal HRV.';
                } else {
                    let html = `<strong style="color: #ef4444;">Detected ${anomalies.length} Anomaly Events:</strong><ul style="margin-top: 6px; padding-left: 20px;">`;
                    anomalies.forEach(a => {
                        html += `<li style="margin-bottom: 4px;"><strong>[${a.type}]</strong> ${a.description} at Sample #${a.r_peak}</li>`;
                    });
                    html += `</ul>`;
                    if (aiAnomaliesList) aiAnomaliesList.innerHTML = html;
                }

                // Render session waveform with AI anomaly highlights
                loadAndRenderComparison(sessionId, sessionId, anomalies);

            } else {
                if (aiDiagnosisText) aiDiagnosisText.textContent = 'AI Analysis Notice';
                if (aiAnomaliesList) aiAnomaliesList.textContent = result.message || 'Failed to complete AI evaluation';
            }

        } catch (e) {
            if (aiDiagnosisText) aiDiagnosisText.textContent = 'AI Engine Notice';
            if (aiAnomaliesList) aiAnomaliesList.textContent = `Notice: ${e.message}`;
        }
    }

    if (btnHistory) {
        btnHistory.addEventListener('click', () => {
            if (historyModal) historyModal.style.display = 'flex';
            loadSessionsList();
        });
    }

    if (btnCloseHistory) {
        btnCloseHistory.addEventListener('click', () => {
            if (historyModal) historyModal.style.display = 'none';
        });
    }

    if (btnCompareSelected) {
        btnCompareSelected.addEventListener('click', () => {
            if (selectedForCompare.length === 2) {
                loadAndRenderComparison(selectedForCompare[0], selectedForCompare[1]);
            }
        });
    }

    if (btnCloseCompare) {
        btnCloseCompare.addEventListener('click', () => {
            if (comparisonContainer) comparisonContainer.style.display = 'none';
        });
    }

    // Dual Oscilloscope Comparison Renderer
    async function loadAndRenderComparison(id1, id2, anomalyOverlayA = []) {
        try {
            const res = await fetch(`/api/recordings/compare/paired?id1=${id1}&id2=${id2}`);
            if (!res.ok) return;

            const data = await res.json();
            if (data.error || !data.session1 || !data.session2) return;

            const s1 = data.session1;
            const s2 = data.session2;

            if (compTitleA) compTitleA.textContent = `Session A: ${s1.meta.title}`;
            if (compMetaA) compMetaA.textContent = `Date: ${new Date(s1.meta.startTime).toLocaleString()} | Avg HR: ${s1.meta.avgHR} BPM | Min/Max: ${s1.meta.minHR}/${s1.meta.maxHR} BPM | Samples: ${s1.meta.sampleCount}`;

            if (compTitleB) compTitleB.textContent = `Session B: ${s2.meta.title}`;
            if (compMetaB) compMetaB.textContent = `Date: ${new Date(s2.meta.startTime).toLocaleString()} | Avg HR: ${s2.meta.avgHR} BPM | Min/Max: ${s2.meta.minHR}/${s2.meta.maxHR} BPM | Samples: ${s2.meta.sampleCount}`;

            if (comparisonContainer) comparisonContainer.style.display = 'block';

            renderStaticWaveform(canvasCompareA, s1.samples, '#10b981', anomalyOverlayA);
            renderStaticWaveform(canvasCompareB, s2.samples, '#3b82f6', []);

        } catch (e) {
            console.error('Error loading comparison:', e);
        }
    }

    function renderStaticWaveform(canvasElem, samples, color, anomalyHighlights = []) {
        if (!canvasElem) return;
        const dpr = window.devicePixelRatio || 1;
        canvasElem.width = canvasElem.clientWidth * dpr;
        canvasElem.height = canvasElem.clientHeight * dpr;

        const ctxComp = canvasElem.getContext('2d');
        const w = canvasElem.width;
        const h = canvasElem.height;

        ctxComp.clearRect(0, 0, w, h);

        // Grid
        ctxComp.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctxComp.lineWidth = 1 * dpr;
        const gridSize = 25 * dpr;
        for (let x = 0; x < w; x += gridSize) {
            ctxComp.beginPath(); ctxComp.moveTo(x, 0); ctxComp.lineTo(x, h); ctxComp.stroke();
        }
        for (let y = 0; y < h; y += gridSize) {
            ctxComp.beginPath(); ctxComp.moveTo(0, y); ctxComp.lineTo(w, y); ctxComp.stroke();
        }

        if (!samples || samples.length === 0) return;

        let minVal = -300, maxVal = 300;
        samples.forEach(s => {
            if (s.ecg < minVal) minVal = s.ecg;
            if (s.ecg > maxVal) maxVal = s.ecg;
        });

        const dynamicRange = Math.max(30, (maxVal - minVal) * 1.30);
        const centerY = h / 2;
        const scaleY = h / dynamicRange;
        const step = w / samples.length;

        // Draw Anomaly Highlight Bounding Boxes if present
        if (anomalyHighlights && anomalyHighlights.length > 0) {
            ctxComp.fillStyle = 'rgba(239, 68, 68, 0.25)';
            ctxComp.strokeStyle = '#ef4444';
            ctxComp.lineWidth = 1.5 * dpr;

            anomalyHighlights.forEach(a => {
                const x1 = a.start_idx * step;
                const x2 = a.end_idx * step;
                const boxW = Math.max(12 * dpr, x2 - x1);
                ctxComp.fillRect(x1, 10, boxW, h - 20);
                ctxComp.strokeRect(x1, 10, boxW, h - 20);
            });
        }

        ctxComp.strokeStyle = color;
        ctxComp.lineWidth = 2 * dpr;
        ctxComp.lineJoin = 'round';
        ctxComp.beginPath();

        samples.forEach((s, idx) => {
            const x = idx * step;
            const y = centerY - (s.ecg * scaleY);
            if (idx === 0) ctxComp.moveTo(x, y);
            else ctxComp.lineTo(x, y);
        });

        ctxComp.stroke();
    }

    // Universal Web-Bluetooth Pairing
    async function connectWebBLE() {
        if (!navigator.bluetooth) {
            alert('Web Bluetooth requires Chrome, Edge, or Opera on macOS!');
            return;
        }

        try {
            console.log('[Web-BLE] Requesting Bluetooth device...');
            if (btnBLE) btnBLE.textContent = '🔄 Pairing...';

            const device = await navigator.bluetooth.requestDevice({
                acceptAllDevices: true,
                optionalServices: [
                    '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
                    '0000180d-0000-1000-8000-00805f9b34fb',
                    '19b10000-e8f2-537e-4f6c-d104768a1214'
                ]
            });

            console.log(`[Web-BLE] Connecting GATT: ${device.name || 'ESP32'}...`);
            const server = await device.gatt.connect();

            if (btnBLE) {
                btnBLE.textContent = '📶 BLE Connected';
                btnBLE.style.background = '#10b981';
            }
            if (sourceTextElem) sourceTextElem.textContent = 'Web-BLE Wireless';
            demoMode = false;

            try {
                const nusService = await server.getPrimaryService('6e400001-b5a3-f393-e0a9-e50e24dcca9e');
                const nusTXChar = await nusService.getCharacteristic('6e400003-b5a3-f393-e0a9-e50e24dcca9e');
                await nusTXChar.startNotifications();
                
                const decoder = new TextDecoder();
                let bleTextBuf = '';

                nusTXChar.addEventListener('characteristicvaluechanged', (e) => {
                    const str = decoder.decode(e.target.value);
                    bleTextBuf += str;
                    if (bleTextBuf.includes('\n')) {
                        const lines = bleTextBuf.split('\n');
                        bleTextBuf = lines.pop();
                        lines.forEach(line => parseTelemetryLine(line));
                    }
                });
                console.log('[Web-BLE] Subscribed to NUS serial stream!');
            } catch(nusErr) {
                console.log('[Web-BLE] NUS notice:', nusErr.message);
            }

            device.addEventListener('gattserverdisconnected', () => {
                if (btnBLE) {
                    btnBLE.textContent = '📶 Pair Bluetooth LE';
                    btnBLE.style.background = '';
                }
                if (sourceTextElem) sourceTextElem.textContent = 'Disconnected';
            });

        } catch (err) {
            console.error('[Web-BLE] Error:', err);
            if (btnBLE) btnBLE.textContent = '📶 Pair Bluetooth LE';
            alert(`Bluetooth Pairing Note: ${err.message}`);
        }
    }

    if (btnBLE) btnBLE.addEventListener('click', connectWebBLE);

    if (btnDemo) {
        btnDemo.addEventListener('click', () => {
            demoMode = !demoMode;
            btnDemo.textContent = demoMode ? '⏹️ Stop Demo' : '🧪 Test Demo Trace';
            btnDemo.style.background = demoMode ? '#10b981' : '';
        });
    }

    if (btnPause) {
        btnPause.addEventListener('click', () => {
            isPaused = !isPaused;
            btnPause.innerHTML = isPaused ? '▶️ Resume' : '⏸️ Pause';
        });
    }

    if (btnClear) {
        btnClear.addEventListener('click', () => {
            ecgBuffer.fill(0);
            maxECGVal = 0.0;
            if (peakECGElem) peakECGElem.textContent = '0.0 µV';
            hrHistory.length = 0;
            if (minHRElem) minHRElem.textContent = '--';
            if (maxHRElem) maxHRElem.textContent = '--';
            if (avgHRElem) avgHRElem.textContent = '--';
        });
    }

    if (selectGain) {
        selectGain.addEventListener('change', (e) => {
            userGain = parseFloat(e.target.value);
            if (gainDisplay) gainDisplay.textContent = `${userGain}x`;
        });
    }

    if (selectSpeed) {
        selectSpeed.addEventListener('change', (e) => {
            const val = parseFloat(e.target.value);
            userSpeedScale = val;
        });
    }

    connectWebSocket();
});
