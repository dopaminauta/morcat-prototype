#!/usr/bin/env python3
"""
Morcat — API server (auth por wallet + KYC Sumsub)

Es el backend que consume el front (/tmp/morcat-frontend-review). Corre en el
puerto 3000 porque es lo que el front espera por default (src/api/client.js:8
→ VITE_API_BASE_URL || 'http://localhost:3000/api').

Flujo completo:

  1. GET  /api/auth/nonce?wallet=0x…   → el server emite un nonce de un solo uso
                                          y arma el mensaje a firmar (SIWE-like)
  2. POST /api/auth/login {wallet, signature}
                                       → recupera la address de la firma
                                          (EIP-191 / personal_sign), la compara
                                          con la wallet, quema el nonce y emite
                                          un JWT HS256
  3. POST /api/kyc/start {email}       → [JWT] crea el applicant en Sumsub y
                                          devuelve el token efímero del WebSDK
  4. (el usuario hace el KYC en el WebSDK del front — DNI, liveness)
  5. POST /webhooks/sumsub             → Sumsub avisa el veredicto. La ruta la
                                          sirve webhook_server.py sin cambios;
                                          acá sólo se delega (ver más abajo).
  6. GET  /api/kyc/status?applicantId= → [JWT] estado real desde Sumsub, con
                                          fallback al store en memoria

Correr:
    cd /home/axel/morcat-prototype
    .venv/bin/python scripts/app.py

Env (todo por .env, NUNCA hardcodeado — ver .env.example):
    JWT_SECRET           firma de los JWT. Si falta se genera uno efímero.
    SUMSUB_APP_TOKEN     credenciales de Sumsub. Si faltan → MODO MOCK.
    SUMSUB_SECRET_KEY
    API_PORT             default 3000
    CORS_ORIGINS         default http://localhost:5173,http://localhost:3000

─── Divergencias con docs/API_CONTRACT.md (gana el código real) ───────────────

  · El contrato no define /api/auth/*: dice "JWT — pendiente definir"
    (API_CONTRACT.md:13, nota 6). Estos endpoints son nuevos.
  · El contrato manda `wallet` en el body de /api/kyc/start. Acá la wallet sale
    del JWT, que es la única fuente confiable. Si el body trae una wallet que no
    coincide con la del token → 403 (si coincide, se acepta por compatibilidad).
  · `verificationLevel`: el contrato dice "basic-kyc", el mock del front dice
    "basic". Devolvemos el valor real de SUMSUB_LEVEL (default
    "basic-kyc-level"), que es el que Sumsub realmente usa.
  · El contrato no contempla modo mock: cuando faltan credenciales de Sumsub la
    respuesta incluye "mock": true, para que nadie confunda un applicant falso
    con uno real.
"""
import functools
import json
import logging
import os
import secrets
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

# scripts/ al path para importar los módulos hermanos corriendo desde cualquier cwd
sys.path.insert(0, str(Path(__file__).resolve().parent))

import jwt
from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import is_address, to_checksum_address
from flask import Flask, g, jsonify, request

import sumsub_kyc
import webhook_server

# ─── Config ───────────────────────────────────────────────────────────────────
# sumsub_kyc ya cargó el .env y religó sus globals al importarse (ver bind_env).

LOG = logging.getLogger("morcat.api")

API_PORT = int(os.environ.get("API_PORT", "3000"))
JWT_ALGO = "HS256"
JWT_TTL_MIN = int(os.environ.get("JWT_TTL_MIN", "60"))
NONCE_TTL_SEC = 300  # 5 minutos, como pide el flujo SIWE
CHAIN_ID = int(os.environ.get("CHAIN_ID", "11155111"))  # Sepolia, igual que wagmi.js
APP_DOMAIN = os.environ.get("APP_DOMAIN", "morcat.local")

_jwt_secret = os.environ.get("JWT_SECRET", "")
JWT_EPHEMERAL = not _jwt_secret
if JWT_EPHEMERAL:
    # Sin secreto en env: uno random por arranque. Los tokens mueren con el
    # proceso. Sirve para desarrollo; en prod es JWT_SECRET o nada.
    _jwt_secret = secrets.token_urlsafe(48)
JWT_SECRET = _jwt_secret

# Modo mock: sin credenciales de Sumsub no se puede crear un applicant real.
# sumsub_kyc.py no tiene fallback propio (su main() hace sys.exit(1)), así que
# el fallback vive acá y se anuncia en cada respuesta con "mock": true.
MOCK_SUMSUB = not (sumsub_kyc.APP_TOKEN and sumsub_kyc.SECRET_KEY)

