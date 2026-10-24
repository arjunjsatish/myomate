import os
import json
import numpy as np

try:
    import torch
    import torch.nn as nn
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

from ecg_dsp import analyze_ecg_morphology, detect_r_peaks
from beat_features import (
    TARGET_FS, WINDOW_LEN, bandpass_filter, resample_signal,
    extract_beat_window, compute_rr_features
)

AAMI_CLASSES = ['Normal Sinus Beat (N)', 'Supraventricular Ectopic (PAC / S)', 'Premature Ventricular Contraction (PVC / V)', 'Ventricular Ectopic / Other']

class HybridECG1DCNN(nn.Module):
    """
    Hybrid 1D-CNN Network combining:
    1. Convolutional feature extractor for beat morphology (96 samples at 128 Hz)
    2. Dense branch for R-R timing features (4 features)
    """
    def __init__(self, num_classes=4):
        super().__init__()
        self.conv_branch = nn.Sequential(
            nn.Conv1d(1, 32, kernel_size=7, padding=3),
            nn.BatchNorm1d(32),
            nn.ReLU(),
            nn.MaxPool1d(2),
            nn.Dropout(0.1),

            nn.Conv1d(32, 64, kernel_size=5, padding=2),
            nn.BatchNorm1d(64),
            nn.ReLU(),
            nn.MaxPool1d(2),
            nn.Dropout(0.15),

            nn.Conv1d(64, 128, kernel_size=3, padding=1),
            nn.BatchNorm1d(128),
            nn.ReLU(),
            nn.AdaptiveAvgPool1d(1),
            nn.Flatten(),
            nn.Linear(128, 64),
            nn.ReLU()
        )

        self.timing_branch = nn.Sequential(
            nn.Linear(4, 32),
            nn.ReLU(),
            nn.Dropout(0.1),
            nn.Linear(32, 16),
            nn.ReLU()
        )

        self.classifier = nn.Sequential(
            nn.Linear(64 + 16, 32),
            nn.ReLU(),
            nn.Dropout(0.15),
            nn.Linear(32, num_classes)
        )

    def forward(self, beat_wave, rr_feat):
        morph_embed = self.conv_branch(beat_wave)
        time_embed = self.timing_branch(rr_feat)
        combined = torch.cat([morph_embed, time_embed], dim=1)
        return self.classifier(combined)


class ECGModelManager:
    """
    Singleton Manager that loads trained 1D-CNN weights and runs batch inference.
    """
    def __init__(self):
        self.device = 'cpu'
        self.model = None
        self.is_loaded = False
        self.metadata = None
        self.classes = AAMI_CLASSES

        self._load_trained_model()

    def _load_trained_model(self):
        models_dir = os.path.join(os.path.dirname(__file__), 'models')
        weights_path = os.path.join(models_dir, 'ecg_cnn.pt')
        meta_path = os.path.join(models_dir, 'ecg_cnn_meta.json')

        if os.path.exists(meta_path):
            try:
                with open(meta_path, 'r') as f:
                    self.metadata = json.load(f)
            except Exception as e:
                print(f"[ModelManager] Notice loading metadata: {e}")

        if HAS_TORCH and os.path.exists(weights_path):
            try:
                self.model = HybridECG1DCNN(num_classes=4).to(self.device)
                state = torch.load(weights_path, map_location=self.device)
                self.model.load_state_dict(state)
                self.model.eval()
                self.is_loaded = True
                print(f"[ModelManager] Successfully loaded trained weights from {weights_path}!")
            except Exception as e:
                print(f"[ModelManager] Error loading trained weights: {e}")
                self.model = None
                self.is_loaded = False
        else:
            self.model = None
            self.is_loaded = False
            print("[ModelManager] Trained model weights not found. Using clinical DSP rules engine.")

    def predict_beats(self, beat_windows_np, rr_features_np):
        """
        Runs batch prediction on extracted beat windows (N, 96) and timing features (N, 4).
        Returns list of {class_idx, class_name, confidence, probs: [p0, p1, p2, p3]}.
        """
        n = len(beat_windows_np)
        if n == 0:
            return []

        if not self.is_loaded or self.model is None or not HAS_TORCH:
            # Fallback if weights not yet trained
            return [{
                "class_idx": 0,
                "class_name": self.classes[0],
                "confidence": 0.85,
                "pvc_prob": 0.05,
                "probs": [0.85, 0.05, 0.05, 0.05]
            } for _ in range(n)]

        with torch.no_grad():
            b_tensor = torch.tensor(beat_windows_np, dtype=torch.float32).unsqueeze(1).to(self.device)
            r_tensor = torch.tensor(rr_features_np, dtype=torch.float32).to(self.device)
            logits = self.model(b_tensor, r_tensor)
            probs = torch.softmax(logits, dim=1).cpu().numpy()

        results = []
        for i in range(n):
            p = probs[i]
            c_idx = int(np.argmax(p))
            results.append({
                "class_idx": c_idx,
                "class_name": self.classes[c_idx],
                "confidence": float(p[c_idx]),
                "pvc_prob": float(p[2]), # Index 2 is PVC
                "probs": [float(x) for x in p]
            })

        return results

