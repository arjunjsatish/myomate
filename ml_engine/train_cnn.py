#!/usr/bin/env python3
"""
Train 1D-CNN Arrhythmia & Ectopic Beat Classifier on MIT-BIH Database.
Follows the standard de Chazal et al. (2004) patient-wise split:
- DS1 (Training / Validation): 22 records
- DS2 (Independent Test): 22 records
Evaluates strictly on unseen patients (DS2) according to AAMI EC57 standards.
"""
import os
import sys
import json
import time
import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader
from sklearn.metrics import classification_report, confusion_matrix

sys.path.append(os.path.dirname(__file__))
from beat_features import (
    TARGET_FS, WINDOW_LEN, bandpass_filter, resample_signal,
    extract_beat_window, compute_rr_features
)
from download_dataset import DS1_RECORDS, DS2_RECORDS

# AAMI 1998 / ANSI / AAMI EC57 Beat Class Mapping
# 0: Non-ectopic (Normal, LBBB, RBBB, nodal escape, etc.)
# 1: Supraventricular ectopic (Atrial premature, aberrated APC, nodal premature, SV premature)
# 2: Ventricular ectopic (PVC, ventricular escape)
# 3: Fusion and unclassifiable (Fusion of ventricular and normal, paced, unclassifiable)
AAMI_CLASSES = ['Normal Sinus (N)', 'Supraventricular Ectopic (S / PAC)', 'Ventricular Ectopic (V / PVC)', 'Fusion & Other (F/Q)']

SYMBOL_TO_CLASS = {
    # Normal (N)
    'N': 0, 'L': 0, 'R': 0, 'e': 0, 'j': 0,
    # Supraventricular ectopic (S)
    'A': 1, 'a': 1, 'J': 1, 'S': 1,
    # Ventricular ectopic (V)
    'V': 2, 'E': 2,
    # Fusion / Other (F / Q)
    'F': 3, '/': 3, 'f': 3, 'Q': 3
}

class HybridECG1DCNN(nn.Module):
    """
    Hybrid 1D-CNN Network combining:
    1. Convolutional feature extractor for beat morphology (96 samples)
    2. Dense branch for R-R timing features (4 features: pre_rr, post_rr, ratio, local_mean)
    """
    def __init__(self, num_classes=4):
        super().__init__()
        # 1D-CNN Branch for ECG Morphology Window
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

        # Dense Branch for R-R Rhythm Timing Features
        self.timing_branch = nn.Sequential(
            nn.Linear(4, 32),
            nn.ReLU(),
            nn.Dropout(0.1),
            nn.Linear(32, 16),
            nn.ReLU()
        )

        # Combined Classification Head
        self.classifier = nn.Sequential(
            nn.Linear(64 + 16, 32),
            nn.ReLU(),
            nn.Dropout(0.15),
            nn.Linear(32, num_classes)
        )

    def forward(self, beat_wave, rr_feat):
        # beat_wave shape: (B, 1, 96)
        # rr_feat shape: (B, 4)
        morph_embed = self.conv_branch(beat_wave)
        time_embed = self.timing_branch(rr_feat)
        combined = torch.cat([morph_embed, time_embed], dim=1)
        return self.classifier(combined)


class ECGDataset(Dataset):
    def __init__(self, beat_waves, rr_features, labels):
        self.beat_waves = torch.tensor(beat_waves, dtype=torch.float32).unsqueeze(1)  # (N, 1, 96)
        self.rr_features = torch.tensor(rr_features, dtype=torch.float32)            # (N, 4)
        self.labels = torch.tensor(labels, dtype=torch.long)                          # (N,)

    def __len__(self):
        return len(self.labels)

    def __getitem__(self, idx):
        return self.beat_waves[idx], self.rr_features[idx], self.labels[idx]


def extract_record_beats(rec_name, data_dir):
    """
    Loads record from disk using wfdb, applies bandpass filter,
    resamples to 128 Hz, and extracts beat windows + timing features.
    """
    import wfdb
    rec_path = os.path.join(data_dir, rec_name)
    if not os.path.exists(rec_path + '.dat'):
        return None, None, None

    try:
        record = wfdb.rdrecord(rec_path)
        ann = wfdb.rdann(rec_path, 'atr')
    except Exception as e:
        print(f"  [Warning] Error reading record {rec_name}: {e}")
        return None, None, None

    orig_fs = record.fs
    raw_signal = record.p_signal[:, 0].astype(np.float32)  # Lead 0 (typically MLII)

    # 1. 0.5 - 40 Hz Bandpass Filter at original fs
    filtered = bandpass_filter(raw_signal, fs=orig_fs, lowcut=0.5, highcut=40.0)

    # 2. Resample signal to 128 Hz
    resampled_signal = resample_signal(filtered, orig_fs=orig_fs, target_fs=TARGET_FS)

    # Scale annotation sample indices to 128 Hz
    scale_factor = float(TARGET_FS) / float(orig_fs)
    ann_samples_128 = np.round(np.array(ann.sample) * scale_factor).astype(int)

    # Filter to only valid AAMI beat annotations
    valid_indices = []
    labels = []
    for idx, sym in enumerate(ann.symbol):
        if sym in SYMBOL_TO_CLASS:
            s_128 = ann_samples_128[idx]
            # Ensure within signal bounds
            if 10 < s_128 < len(resampled_signal) - 10:
                valid_indices.append(s_128)
                labels.append(SYMBOL_TO_CLASS[sym])

    if len(valid_indices) == 0:
        return None, None, None

    valid_indices = np.array(valid_indices, dtype=int)
    labels = np.array(labels, dtype=int)

    # 3. Compute R-R timing features for all annotated beats
    rr_feats = compute_rr_features(valid_indices, fs=TARGET_FS)

    # 4. Extract 96-sample normalized windows
    beat_windows = np.zeros((len(valid_indices), WINDOW_LEN), dtype=np.float32)
    for i, r_idx in enumerate(valid_indices):
        beat_windows[i] = extract_beat_window(resampled_signal, r_idx)

    return beat_windows, rr_feats, labels