app = Flask(__name__)

# CORS es opcional: si flask-cors no está instalado el server arranca igual
# (útil si el front se sirve detrás del mismo origen o vía proxy de Vite).
try:
    from flask_cors import CORS

    CORS(
        app,
        resources={r"/api/*": {"origins": os.environ.get(
            "CORS_ORIGINS", "http://localhost:5173,http://localhost:3000"
        ).split(",")}},
    )
except ImportError:  # pragma: no cover
    LOG.warning("flask-cors no instalado: el front en otro puerto va a chocar con CORS")


# ─── Stores en memoria ────────────────────────────────────────────────────────
# APPLICANTS (applicantId → wallet) es EL MISMO objeto que usa webhook_server.py.
# No es una copia: reasignarlo rompería el vínculo, por eso se referencia y nunca
# se reemplaza. En prod esto es una tabla.
APPLICANTS = webhook_server.APPLICANTS
_WH_LOCK = webhook_server._LOCK

# Store propio con los datos que el webhook no conoce. Se indexa por applicantId
# (que es lo que el front poletea) y guarda el externalUserId adentro, porque
# get_access_token() lo necesita — ver divergencia 2 del reporte.
SESSIONS = {}          # applicantId → dict
NONCES = {}            # wallet.lower() → {"nonce", "message", "expires"}
_LOCK = threading.Lock()


# ─── Puente con el webhook existente ──────────────────────────────────────────

def _claim_and_record(wallet: str, applicant_id: str) -> None:
    """
    Envuelve claim_onchain para dejar registro de que el claim se emitió.

    webhook_server.py dispara claim_onchain en un thread pero no persiste nada,
    así que /api/kyc/status no tendría de dónde sacar `claimEmitted`. Como ese
    archivo no se toca, el punto de enganche es rebindear el nombre que él
    importó. El claim real lo sigue haciendo la función original.
    """
    try:
        _ORIGINAL_CLAIM(wallet, applicant_id)
    finally:
        with _LOCK:
            sess = SESSIONS.get(applicant_id)
            if sess is not None:
                sess["claimEmitted"] = True
                sess["status"] = "approved"
        LOG.info("claim registrado applicant=%s wallet=%s", applicant_id, wallet)


_ORIGINAL_CLAIM = webhook_server.claim_onchain
webhook_server.claim_onchain = _claim_and_record


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _err(message: str, status: int, code: str = ""):
    """Forma de error única. El front la lee en client.js (data.message/data.code)."""
    return jsonify({"message": message, "code": code or None}), status


def _now() -> int:
    return int(time.time())


def _build_siwe_message(wallet: str, nonce: str, issued_at: str) -> str:
    """
    Mensaje a firmar. Formato tipo EIP-4361 (SIWE) pero en texto plano, firmado
    con personal_sign (EIP-191). No es una transacción y no gasta gas.
    """
    return (
        f"{APP_DOMAIN} quiere que inicies sesión con tu wallet Ethereum:\n"
        f"{wallet}\n"
        f"\n"
        f"Firmá este mensaje para autenticarte en Morcat. "
        f"No es una transacción y no tiene costo.\n"
        f"\n"
        f"URI: http://{APP_DOMAIN}\n"
        f"Version: 1\n"
        f"Chain ID: {CHAIN_ID}\n"
        f"Nonce: {nonce}\n"
        f"Issued At: {issued_at}"
    )


def _issue_jwt(wallet: str) -> tuple:
    """Emite el JWT de sesión. Devuelve (token, expira_en_epoch)."""
    iat = _now()
    exp = iat + JWT_TTL_MIN * 60
    payload = {
        "sub": wallet,              # address en formato checksum
        "iss": "morcat-api",
        "iat": iat,
        "exp": exp,
        "jti": uuid.uuid4().hex,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO), exp


def require_auth(fn):
    """
    Middleware de auth para /api/kyc/*. Valida el Bearer token y deja la wallet
    del sujeto en g.wallet. 401 si falta, está mal firmado o venció.
    """

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return _err("Authentication required", 401, "no_token")
        token = header[7:].strip()
        try:
            payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO], issuer="morcat-api")
        except jwt.ExpiredSignatureError:
            return _err("Session expired, please sign in again", 401, "token_expired")
        except jwt.InvalidTokenError:
            return _err("Invalid session token", 401, "token_invalid")
        g.wallet = payload["sub"]
        return fn(*args, **kwargs)

    return wrapper