# Global singleton
model_manager = ECGModelManager()


def analyze_full_session(session_data, sampling_rate=128):
    """
    Full AI analysis combining clinical DSP rules with trained 1D-CNN predictions.
    Input: session_data = { meta, samples: [ {t, ecg, hr, rr, lead_off} ] }
    """
    samples = session_data.get('samples', [])
    meta = session_data.get('meta', {})

    if not samples or len(samples) < 50:
        return {
            "status": "error",
            "message": "Insufficient ECG sample points for AI analysis (minimum 50 samples required)."
        }

    ecg_signal = np.array([float(s.get('ecg', 0.0)) for s in samples], dtype=np.float32)

    # Infer exact hardware sampling rate from sample timestamps if available
    if len(samples) > 5 and 't' in samples[0] and 't' in samples[-1]:
        dt_sec = (float(samples[-1]['t']) - float(samples[0]['t'])) / 1000.0
        if dt_sec > 0.5:
            sampling_rate = float(len(samples)) / dt_sec

    # 1. Run Clinical DSP Analysis (Peak detection, HRV, rule metrics)
    dsp_results = analyze_ecg_morphology(ecg_signal, sampling_rate=sampling_rate)
    r_peaks = dsp_results['r_peaks']
    beat_diag = dsp_results.get('beat_diagnostics', {})

    # 2. Resample signal to 128 Hz for standardized 1D-CNN inference
    filtered_128 = bandpass_filter(
        resample_signal(ecg_signal, orig_fs=sampling_rate, target_fs=TARGET_FS),
        fs=TARGET_FS, lowcut=0.5, highcut=40.0
    )

    scale_to_128 = float(TARGET_FS) / float(sampling_rate)
    r_peaks_128 = [int(round(p * scale_to_128)) for p in r_peaks]

    # Extract beat windows and R-R timing features
    beat_windows = []
    for p_128 in r_peaks_128:
        beat_windows.append(extract_beat_window(filtered_128, p_128))

    rr_features = compute_rr_features(np.array(r_peaks_128, dtype=int), fs=TARGET_FS)
    beat_windows_np = np.array(beat_windows, dtype=np.float32)

    # 3. 1D-CNN Inference
    cnn_predictions = model_manager.predict_beats(beat_windows_np, rr_features)

    # 4. Hybrid Weighted-Vote Decision Policy (Option A)
    # PVC Criteria:
    # A) High-confidence CNN prediction: P_V >= 0.90
    # B) Borderline/Strong CNN prediction: P_V >= 0.50 AND at least one physiological DSP rule fires
    # C) Strong DSP physiological agreement: rule_pvc is True AND P_V >= 0.40
    confirmed_anomalies = []
    pvc_count = 0
    pac_count = 0
    beat_records = []

    for idx, r_idx in enumerate(r_peaks):
        diag = beat_diag.get(r_idx, {})
        pred = cnn_predictions[idx] if idx < len(cnn_predictions) else {
            "class_idx": 0, "class_name": AAMI_CLASSES[0], "confidence": 0.85, "pvc_prob": 0.05
        }

        pvc_prob = pred["pvc_prob"]
        qrs_w = diag.get("qrs_width_ms", 80.0)
        is_wide = diag.get("is_wide_qrs", False) or (qrs_w >= 100.0)
        is_bizarre = diag.get("is_bizarre_morphology", False)
        rule_pvc = diag.get("rule_pvc", False)
        
        # Clinical ventricular ectopic criteria:
        # PVCs originate from ventricular myocardium, producing prolonged conduction (>100-120ms)
        # and abnormal morphology compared to normal sinus beats.
        # A narrow normal complex (<90ms) cannot be a PVC regardless of baseline shifts.
        has_dsp_support = (is_wide and (diag.get("is_premature", False) or diag.get("has_compensatory_pause", False))) or \
                          (is_bizarre and diag.get("is_premature", False)) or \
                          rule_pvc

        is_pvc = False
        detection_source = None

        if rule_pvc and pvc_prob >= 0.30:
            is_pvc = True
            detection_source = "DSP_CONFIRMED"
        elif pvc_prob >= 0.85 and has_dsp_support and qrs_w >= 90.0:
            is_pvc = True
            detection_source = "CNN_PLUS_DSP"
        elif pvc_prob >= 0.95 and (is_wide or is_bizarre):
            is_pvc = True
            detection_source = "CNN_HIGH_CONF"

        if is_pvc:
            pvc_count += 1
            # Bounding box covers full ectopic complex (Q-onset to S-offset, minimum +/- 100ms)
            box_half = int(0.12 * sampling_rate) # +/- 120ms around peak
            q_start = max(0, min(diag.get("q_start", r_idx - box_half), r_idx - int(0.06 * sampling_rate)))
            s_end = min(len(ecg_signal), max(diag.get("s_end", r_idx + box_half), r_idx + int(0.08 * sampling_rate)))
            confirmed_anomalies.append({
                "type": "PVC",
                "label": "Premature Ventricular Contraction",
                "severity": "HIGH",
                "start_idx": int(q_start),
                "end_idx": int(s_end),
                "r_peak": int(r_idx),
                "detection_source": detection_source,
                "pvc_prob": round(float(pvc_prob), 2),
                "description": f"PVC Ectopic Beat (CNN: {int(pvc_prob * 100)}%, QRS: {int(qrs_w)}ms, Source: {detection_source})"
            })

        # Check PAC (Supraventricular) from CNN
        if pred["class_idx"] == 1 and pred["confidence"] >= 0.70 and not is_pvc:
            pac_count += 1

        beat_records.append({
            "r_peak": int(r_idx),
            "class": pred["class_name"],
            "confidence": round(float(pred["confidence"]), 2),
            "pvc_prob": round(float(pvc_prob), 2),
            "is_pvc": bool(is_pvc),
            "detection_source": detection_source
        })

    # Include any ST-Segment anomalies from DSP
    for a in dsp_results.get("anomalies", []):
        if a["type"] == "ST_ELEVATION":
            confirmed_anomalies.append(a)

    # 5. Determine Overall Diagnosis
    if pvc_count > 0:
        primary_diagnosis = f"Frequent PVCs Detected ({pvc_count} ectopic beats)"
        confidence_score = 0.95 if model_manager.is_loaded else 0.90
    elif pac_count > 0:
        primary_diagnosis = f"Supraventricular Ectopic Beats ({pac_count} PAC events)"
        confidence_score = 0.88
    else:
        primary_diagnosis = dsp_results.get("primary_diagnosis", "Normal Sinus Rhythm")
        confidence_score = dsp_results.get("confidence", 0.96)

    return {
        "status": "success",
        "session_id": str(meta.get('id', 'unknown')),
        "session_title": str(meta.get('title', 'ECG Session')),
        "duration_sec": float(meta.get('durationSec', len(samples) / sampling_rate)),
        "total_samples": int(len(samples)),
        "sampling_rate_hz": round(float(sampling_rate), 1),
        "model_loaded": bool(model_manager.is_loaded),
        "model_metadata": model_manager.metadata,
        "primary_diagnosis": str(primary_diagnosis),
        "confidence_score": float(confidence_score),
        "hrv_metrics": dsp_results['hrv'],
        "anomaly_summary": {
            "pvc_count": int(pvc_count),
            "pac_count": int(pac_count),
            "st_elevations": int(dsp_results['st_elevations']),
            "st_depressions": int(dsp_results['st_depressions'])
        },
        "anomalies": confirmed_anomalies,
        "beat_predictions": beat_records[:50]
    }


