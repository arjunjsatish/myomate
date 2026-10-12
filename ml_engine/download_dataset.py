#!/usr/bin/env python3
"""
Fast Parallel PhysioNet MIT-BIH Arrhythmia Database Downloader
Downloads standard benchmark records for de Chazal DS1/DS2 evaluation.
Excludes paced records (102, 104, 107, 217).
"""
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

DS1_RECORDS = [
    '101', '106', '108', '109', '112', '114', '115', '116', '118', '119',
    '122', '124', '201', '203', '205', '207', '208', '209', '215', '220',
    '223', '230'
]

DS2_RECORDS = [
    '100', '103', '105', '111', '113', '117', '121', '123', '200', '202',
    '210', '212', '213', '214', '219', '221', '222', '228', '231', '232',
    '233', '234'
]

ALL_44_RECORDS = DS1_RECORDS + DS2_RECORDS
BASE_URL = "https://physionet.org/files/mitdb/1.0.0"

def download_file(url, target_path):
    if os.path.exists(target_path) and os.path.getsize(target_path) > 0:
        return target_path, True
    try:
        req = urllib.request.Request(
            url,
            headers={'User-Agent': 'Mozilla/5.0 (MyoMate ECG Pipeline)'}
        )
        with urllib.request.urlopen(req, timeout=30) as response, open(target_path, 'wb') as out_file:
            out_file.write(response.read())
        return target_path, False
    except Exception as e:
        if os.path.exists(target_path):
            os.remove(target_path)
        raise RuntimeError(f"Error downloading {url}: {e}")

def download_mitdb_sample_records(records=ALL_44_RECORDS, max_workers=8):
    data_dir = os.path.join(os.path.dirname(__file__), 'data', 'mitdb')
    os.makedirs(data_dir, exist_ok=True)
    print(f"[MIT-BIH Fast Downloader] Target directory: {data_dir} (Parallel workers: {max_workers})")

    download_tasks = []
    for r in records:
        for ext in ['.hea', '.dat', '.atr']:
            url = f"{BASE_URL}/{r}{ext}"
            target_path = os.path.join(data_dir, f"{r}{ext}")
            download_tasks.append((url, target_path, r, ext))

    completed = 0
    skipped = 0
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(download_file, url, path): (r, ext) for url, path, r, ext in download_tasks}
        for future in as_completed(futures):
            r, ext = futures[future]
            try:
                _, was_cached = future.result()
                if was_cached:
                    skipped += 1
                else:
                    completed += 1
                    print(f"  [Downloaded] {r}{ext} ({completed} new files downloaded)")
            except Exception as e:
                print(f"  [Warning] Failed {r}{ext}: {e}")

    print(f"[MIT-BIH Fast Downloader] Complete! New files: {completed}, Cached files: {skipped}.")
    return True

if __name__ == '__main__':
    download_mitdb_sample_records()