def _map_review_status(review: dict) -> str:
    """
    Traduce el vocabulario de Sumsub al del contrato.

    Sumsub (reviewStatus): init | pending | prechecked | queued | completed
    Contrato/front:        pending | approved | declined | review

    El front depende de esta traducción: useKycPolling.js:75 corta el polling
    cuando status != 'pending', y useAppStore.js:24 exige status == 'approved'.
    """
    if review.get("reviewStatus") != "completed":
        return "pending"
    result = review.get("reviewResult", {}) or {}
    answer = result.get("reviewAnswer", "")
    if answer == "GREEN":
        return "approved"
    if answer == "RED":
        # FINAL = rechazo definitivo; RETRY = puede volver a intentar
        return "declined" if result.get("reviewRejectType") == "FINAL" else "review"
    return "pending"


# ─── Rutas: salud ─────────────────────────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "applicants": len(APPLICANTS),
        "sessions": len(SESSIONS),
        "mockSumsub": MOCK_SUMSUB,
        "ephemeralJwtSecret": JWT_EPHEMERAL,
    })


# ─── Rutas: auth por wallet ───────────────────────────────────────────────────

@app.route("/api/auth/nonce", methods=["GET"])
def auth_nonce():
    """
    Emite el nonce y el mensaje exacto que el front tiene que hacer firmar.

    Sin nonce el login sería replayable: una firma capturada una vez serviría
    para siempre. El nonce vive 5 minutos y se quema en el primer login válido.
    """
    wallet = (request.args.get("wallet") or "").strip()
    if not is_address(wallet):
        return _err("Invalid wallet address", 422, "invalid_wallet")

    wallet = to_checksum_address(wallet)
    nonce = secrets.token_hex(16)
    issued_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    message = _build_siwe_message(wallet, nonce, issued_at)

    with _LOCK:
        NONCES[wallet.lower()] = {
            "nonce": nonce,
            "message": message,
            "expires": _now() + NONCE_TTL_SEC,
        }

    return jsonify({"nonce": nonce, "message": message, "expiresIn": NONCE_TTL_SEC})


@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    """
    Login con wallet: {wallet, signature} → {token, wallet, expiresAt}.

    La firma se valida recuperando la address del mensaje (EIP-191). Si la
    address recuperada no es la wallet declarada, la firma no sirve.
    """
    data = request.get_json(silent=True) or {}
    wallet = (data.get("wallet") or "").strip()
    signature = (data.get("signature") or "").strip()

    if not is_address(wallet):
        return _err("Invalid wallet address", 422, "invalid_wallet")
    if not signature:
        return _err("Missing signature", 422, "missing_signature")

    wallet = to_checksum_address(wallet)
    key = wallet.lower()

    with _LOCK:
        entry = NONCES.get(key)
        if entry and entry["expires"] < _now():
            NONCES.pop(key, None)
            entry = None

    if not entry:
        # También se cae acá si el nonce ya se usó: es de un solo uso.
        return _err("No active nonce for this wallet, request one first", 400, "nonce_missing")

    try:
        recovered = Account.recover_message(
            encode_defunct(text=entry["message"]), signature=signature
        )
    except Exception:
        # Firma malformada (hex inválido, longitud incorrecta, v fuera de rango)
        return _err("Malformed signature", 401, "bad_signature")

    if to_checksum_address(recovered) != wallet:
        return _err("Signature does not match wallet", 401, "signature_mismatch")

    with _LOCK:
        NONCES.pop(key, None)  # quemado: un solo uso

    token, exp = _issue_jwt(wallet)
    LOG.info("login ok wallet=%s", wallet)
    return jsonify({"token": token, "wallet": wallet, "expiresAt": exp})


# ─── Rutas: KYC ───────────────────────────────────────────────────────────────

