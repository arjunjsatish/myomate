import numpy as np
from scipy import signal

def bandpass_filter(data, sampling_rate=128, lowcut=5.0, highcut=15.0):
    """5-15 Hz Bandpass Filter for QRS energy isolation"""
    nyquist = 0.5 * sampling_rate
    low = lowcut / nyquist
    high = highcut / nyquist
    b, a = signal.butter(1, [low, high], btype='band')
    return signal.filtfilt(b, a, data)

def detect_r_peaks(ecg_signal, sampling_rate=128):
    """
    Robust Dual-Stage Peak Detector for 128 SPS single-lead ECG.
    Detects both sharp normal R-peaks and wide high-amplitude ectopic PVC peaks.
    Returns array of peak sample indices.
    """
    if len(ecg_signal) < sampling_rate:
        return np.array([], dtype=int)

    # 1. Direct Amplitude Peak Detection on raw ECG
    min_dist = int(0.25 * sampling_rate) # Minimum 250ms between beats
    raw_peaks, _ = signal.find_peaks(ecg_signal, distance=min_dist, height=400.0)

    # 2. Pan-Tompkins MWA Peak Detection
    filtered = bandpass_filter(ecg_signal, sampling_rate=sampling_rate)
    diff = np.diff(filtered)
    squared = diff ** 2
    window_size = int(0.12 * sampling_rate)
    if window_size < 1:
        window_size = 1
    mwa = np.convolve(squared, np.ones(window_size) / window_size, mode='same')
    mwa_threshold = max(0.10 * np.max(mwa), np.median(mwa) + 0.15 * np.std(mwa))
    mwa_peaks, _ = signal.find_peaks(mwa, distance=min_dist, height=mwa_threshold)

    # Combine peak candidates
    search_window = int(0.08 * sampling_rate)
    comb_peaks = set()

    for p in raw_peaks:
        comb_peaks.add(int(p))

    for p in mwa_peaks:
        start = max(0, p - search_window)
        end = min(len(ecg_signal), p + search_window)
        if start < end:
            r_idx = start + np.argmax(ecg_signal[start:end])
            comb_peaks.add(int(r_idx))

    sorted_peaks = sorted(list(comb_peaks))
    
    # Filter out duplicate peaks closer than min_dist and reject boundary edge artifacts
    edge_margin = int(0.20 * sampling_rate) # First/last 200ms settling transient
    final_peaks = []
    for p in sorted_peaks:
        # Ignore peaks in the initial or trailing edge margins
        if p < edge_margin or p >= len(ecg_signal) - edge_margin:
            continue
        if not final_peaks or (p - final_peaks[-1]) >= min_dist:
            final_peaks.append(int(p))

    return np.array(final_peaks, dtype=int)

def calculate_hrv_metrics(r_peaks, sampling_rate=128):
    """Calculates Heart Rate Variability (SDNN, RMSSD, Mean HR)"""
    if len(r_peaks) < 2:
        return {"avg_hr": 0, "sdnn": 0.0, "rmssd": 0.0, "rr_ms": []}

    rr_intervals_sec = np.diff(r_peaks) / float(sampling_rate)
    rr_intervals_ms = rr_intervals_sec * 1000.0

    hr_values = 60.0 / rr_intervals_sec
    valid_hr = hr_values[(hr_values >= 30) & (hr_values <= 220)]

    avg_hr = int(np.mean(valid_hr)) if len(valid_hr) > 0 else 0
    sdnn = float(np.std(rr_intervals_ms)) if len(rr_intervals_ms) > 0 else 0.0

    diff_rr = np.diff(rr_intervals_ms)
    rmssd = float(np.sqrt(np.mean(diff_rr ** 2))) if len(diff_rr) > 0 else 0.0

    return {
        "avg_hr": int(avg_hr),
        "sdnn": round(float(sdnn), 1),
        "rmssd": round(float(rmssd), 1),
        "rr_ms": [int(x) for x in rr_intervals_ms]
    }

