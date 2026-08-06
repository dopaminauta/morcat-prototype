#!/usr/bin/env python3
"""
Morcat × Sumsub — Webhook Listener (sandbox)

Recibe el webhook `applicantReviewed` de Sumsub, valida la firma HMAC,
y emite el claim on-chain en el IdentityRegistry del T-REX.

Correr:
    SUMSUB_APP_TOKEN=... SUMSUB_SECRET_KEY=... python3 webhook_server.py

Exponer al exterior (para que Sumsub llegue):
    ngrok http 8080   (o cloudflared tunnel — el que ya usamos)

Notas:
- Sumsub espera respuesta 200 rápido; el trabajo pesado (claim on-chain)
  debe ir a una cola/background si se complica.
- En sandbox, Sumsub NO tiene aprobación automática real: usá los
  document templates del dashboard para resultados predecibles.
"""
import hashlib
import hmac
import json
import os
import threading
from pathlib import Path

from flask import Flask, request, jsonify

from sumsub_kyc import load_env, verify_webhook, claim_onchain

app = Flask(__name__)
SECRET_KEY = os.environ.get("SUMSUB_SECRET_KEY", "")

# Almacén en memoria: applicantId -> wallet (en prod: DB)
APPLICANTS = {}
_LOCK = threading.Lock()


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "applicants": len(APPLICANTS)})


@app.route("/webhooks/sumsub", methods=["POST"])
def sumsub_webhook():
    body = request.get_data()

    # Headers de firma que manda Sumsub
    sig = request.headers.get("X-Payload-Digest", "")
    ts = request.headers.get("X-Payload-Ts", "")
    if not sig:
        return jsonify({"error": "missing X-Payload-Digest"}), 400

    # ⚠️ En sandbox la firma puede no venir o ser de prueba.
    # En prod: verificar SIEMPRE. Acá logueamos y seguimos si no hay secret.
    if SECRET_KEY and not verify_webhook(ts, sig, body):
        return jsonify({"error": "invalid signature"}), 403

    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return jsonify({"error": "bad json"}), 400

    # Estructura típica de Sumsub: {"type": "applicantReviewed", "applicantId": "...", "reviewResult": {...}}
    event_type = payload.get("type", "")
    applicant_id = payload.get("applicantId", "")

    app.logger.info(f"Webhook {event_type} applicant={applicant_id}")

    if event_type == "applicantReviewed":
        review = payload.get("reviewResult", {})
        verdict = review.get("reviewAnswer", "UNKNOWN")  # GREEN | RED | UNKNOWN
        with _LOCK:
            wallet = APPLICANTS.get(applicant_id, "")

        if verdict == "GREEN":
            if wallet:
                # Emitir claim on-chain (en background, no bloquear el 200)
                threading.Thread(
                    target=claim_onchain, args=(wallet, applicant_id), daemon=True
                ).start()
                return jsonify({"status": "claim_pending", "wallet": wallet}), 200
            return jsonify({"status": "approved_no_wallet"}), 200
        return jsonify({"status": "not_approved", "verdict": verdict}), 200

    # Otros eventos: applicantCreated, applicantPending, etc.
    return jsonify({"status": "ignored", "type": event_type}), 200


# Registrar applicant manualmente (desde sumsub_kyc.py create)
@app.route("/applicants", methods=["POST"])
def register_applicant():
    data = request.get_json(force=True)
    applicant_id = data.get("applicantId", "")
    wallet = data.get("wallet", "")
    with _LOCK:
        APPLICANTS[applicant_id] = wallet
    return jsonify({"ok": True}), 201


if __name__ == "__main__":
    for p in [Path("/home/axel/morcat-prototype/.env"), Path(".env")]:
        load_env(p)
    SECRET_KEY = os.environ.get("SUMSUB_SECRET_KEY", "")
    print("🚀 Morcat webhook listener en http://0.0.0.0:8080")
    print(f"   Applicants registrados: {len(APPLICANTS)}")
    if not SECRET_KEY:
        print("   ⚠️  Sin SUMSUB_SECRET_KEY: firma NO verificada (solo sandbox)")
    app.run(host="0.0.0.0", port=8080)
