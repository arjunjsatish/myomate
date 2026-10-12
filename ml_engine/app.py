#!/usr/bin/env python3
"""
BioPulse Python AI Microservice
Port: 5005
Provides AI/ML Anomaly Detection, HRV Extraction & ECG Session Comparison
"""
import os
import sys
import threading
from flask import Flask, request, jsonify

sys.path.append(os.path.dirname(__file__))

from model import analyze_full_session, compare_two_sessions, model_manager

app = Flask(__name__)

@app.route('/', methods=['GET'])
def index():
    return jsonify({
        "status": "online",
        "service": "BioPulse Python AI & ML Anomaly Microservice Engine",
        "version": "1.0.0",
        "model_loaded": bool(model_manager.is_loaded),
        "model_metadata": model_manager.metadata,
        "endpoints": {
            "health": "/health",
            "analyze": "POST /api/ai/analyze",
            "compare": "POST /api/ai/compare"
        }
    })

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        "status": "ok",
        "service": "BioPulse Python AI Engine",
        "version": "1.0.0",
        "model_loaded": bool(model_manager.is_loaded),
        "model_metadata": model_manager.metadata
    })

@app.route('/api/ai/analyze', methods=['POST'])
def api_analyze():
    try:
        req_data = request.get_json(force=True)
        if not req_data:
            return jsonify({"status": "error", "message": "No JSON payload provided"}), 400

        session_data = req_data.get('session') or req_data
        result = analyze_full_session(session_data)
        return jsonify(result)
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/ai/compare', methods=['POST'])
def api_compare():
    try:
        req_data = request.get_json(force=True)
        if not req_data:
            return jsonify({"status": "error", "message": "No JSON payload provided"}), 400

        session1 = req_data.get('session1')
        session2 = req_data.get('session2')

        if not session1 or not session2:
            return jsonify({"status": "error", "message": "Both session1 and session2 are required for comparison"}), 400

        result = compare_two_sessions(session1, session2)
        return jsonify(result)
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

if __name__ == '__main__':
    print("===========================================================")
    print("  BioPulse Python AI & ML Anomaly Microservice Engine")
    print("  Listening on http://localhost:5005")
    print("===========================================================")

    app.run(host='0.0.0.0', port=5005, debug=False)