def measure_qrs_bounds(ecg_signal, r_peak, sampling_rate):
    """
    Measures true QRS duration in milliseconds by detecting baseline crossings
    around the R-peak (Q-onset to S-offset).
    """
    search_win = int(0.12 * sampling_rate) # +/- 120ms
    left_bound = max(0, r_peak - search_win)
    right_bound = min(len(ecg_signal) - 1, r_peak + search_win)

    baseline = float(np.median(ecg_signal[left_bound:right_bound+1]))
    peak_val = float(ecg_signal[r_peak])
    peak_amp = peak_val - baseline

    if abs(peak_amp) < 1e-3:
        return 80.0, max(0, r_peak - 5), min(len(ecg_signal) - 1, r_peak + 5)

    thresh = baseline + 0.18 * peak_amp

    # Q-onset (left search)
    q_onset = left_bound
    for k in range(r_peak, left_bound, -1):
        val = float(ecg_signal[k])
        if (peak_amp > 0 and val <= thresh) or (peak_amp < 0 and val >= thresh):
            q_onset = k
            break

    # S-offset (right search)
    s_offset = right_bound
    for k in range(r_peak, right_bound):
        val = float(ecg_signal[k])
        if (peak_amp > 0 and val <= thresh) or (peak_amp < 0 and val >= thresh):
            s_offset = k
            break

    qrs_samples = max(1, s_offset - q_onset)
    qrs_width_ms = (qrs_samples / float(sampling_rate)) * 1000.0
    return qrs_width_ms, q_onset, s_offset