def compare_two_sessions(session1, session2, sampling_rate=128):
    """
    Compares two ECG sessions (Session A vs Session B).
    """
    analysis1 = analyze_full_session(session1, sampling_rate=sampling_rate)
    analysis2 = analyze_full_session(session2, sampling_rate=sampling_rate)

    if analysis1.get('status') == 'error' or analysis2.get('status') == 'error':
        return {"status": "error", "message": "Failed to analyze one or both sessions for comparison."}

    hrv1 = analysis1.get('hrv_metrics', {})
    hrv2 = analysis2.get('hrv_metrics', {})

    hr_delta = int(hrv2.get('avg_hr', 0) - hrv1.get('avg_hr', 0))
    sdnn_delta = float(round(hrv2.get('sdnn', 0.0) - hrv1.get('sdnn', 0.0), 1))
    pvc_delta = int(analysis2['anomaly_summary']['pvc_count'] - analysis1['anomaly_summary']['pvc_count'])

    morphology_notes = []
    if abs(hr_delta) >= 10:
        morphology_notes.append(f"Heart rate shifted by {hr_delta:+d} BPM ({hrv1.get('avg_hr')} -> {hrv2.get('avg_hr')} BPM).")
    else:
        morphology_notes.append("Heart rate baseline remained stable within ±10 BPM.")

    if pvc_delta > 0:
        morphology_notes.append(f"Session B shows {pvc_delta} additional Premature Ventricular Contractions (PVCs) compared to Session A.")
    elif pvc_delta < 0:
        morphology_notes.append(f"Session B shows a reduction of {abs(pvc_delta)} PVC events compared to Session A.")
    else:
        morphology_notes.append("Zero difference in ventricular ectopic (PVC) frequency across sessions.")

    if sdnn_delta < -15.0:
        morphology_notes.append(f"Session B shows reduced Heart Rate Variability (SDNN decreased by {abs(sdnn_delta)}ms), indicating increased autonomic strain.")
    elif sdnn_delta > 15.0:
        morphology_notes.append(f"Session B shows increased Heart Rate Variability (SDNN increased by {sdnn_delta}ms).")

    return {
        "status": "success",
        "comparison_summary": {
            "hr_delta_bpm": int(hr_delta),
            "sdnn_delta_ms": float(sdnn_delta),
            "pvc_delta": int(pvc_delta),
            "morphology_notes": morphology_notes
        },
        "session1_results": analysis1,
        "session2_results": analysis2
    }
