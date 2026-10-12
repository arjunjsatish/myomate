import numpy as np
from scipy import signal

TARGET_FS = 128
PRE_SAMPLES = int(0.28 * TARGET_FS)   # 35 samples (~273 ms before R-peak)
POST_SAMPLES = int(0.47 * TARGET_FS)  # 60 samples (~469 ms after R-peak)
WINDOW_LEN = PRE_SAMPLES + POST_SAMPLES + 1  # 96 samples (~750 ms total)

def bandpass_filter(data, fs=TARGET_FS, lowcut=0.5, highcut=40.0, order=2):
    """
    Standard clinical 0.5 - 40 Hz bandpass Butterworth filter.
    Removes baseline wander (<0.5 Hz) and high-frequency EMG noise (>40 Hz).
    """
    nyquist = 0.5 * fs
    low = max(0.01, min(lowcut / nyquist, 0.99))
    high = max(low + 0.01, min(highcut / nyquist, 0.99))
    b, a = signal.butter(order, [low, high], btype='band')
    return signal.filtfilt(b, a, data)

def resample_signal(data, orig_fs, target_fs=TARGET_FS):
    """
    Resamples 1D ECG array from orig_fs to target_fs (128 Hz).
    """
    if orig_fs == target_fs or len(data) == 0:
        return np.asarray(data, dtype=np.float32)
    num_target_samples = int(round(len(data) * float(target_fs) / float(orig_fs)))
    resampled = signal.resample(data, num_target_samples)
    return np.asarray(resampled, dtype=np.float32)

def extract_beat_window(filtered_ecg_128, r_peak_128):
    """
    Extracts a 96-sample beat window centered on the R-peak at 128 Hz.
    Fine-tunes center within +/- 6 samples (~46 ms) if a local maximum exists nearby.
    Returns normalized window (mean=0, std=1) with shape (WINDOW_LEN,).
    """
    # Fine-tune peak center within +/- 6 samples
    search_start = max(0, r_peak_128 - 6)
    search_end = min(len(filtered_ecg_128), r_peak_128 + 7)
    if search_start < search_end:
        refined_center = search_start + int(np.argmax(np.abs(filtered_ecg_128[search_start:search_end])))
    else:
        refined_center = r_peak_128

    start = refined_center - PRE_SAMPLES
    end = refined_center + POST_SAMPLES + 1

    # Extract slice with zero-padding if near signal boundaries
    sig_len = len(filtered_ecg_128)
    if start < 0 or end > sig_len:
        pad_left = max(0, -start)
        pad_right = max(0, end - sig_len)
        valid_start = max(0, start)
        valid_end = min(sig_len, end)
        segment = filtered_ecg_128[valid_start:valid_end]
        beat = np.pad(segment, (pad_left, pad_right), mode='edge')
    else:
        beat = filtered_ecg_128[start:end].copy()

    # Z-score normalization for scale invariance (µV vs mV)
    std_val = float(np.std(beat))
    if std_val > 1e-4:
        beat = (beat - float(np.mean(beat))) / std_val
    else:
        beat = beat - float(np.mean(beat))

    return beat.astype(np.float32)

def compute_rr_features(r_peaks_128, fs=TARGET_FS):
    """
    Computes 4 timing features per beat from R-peak locations:
    1. pre_rr / local_mean_rr (prematurity ratio: <0.8 indicates premature beat)
    2. post_rr / local_mean_rr (post-beat compensatory pause ratio: >1.2 indicates pause)
    3. pre_rr / post_rr
    4. local_mean_rr (in seconds)
    
    Returns array of shape (N, 4).
    """
    n = len(r_peaks_128)
    if n == 0:
        return np.empty((0, 4), dtype=np.float32)
    if n == 1:
        return np.array([[1.0, 1.0, 1.0, 0.8]], dtype=np.float32)

    rr_intervals = np.diff(r_peaks_128).astype(np.float32) / float(fs)  # in seconds
    features = np.zeros((n, 4), dtype=np.float32)

    for i in range(n):
        # Determine local context window (+/- 5 beats)
        start_idx = max(0, i - 5)
        end_idx = min(len(rr_intervals), i + 5)
        local_window = rr_intervals[start_idx:end_idx]
        local_mean = float(np.median(local_window)) if len(local_window) > 0 else 0.8
        local_mean = max(0.25, min(local_mean, 2.0))

        # pre_rr
        if i == 0:
            pre_rr = rr_intervals[0]
        else:
            pre_rr = rr_intervals[i - 1]

        # post_rr
        if i < len(rr_intervals):
            post_rr = rr_intervals[i]
        else:
            post_rr = rr_intervals[-1]

        ratio_pre = float(pre_rr / local_mean)
        ratio_post = float(post_rr / local_mean)
        ratio_pre_post = float(pre_rr / max(post_rr, 1e-3))

        features[i] = [ratio_pre, ratio_post, ratio_pre_post, local_mean]

    return features