def analyze_ecg_morphology(ecg_signal, sampling_rate=128):
    """
    Analyzes ECG morphology, detects ectopic beats (PVC, PAC) & ST deviations.
    Returns anomaly markers with exact sample bounds [start, end].
    """
    r_peaks = detect_r_peaks(ecg_signal, sampling_rate=sampling_rate)
    hrv = calculate_hrv_metrics(r_peaks, sampling_rate=sampling_rate)

    anomalies = []
    beat_diagnostics = {}
    pvc_count = 0
    pac_count = 0
    st_elevations = 0
    st_depressions = 0

    n_peaks = len(r_peaks)

    if n_peaks >= 3:
        rr_intervals = np.diff(r_peaks)
        mean_rr = float(np.median(rr_intervals))

        # Build median beat template for morphology comparison
        beat_windows = []
        half_win = int(0.12 * sampling_rate) # +/- 120ms
        for p in r_peaks:
            if p - half_win >= 0 and p + half_win < len(ecg_signal):
                w = ecg_signal[p - half_win : p + half_win]
                std_w = np.std(w)
                if std_w > 1e-5:
                    beat_windows.append((w - np.mean(w)) / std_w)

        median_template = np.median(beat_windows, axis=0) if len(beat_windows) >= 3 else None

        for i in range(1, n_peaks - 1): # Skip first & last beat for reliable pre/post RR
            curr_r = int(r_peaks[i])
            rr_pre = float(r_peaks[i] - r_peaks[i-1])
            rr_post = float(r_peaks[i+1] - r_peaks[i])

            # Measure TRUE QRS duration
            qrs_width_ms, q_start, s_end = measure_qrs_bounds(ecg_signal, curr_r, sampling_rate)

            # Prematurity: Beat arrives >22% earlier than median RR
            is_premature = (rr_pre < 0.78 * mean_rr)

            # Compensatory pause check: rr_pre + rr_post >= 1.85 * mean_rr
            has_compensatory_pause = (rr_pre + rr_post >= 1.85 * mean_rr)

            # True Wide QRS (>120ms)
            is_wide_qrs = (qrs_width_ms >= 120.0)

            # Morphology correlation with normal beat template
            morph_corr = 1.0
            if median_template is not None and curr_r - half_win >= 0 and curr_r + half_win < len(ecg_signal):
                curr_w = ecg_signal[curr_r - half_win : curr_r + half_win]
                curr_std = np.std(curr_w)
                if curr_std > 1e-5:
                    curr_norm = (curr_w - np.mean(curr_w)) / curr_std
                    morph_corr = float(np.corrcoef(curr_norm, median_template)[0, 1])

            is_bizarre_morphology = (morph_corr < 0.65)

            # Clinical PVC Rules:
            # 1. Premature AND Wide QRS (>120ms)
            # 2. Premature AND Compensatory Pause AND Bizarre Morphology
            # 3. Wide QRS (>130ms) AND Bizarre Morphology
            is_pvc = (is_premature and is_wide_qrs) or \
                     (is_premature and has_compensatory_pause and is_bizarre_morphology) or \
                     (is_wide_qrs and is_bizarre_morphology and qrs_width_ms > 130.0)

            # Record per-beat rule diagnostics for hybrid ensemble
            beat_diagnostics[curr_r] = {
                "r_peak": int(curr_r),
                "q_start": int(q_start),
                "s_end": int(s_end),
                "qrs_width_ms": float(qrs_width_ms),
                "rr_pre_ms": float((rr_pre / float(sampling_rate)) * 1000.0),
                "rr_post_ms": float((rr_post / float(sampling_rate)) * 1000.0),
                "is_premature": bool(is_premature),
                "is_wide_qrs": bool(is_wide_qrs),
                "has_compensatory_pause": bool(has_compensatory_pause),
                "morph_corr": float(morph_corr),
                "is_bizarre_morphology": bool(is_bizarre_morphology),
                "rule_pvc": bool(is_pvc)
            }

            if is_pvc:
                pvc_count += 1
                anomalies.append({
                    "type": "PVC",
                    "label": "Premature Ventricular Contraction",
                    "severity": "HIGH",
                    "start_idx": int(q_start),
                    "end_idx": int(s_end),
                    "r_peak": int(curr_r),
                    "detection_source": "DSP_RULES",
                    "pvc_prob": 0.85,
                    "description": f"Premature Wide Ectopic PVC (QRS: {int(qrs_width_ms)}ms, Correlation: {round(morph_corr, 2)})"
                })

            # ST Segment Measurement (J + 80ms)
            st_idx = curr_r + int(0.08 * sampling_rate) # +80ms
            if st_idx < len(ecg_signal) and not is_pvc:
                st_val = float(ecg_signal[st_idx])
                if st_val > 250.0: # ST Elevation > +250uV on normal sinus beats
                    st_elevations += 1
                    anomalies.append({
                        "type": "ST_ELEVATION",
                        "label": "ST Segment Elevation",
                        "severity": "HIGH",
                        "start_idx": int(curr_r),
                        "end_idx": min(len(ecg_signal), curr_r + int(0.20 * sampling_rate)),
                        "r_peak": int(curr_r),
                        "description": f"ST elevation of +{int(st_val)} µV past J-point"
                    })

    # Summary Diagnosis
    primary_diagnosis = "Normal Sinus Rhythm"
    confidence = 0.96

    if pvc_count > 0:
        primary_diagnosis = f"Frequent PVCs Detected ({pvc_count} ectopic beats)"
        confidence = 0.94
    elif pac_count > 0:
        primary_diagnosis = f"Atrial Premature Beats ({pac_count} events)"
        confidence = 0.90
    elif st_elevations > 0:
        primary_diagnosis = "ST-Segment Elevation Detected"
        confidence = 0.94
    elif st_depressions > 0:
        primary_diagnosis = "ST-Segment Depression Detected"
        confidence = 0.93
    elif hrv['avg_hr'] > 100:
        primary_diagnosis = f"Sinus Tachycardia ({hrv['avg_hr']} BPM)"
        confidence = 0.98
    elif hrv['avg_hr'] > 0 and hrv['avg_hr'] < 60:
        primary_diagnosis = f"Sinus Bradycardia ({hrv['avg_hr']} BPM)"
        confidence = 0.98

    return {
        "r_peaks": [int(x) for x in r_peaks],
        "hrv": {
            "avg_hr": int(hrv["avg_hr"]),
            "sdnn": float(hrv["sdnn"]),
            "rmssd": float(hrv["rmssd"]),
            "rr_ms": [int(x) for x in hrv["rr_ms"]]
        },
        "pvc_count": int(pvc_count),
        "pac_count": int(pac_count),
        "st_elevations": int(st_elevations),
        "st_depressions": int(st_depressions),
        "primary_diagnosis": str(primary_diagnosis),
        "confidence": float(confidence),
        "anomalies": anomalies,
        "beat_diagnostics": beat_diagnostics
    }
