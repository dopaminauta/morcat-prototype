#!/usr/bin/env python3
"""
Morcat × Sumsub — Integración KYC (sandbox)

Flujo:
1. create_applicant(email, wallet) → crea el applicant en Sumsub
2. get_access_token(applicant_id) → token para el WebSDK (el front lo usa)
3. (El usuario hace el KYC en el WebSDK — DNI, liveness)
4. verify_webhook(payload, signature) → valida el webhook applicantReviewed
5. claim_onchain(wallet) → [PLACEHOLDER] emitir claim en IdentityRegistry del T-REX

Credenciales: leer de .env (NUNCA hardcodear)
  SUMSUB_APP_TOKEN=sbx:...
  SUMSUB_SECRET_KEY=...
  SUMSUB_BASE_URL=https://api.sumsub.com
"""
import hashlib
import hmac
import json
import os
import sys
import time
import uuid
import argparse
from pathlib import Path

import requests

BASE_URL = os.environ.get("SUMSUB_BASE_URL", "https://api.sumsub.com")
APP_TOKEN = os.environ.get("SUMSUB_APP_TOKEN", "")
SECRET_KEY = os.environ.get("SUMSUB_SECRET_KEY", "")
LEVEL_NAME = os.environ.get("SUMSUB_LEVEL", "basic-kyc-level")
TIMEOUT = 60

# Dónde buscar el .env. Se usa tanto al importar el módulo como en main().
ENV_PATHS = [
    Path("/home/axel/morcat-prototype/.env"),
    Path("/home/axel/morcat-prototype/.env.local"),
    Path(".env"),
]