@app.route("/api/kyc/start", methods=["POST"])
@require_auth
def kyc_start():
    """
    Crea el applicant en Sumsub y devuelve el token efímero para el WebSDK.

    La wallet sale del JWT, no del body (ver divergencias en el docstring).
    """
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip()
    body_wallet = (data.get("wallet") or "").strip()
    wallet = g.wallet

    # El contrato manda wallet en el body. Se acepta si coincide con la del token.
    if body_wallet:
        if not is_address(body_wallet):
            return _err("Invalid wallet address", 422, "invalid_wallet")
        if to_checksum_address(body_wallet) != wallet:
            return _err("Wallet does not match authenticated session", 403, "wallet_mismatch")

    with _LOCK:
        if email and any(s["email"] == email for s in SESSIONS.values()):
            return _err("An applicant already exists for this email", 409, "applicant_exists")

    # Mismo patrón de externalUserId que el CLI (sumsub_kyc.py cmd_create)
    external_user_id = f"morcat-{uuid.uuid4()}"

    if MOCK_SUMSUB:
        LOG.warning(
            "⚠️  MODO MOCK: sin SUMSUB_APP_TOKEN/SUMSUB_SECRET_KEY. "
            "El applicant NO es real y el token NO sirve para el WebSDK."
        )
        applicant_id = f"mock-{uuid.uuid4()}"
        sumsub_token = f"mock_token_{secrets.token_hex(8)}"
    else:
        try:
            applicant_id = sumsub_kyc.create_applicant(external_user_id, email=email, wallet=wallet)
            # OJO: get_access_token va con el externalUserId, NO con el applicantId.
            # Sumsub liga el token del WebSDK al userId (sumsub_kyc.py:92-94).
            sumsub_token = sumsub_kyc.get_access_token(external_user_id)
        except Exception as exc:
            LOG.error("Sumsub falló en kyc/start: %s", exc)
            return _err("Could not start verification, please try again", 502, "sumsub_error")

    with _LOCK:
        SESSIONS[applicant_id] = {
            "applicantId": applicant_id,
            "externalUserId": external_user_id,
            "wallet": wallet,
            "email": email,
            "status": "pending",
            "claimEmitted": False,
            "createdAt": _now(),
            "mock": MOCK_SUMSUB,
        }
    with _WH_LOCK:
        # El webhook resuelve applicantId → wallet contra este dict
        APPLICANTS[applicant_id] = wallet

    return jsonify({
        "applicantId": applicant_id,
        "sumsubToken": sumsub_token,
        "verificationLevel": sumsub_kyc.LEVEL_NAME,
        "mock": MOCK_SUMSUB,
    })


@app.route("/api/kyc/status", methods=["GET"])
@require_auth
def kyc_status():
    """
    Estado de la verificación.

    Fuente de verdad: el reviewStatus real de Sumsub (sumsub_kyc.get_review_status).
    Si estamos en mock, o si Sumsub no responde, se cae al store en memoria — que
    es el que actualiza el webhook cuando llega el veredicto.
    """
    applicant_id = (request.args.get("applicantId") or "").strip()
    if not applicant_id:
        return _err("Missing applicantId", 422, "missing_applicant_id")

    with _LOCK:
        sess = SESSIONS.get(applicant_id)
        snapshot = dict(sess) if sess else None

    if snapshot is None:
        return _err("Applicant not found", 404, "applicant_not_found")
    # No filtrar el estado de otro inversor aunque adivinen el applicantId
    if snapshot["wallet"] != g.wallet:
        return _err("Applicant does not belong to this session", 403, "not_owner")

    status = snapshot["status"]
    if not snapshot["mock"]:
        try:
            status = _map_review_status(sumsub_kyc.get_review_status(applicant_id))
            with _LOCK:
                if applicant_id in SESSIONS:
                    SESSIONS[applicant_id]["status"] = status
        except Exception as exc:
            # Fallback silencioso al store: el polling del front no debe romperse
            # por un hipo de red (useKycPolling.js sigue reintentando igual).
            LOG.warning("reviewStatus falló para %s, uso el store: %s", applicant_id, exc)

    return jsonify({
        "applicantId": applicant_id,
        "status": status,
        "claimEmitted": snapshot["claimEmitted"],
        "wallet": snapshot["wallet"],
    })


# ─── Rutas delegadas a webhook_server.py (ese archivo no se modifica) ─────────
# Las vistas de Flask leen del proxy global `request`, así que invocarlas desde
# el contexto de request de esta app funciona sin tocar su código.

@app.route("/webhooks/sumsub", methods=["POST"])
def sumsub_webhook():
    return webhook_server.sumsub_webhook()


@app.route("/applicants", methods=["POST"])
def register_applicant():
    return webhook_server.register_applicant()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    print(f"🚀 Morcat API en http://0.0.0.0:{API_PORT}")
    print(f"   Sumsub level: {sumsub_kyc.LEVEL_NAME}")
    if MOCK_SUMSUB:
        print("   ⚠️  MODO MOCK: faltan SUMSUB_APP_TOKEN / SUMSUB_SECRET_KEY.")
        print("      /api/kyc/start devuelve applicants FALSOS ('mock': true).")
    if JWT_EPHEMERAL:
        print("   ⚠️  Sin JWT_SECRET: secreto efímero, los tokens mueren al reiniciar.")
    app.run(host="0.0.0.0", port=API_PORT)


if __name__ == "__main__":
    main()