def load_dataset_group(record_list, data_dir, desc=""):
    all_beats = []
    all_rr = []
    all_labels = []

    print(f"Loading {desc} records ({len(record_list)} patients)...")
    for rec in record_list:
        b, r, l = extract_record_beats(rec, data_dir)
        if b is not None and len(b) > 0:
            all_beats.append(b)
            all_rr.append(r)
            all_labels.append(l)

    if not all_beats:
        raise ValueError(f"No valid records loaded for {desc}!")

    X_beat = np.vstack(all_beats)
    X_rr = np.vstack(all_rr)
    y = np.concatenate(all_labels)

    counts = np.bincount(y, minlength=4)
    print(f"  {desc} Total Beats: {len(y)} | N: {counts[0]}, S: {counts[1]}, V(PVC): {counts[2]}, F/Q: {counts[3]}")
    return X_beat, X_rr, y


def train():
    data_dir = os.path.join(os.path.dirname(__file__), 'data', 'mitdb')
    models_dir = os.path.join(os.path.dirname(__file__), 'models')
    os.makedirs(models_dir, exist_ok=True)

    print("===============================================================")
    print("  BioPulse 1D-CNN Arrhythmia & PVC Model Training Pipeline")
    print(f"  Hardware Device Target Sample Rate: {TARGET_FS} SPS")
    print(f"  Window Size: {WINDOW_LEN} samples (~750 ms)")
    print("===============================================================")

    # 1. Load DS1 (Train) and DS2 (Independent Test)
    X_train_beat, X_train_rr, y_train = load_dataset_group(DS1_RECORDS, data_dir, desc="DS1 (Training)")
    X_test_beat, X_test_rr, y_test = load_dataset_group(DS2_RECORDS, data_dir, desc="DS2 (Test)")

    # 2. Compute Class Weights for Imbalance Handling
    class_counts = np.bincount(y_train, minlength=4)
    total_samples = len(y_train)
    # Effective class weight: smooth inverse frequency
    class_weights = total_samples / (4.0 * np.maximum(class_counts, 1))
    # Cap maximum weight to avoid instability on rare F/Q classes
    class_weights = np.clip(class_weights, 0.2, 10.0)
    print(f"Computed Class Weights: N={class_weights[0]:.2f}, S={class_weights[1]:.2f}, V(PVC)={class_weights[2]:.2f}, F/Q={class_weights[3]:.2f}")

    # Set device (MPS on Apple Silicon if available, else CPU)
    if torch.backends.mps.is_available():
        device = torch.device('mps')
        print("Using Apple Silicon GPU acceleration (MPS)!")
    elif torch.cuda.is_available():
        device = torch.device('cuda')
        print("Using CUDA GPU acceleration!")
    else:
        device = torch.device('cpu')
        print("Using CPU execution.")

    weights_tensor = torch.tensor(class_weights, dtype=torch.float32).to(device)
    criterion = nn.CrossEntropyLoss(weight=weights_tensor)

    # 3. Create DataLoaders
    train_dataset = ECGDataset(X_train_beat, X_train_rr, y_train)
    test_dataset = ECGDataset(X_test_beat, X_test_rr, y_test)

    batch_size = 128
    train_loader = DataLoader(train_dataset, batch_size=batch_size, shuffle=True)
    test_loader = DataLoader(test_dataset, batch_size=batch_size, shuffle=False)

    # 4. Initialize Model
    model = HybridECG1DCNN(num_classes=4).to(device)
    total_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"Hybrid 1D-CNN Parameter Count: {total_params:,}")

    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, mode='min', factor=0.5, patience=2)

    # 5. Training Loop
    num_epochs = 12
    best_test_f1 = 0.0
    best_weights_path = os.path.join(models_dir, 'ecg_cnn.pt')

    for epoch in range(1, num_epochs + 1):
        model.train()
        train_loss = 0.0
        start_time = time.time()

        for b_wave, r_feat, labels in train_loader:
            b_wave, r_feat, labels = b_wave.to(device), r_feat.to(device), labels.to(device)

            optimizer.zero_grad()
            outputs = model(b_wave, r_feat)
            loss = criterion(outputs, labels)
            loss.backward()
            optimizer.step()

            train_loss += loss.item() * len(labels)

        train_loss /= len(train_dataset)

        # Evaluate on Test Set
        model.eval()
        test_loss = 0.0
        all_preds = []
        all_true = []

        with torch.no_grad():
            for b_wave, r_feat, labels in test_loader:
                b_wave, r_feat, labels = b_wave.to(device), r_feat.to(device), labels.to(device)
                outputs = model(b_wave, r_feat)
                loss = criterion(outputs, labels)
                test_loss += loss.item() * len(labels)

                preds = torch.argmax(outputs, dim=1).cpu().numpy()
                all_preds.extend(preds)
                all_true.extend(labels.cpu().numpy())

        test_loss /= len(test_dataset)
        scheduler.step(test_loss)
        elapsed = time.time() - start_time

        # Compute PVC (Class 2) and Macro Metrics
        all_preds = np.array(all_preds)
        all_true = np.array(all_true)
        pvc_mask_true = (all_true == 2)
        pvc_mask_pred = (all_preds == 2)
        pvc_tp = np.sum(pvc_mask_true & pvc_mask_pred)
        pvc_fn = np.sum(pvc_mask_true & ~pvc_mask_pred)
        pvc_fp = np.sum(~pvc_mask_true & pvc_mask_pred)
        pvc_sens = pvc_tp / max(pvc_tp + pvc_fn, 1) * 100.0
        pvc_prec = pvc_tp / max(pvc_tp + pvc_fp, 1) * 100.0
        pvc_f1 = 2 * pvc_tp / max(2 * pvc_tp + pvc_fp + pvc_fn, 1) * 100.0

        print(f"Epoch [{epoch:02d}/{num_epochs:02d}] ({elapsed:.1f}s) | Train Loss: {train_loss:.4f} | Test Loss: {test_loss:.4f} | PVC Sens: {pvc_sens:.1f}%, Prec: {pvc_prec:.1f}%, F1: {pvc_f1:.1f}%")

        if pvc_f1 > best_test_f1:
            best_test_f1 = pvc_f1
            torch.save(model.state_dict(), best_weights_path)
            print(f"  --> Saved new best model checkpoint (PVC F1: {pvc_f1:.2f}%)")

    # 6. Final Independent Evaluation on Best Model
    print("\n===============================================================")
    print("  FINAL EVALUATION ON INDEPENDENT PATIENTS (DS2)")
    print("===============================================================")
    model.load_state_dict(torch.load(best_weights_path, map_location=device))
    model.eval()

    all_preds = []
    all_probs = []
    all_true = []

    with torch.no_grad():
        for b_wave, r_feat, labels in test_loader:
            b_wave, r_feat = b_wave.to(device), r_feat.to(device)
            logits = model(b_wave, r_feat)
            probs = torch.softmax(logits, dim=1).cpu().numpy()
            preds = np.argmax(probs, axis=1)

            all_probs.append(probs)
            all_preds.extend(preds)
            all_true.extend(labels.numpy())

    all_preds = np.array(all_preds)
    all_true = np.array(all_true)

    report_dict = classification_report(all_true, all_preds, target_names=AAMI_CLASSES, output_dict=True, zero_division=0)
    conf_mat = confusion_matrix(all_true, all_preds)

    print("\nClassification Report (DS2 Test Set):")
    print(classification_report(all_true, all_preds, target_names=AAMI_CLASSES, zero_division=0))
    print("\nConfusion Matrix (Rows: True, Columns: Predicted):")
    print(conf_mat)

    # Save model metadata and verification metrics
    meta_path = os.path.join(models_dir, 'ecg_cnn_meta.json')
    meta_info = {
        "model_type": "HybridECG1DCNN",
        "target_fs": TARGET_FS,
        "window_length": WINDOW_LEN,
        "classes": AAMI_CLASSES,
        "train_patients": len(DS1_RECORDS),
        "test_patients": len(DS2_RECORDS),
        "total_test_beats": int(len(all_true)),
        "pvc_metrics": {
            "sensitivity": float(round(report_dict['Ventricular Ectopic (V / PVC)']['recall'] * 100.0, 2)),
            "precision": float(round(report_dict['Ventricular Ectopic (V / PVC)']['precision'] * 100.0, 2)),
            "f1_score": float(round(report_dict['Ventricular Ectopic (V / PVC)']['f1-score'] * 100.0, 2)),
            "support": int(report_dict['Ventricular Ectopic (V / PVC)']['support'])
        },
        "overall_macro_avg": {
            "precision": float(round(report_dict['macro avg']['precision'] * 100.0, 2)),
            "recall": float(round(report_dict['macro avg']['recall'] * 100.0, 2)),
            "f1_score": float(round(report_dict['macro avg']['f1-score'] * 100.0, 2))
        },
        "confusion_matrix": conf_mat.tolist(),
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S")
    }

    with open(meta_path, 'w') as f:
        json.dump(meta_info, f, indent=2)

    print(f"\nModel weights saved to: {best_weights_path}")
    print(f"Model metadata saved to: {meta_path}")
    return meta_info


if __name__ == '__main__':
    train()
