# Morcat API Contract v0.1 — DRAFT
> Para el frontend de Gaurang. Backend: morcat-prototype (T-REX + Sumsub).
> Status: draft — sujeto a cambios mientras definimos el backend.

## Base URL
```
http://localhost:3000/api    (dev)
https://api.morcat.com/api   (prod — pendiente)
```

## Autenticación
- El front usa el **SDK de Sumsub WebSDK** directamente para el KYC del usuario.
- El backend firma requests con el token de sesión del usuario (JWT — pendiente definir).
- El claim on-chain lo emite el backend cuando Sumsub aprueba (webhook).

---

## Endpoints

### 1. KYC — Iniciar verificación
`POST /api/kyc/start`

**Body:**
```json
{
  "email": "inversor@mail.com",
  "wallet": "0x1234...abcd"
}
```

**Response 200:**
```json
{
  "applicantId": "5f9c8b2e-...",
  "sumsubToken": "eyJhbGciOi...",   // token para inicializar el WebSDK
  "verificationLevel": "basic-kyc"
}
```

**Errores:**
- `409` — ya existe un applicant con ese email
- `422` — wallet inválida

---

### 2. KYC — Estado de verificación
`GET /api/kyc/status?applicantId=5f9c8b2e-...`

**Response 200:**
```json
{
  "applicantId": "5f9c8b2e-...",
  "status": "pending | approved | declined | review",
  "claimEmitted": false,
  "wallet": "0x1234...abcd"
}
```

- `claimEmitted: true` → el backend ya emitió el claim on-chain (Trusted Issuer → IdentityRegistry)
- El front puede hacer polling cada 5s o esperar el webhook

---

### 3. Tokens — Balance del inversor
`GET /api/tokens/balance?wallet=0x1234...abcd`

**Response 200:**
```json
{
  "wallet": "0x1234...abcd",
  "token": "MPT",
  "balance": "10.5",
  "verified": true,
  "canTrade": true
}
```

---

### 4. Tokens — Comprar
`POST /api/tokens/buy`

**Body:**
```json
{
  "wallet": "0x1234...abcd",
  "amount": "5.0",
  "paymentMethod": "eth | bank | usdc"
}
```

**Response 200:**
```json
{
  "txHash": "0x9f8c...",
  "amount": "5.0",
  "status": "pending"
}
```

**Errores:**
- `403` — wallet no verificada (KYC incompleto)
- `400` — monto excede el tope por inversor
- `409` — país no permitido

---

### 5. Tokens — Vender (salida)
`POST /api/tokens/sell`

**Body:**
```json
{
  "wallet": "0x1234...abcd",
  "amount": "2.0"
}
```

**Response 200:**
```json
{
  "txHash": "0x9f8c...",
  "amount": "2.0",
  "status": "pending"
}
```

---

### 6. Rentas — Historial de dividendos
`GET /api/rents/history?wallet=0x1234...abcd`

**Response 200:**
```json
{
  "wallet": "0x1234...abcd",
  "rents": [
    {
      "date": "2026-08-01",
      "amount": "0.009",
      "currency": "ETH",
      "txHash": "0x..."
    }
  ]
}
```

---

## Webhooks (backend → front)

### KYC aprobado
`POST /api/webhooks/kyc-approved`

```json
{
  "applicantId": "5f9c8b2e-...",
  "wallet": "0x1234...abcd",
  "claimEmitted": true
}
```

### Transferencia de tokens
`POST /api/webhooks/transfer`

```json
{
  "from": "0x...",
  "to": "0x...",
  "amount": "5.0",
  "txHash": "0x..."
}
```

---

## Notas para Gaurang

1. **El KYC es off-chain con Sumsub** — el front usa el WebSDK de Sumsub, no un formulario propio.
2. **`sumsubToken` es efímero** (15 min) — el front lo pide al backend justo antes de abrir el SDK.
3. **Los montos son strings** (decimales precisos) — nunca floats.
4. **Polling:** `/api/kyc/status` cada 5s mientras `status != approved`.
5. **El claim on-chain lo emite el backend** — el front NO toca el contrato directamente (excepto lectura pública).
6. **Pendiente:** auth JWT, rate limiting, CORS. No es para producción todavía.

## Flujo del inversor (resumen)

```
1. Landing → "Invertir" → POST /api/kyc/start (email + wallet)
2. Backend crea applicant en Sumsub → devuelve sumsubToken
3. Front abre Sumsub WebSDK → usuario sube DNI, liveness
4. Sumsub aprueba → webhook → backend emite claim on-chain
5. Front hace polling a /api/kyc/status → claimEmitted: true
6. Usuario compra → POST /api/tokens/buy → tx on-chain
7. Dashboard: balance + historial de rentas
```