def load_env(path: Path) -> None:
    """Carga .env minimalista (sin dependencias extra)."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip())


def bind_env() -> None:
    """
    Re-liga los globals de config desde os.environ.

    Hace falta porque las constantes de arriba se evalúan al IMPORTAR el módulo,
    cuando el .env todavía no se cargó. Sin esto, cualquier consumidor que haga
    `from sumsub_kyc import verify_webhook` y recién después llame a load_env()
    se queda con SECRET_KEY = "" y calcula el HMAC con clave vacía → toda firma
    de webhook da inválida. (Era el caso de webhook_server.py.)
    """
    global BASE_URL, APP_TOKEN, SECRET_KEY, LEVEL_NAME
    BASE_URL = os.environ.get("SUMSUB_BASE_URL", "https://api.sumsub.com")
    APP_TOKEN = os.environ.get("SUMSUB_APP_TOKEN", "")
    SECRET_KEY = os.environ.get("SUMSUB_SECRET_KEY", "")
    LEVEL_NAME = os.environ.get("SUMSUB_LEVEL", "basic-kyc-level")


# Autoload al importar: el .env queda disponible para TODOS los consumidores
# (webhook_server.py, app.py, el CLI de acá abajo) sin que cada uno se acuerde
# de llamar load_env() en el orden correcto. load_env usa setdefault, así que
# las variables ya exportadas en el entorno siguen ganando.
for _p in ENV_PATHS:
    load_env(_p)
bind_env()


def sign_request(request: requests.Request) -> requests.PreparedRequest:
    """Firma HMAC-SHA256 requerida por Sumsub (X-App-* headers)."""
    prepared = request.prepare()
    now = int(time.time())
    method = request.method.upper()
    path_url = prepared.path_url  # incluye query params, ej: /resources/applicants?levelName=...
    body = b"" if prepared.body is None else prepared.body
    if isinstance(body, str):
        body = body.encode("utf-8")
    data = str(now).encode() + method.encode() + path_url.encode() + body
    sig = hmac.new(SECRET_KEY.encode(), data, digestmod=hashlib.sha256)
    prepared.headers["X-App-Token"] = APP_TOKEN
    prepared.headers["X-App-Access-Ts"] = str(now)
    prepared.headers["X-App-Access-Sig"] = sig.hexdigest()
    return prepared


def send(request: requests.Request) -> requests.Response:
    """Envía una request firmada."""
    s = requests.Session()
    resp = s.send(sign_request(request), timeout=TIMEOUT)
    if resp.status_code >= 400:
        print(f"  ⚠️ HTTP {resp.status_code}: {resp.text[:300]}", file=sys.stderr)
    return resp


def create_applicant(external_user_id: str, email: str = "", wallet: str = "") -> str:
    """Crea un applicant. Devuelve applicantId."""
    body = {"externalUserId": external_user_id}
    if email:
        body["email"] = email
    if wallet:
        body["metadata"] = json.dumps({"wallet": wallet})
    req = requests.Request(
        "POST",
        f"{BASE_URL}/resources/applicants?levelName={LEVEL_NAME}",
        data=json.dumps(body),
        headers={"Content-Type": "application/json", "Content-Encoding": "utf-8"},
    )
    resp = send(req)
    resp.raise_for_status()
    return resp.json()["id"]


def get_access_token(external_user_id: str) -> str:
    """Token efímero para inicializar el WebSDK de Sumsub en el front."""
    body = {"userId": external_user_id, "levelName": LEVEL_NAME}
    req = requests.Request(
        "POST",
        f"{BASE_URL}/resources/accessTokens/sdk",
        data=json.dumps(body),
        headers={"Content-Type": "application/json", "Content-Encoding": "utf-8"},
    )
    resp = send(req)
    resp.raise_for_status()
    return resp.json()["token"]


def get_review_status(applicant_id: str) -> dict:
    """Estado de revisión: init | pending | prechecked | queued | completed."""
    req = requests.Request(
        "GET",
        f"{BASE_URL}/resources/applicants/{applicant_id}/reviewStatus",
    )
    resp = send(req)
    resp.raise_for_status()
    return resp.json()


def verify_webhook(ts: str, sig: str, body: bytes) -> bool:
    """Valida la firma de un webhook de Sumsub (HMAC-SHA256 hex, lowercase)."""
    data = ts.encode() + body
    expected = hmac.new(SECRET_KEY.encode(), data, digestmod=hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)


def claim_onchain(wallet: str, applicant_id: str) -> None:
    """
    [PLACEHOLDER] Emite el claim on-chain en el IdentityRegistry del T-REX.

    TODO(morcat): conectar con el contrato — en el prototipo:
    - TrustedIssuersRegistry: registrar este backend como trusted issuer
    - ClaimTopicsRegistry: topic = KYC_VERIFIED (ej: 1)
    - IdentityRegistry: identity(wallet).addClaim(topic, data, issuer)
    """
    print(f"  🏗️  [TODO] claim on-chain para wallet={wallet} applicant={applicant_id}")
    print(f"         → IdentityRegistry.addClaim(topic=KYC, issuer=MorcatBackend)")


def cmd_create(args) -> None:
    ext_id = args.external_id or f"morcat-{uuid.uuid4()}"
    print(f"→ Creando applicant ({LEVEL_NAME})...")
    applicant_id = create_applicant(ext_id, email=args.email, wallet=args.wallet)
    print(f"  ✅ applicantId: {applicant_id}")
    print(f"→ Generando access token para WebSDK...")
    token = get_access_token(ext_id)
    print(f"  ✅ token (15 min): {token[:40]}...")
    print(f"\n📋 Guardar: externalUserId={ext_id}")
    if args.wallet:
        print(f"           wallet={args.wallet}")


def cmd_status(args) -> None:
    print(f"→ Review status de {args.applicant_id}...")
    st = get_review_status(args.applicant_id)
    print(f"  ✅ {json.dumps(st, indent=2)}")


def cmd_verify_webhook(args) -> None:
    body = Path(args.body).read_bytes() if args.body else sys.stdin.buffer.read()
    ok = verify_webhook(args.ts, args.sig, body)
    print(f"  {'✅ FIRMA VÁLIDA' if ok else '❌ FIRMA INVÁLIDA'}")
    if ok and args.wallet:
        claim_onchain(args.wallet, args.applicant_id or "?")


def main() -> None:
    parser = argparse.ArgumentParser(description="Morcat × Sumsub KYC (sandbox)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_create = sub.add_parser("create", help="crear applicant + access token")
    p_create.add_argument("--email", default="")
    p_create.add_argument("--wallet", default="")
    p_create.add_argument("--external-id", default="")
    p_create.set_defaults(func=cmd_create)

    p_status = sub.add_parser("status", help="estado de revisión")
    p_status.add_argument("applicant_id")
    p_status.set_defaults(func=cmd_status)

    p_wh = sub.add_parser("verify-webhook", help="validar firma de webhook")
    p_wh.add_argument("--ts", required=True)
    p_wh.add_argument("--sig", required=True)
    p_wh.add_argument("--body", default="")
    p_wh.add_argument("--applicant-id", default="")
    p_wh.add_argument("--wallet", default="")
    p_wh.set_defaults(func=cmd_verify_webhook)

    args = parser.parse_args()

    # El .env ya se cargó al importar el módulo; re-leemos por si el cwd cambió.
    for p in ENV_PATHS:
        load_env(p)
    bind_env()
    if not APP_TOKEN or not SECRET_KEY:
        print("❌ Faltan SUMSUB_APP_TOKEN / SUMSUB_SECRET_KEY en .env", file=sys.stderr)
        print("   → Dashboard Sumsub (cockpit.sumsub.com) → Dev space → App tokens", file=sys.stderr)
        sys.exit(1)

    args.func(args)


if __name__ == "__main__":
    main()
