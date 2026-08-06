# Morcat API Contract v0.2 — DRAFT
> Para el frontend de Gaurang. Backend: morcat-prototype (T-REX + Sumsub).
> Status: draft — sujeto a cambios mientras definimos el backend.
>
> **v0.2** — auth por wallet implementada (`/api/auth/nonce` + `/api/auth/login`),
> `/api/kyc/*` ahora exige `Authorization: Bearer`, campo `mock` en `/kyc/start`,
> y el mapeo de estados de Sumsub documentado.
> Implementación de referencia: `scripts/app.py`. **Donde este doc y el código
> difieran, gana el código.**

## Base URL
```
http://localhost:3000/api    (dev)
https://api.morcat.com/api   (prod — pendiente)
```

## Autenticación

**Implementada** en `scripts/app.py`. Login con wallet en dos pasos (estilo SIWE):
el front pide un nonce, la wallet firma el mensaje que devuelve el backend, y el
backend responde con un JWT.

- El front usa el **SDK de Sumsub WebSDK** directamente para el KYC del usuario.
- **Todos los endpoints bajo `/api/kyc/*` exigen `Authorization: Bearer <jwt>`.**
  Sin header o con token vencido/inválido → `401`.
- El claim on-chain lo emite el backend cuando Sumsub aprueba (webhook).

### 0.a Auth — Pedir nonce
`GET /api/auth/nonce?wallet=0x1234...abcd`

**Response 200:**
```json
{
  "nonce": "aed9a262a9b936426404c448ba4b8e3c",
  "message": "morcat.local quiere que inicies sesión con tu wallet Ethereum:\n0x1234...\n\nFirmá este mensaje...\n\nNonce: aed9...\nIssued At: 2026-08-06T16:32:23+00:00",
  "expiresIn": 300
}
```

- El front tiene que hacer firmar **exactamente** el string `message`, sin
  reformatear ni recortar: el backend valida contra ese texto literal.
- El nonce vive **5 minutos** y es de **un solo uso**.

**Errores:** `422` — wallet inválida

### 0.b Auth — Login
`POST /api/auth/login`

**Body:**
```json
{
  "wallet": "0x1234...abcd",
  "signature": "0x9f8c..."
}
```

La firma es `personal_sign` / EIP-191 (en wagmi: `signMessageAsync({ message })`).
No es una transacción y no gasta gas.

**Response 200:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "wallet": "0x1234...abcd",
  "expiresAt": 1786037297
}
```

- `token` es un JWT HS256, válido `JWT_TTL_MIN` minutos (default 60).
- `wallet` viene en formato checksum (EIP-55), puede diferir en mayúsculas de lo
  que mandaste.
- El front lo guarda en `localStorage["morcat_token"]` y el interceptor de
  `src/api/client.js` lo agrega como `Authorization: Bearer` en cada request.

**Errores:**
- `400` (`nonce_missing`) — no hay nonce activo: nunca se pidió, venció, o ya se
  usó. **Reintentar un login replayeando la misma firma cae siempre acá.**
- `401` (`signature_mismatch`) — la firma no corresponde a esa wallet
- `401` (`bad_signature`) — firma malformada
- `422` — wallet inválida o falta `signature`

---

## Endpoints

### 1. KYC — Iniciar verificación
`POST /api/kyc/start`  · **requiere `Authorization: Bearer <jwt>`**

**Body:**
```json
{
  "email": "inversor@mail.com",
  "wallet": "0x1234...abcd"
}
```

- **`wallet` es opcional y redundante:** el backend usa la wallet del JWT, que es
  la única que la firma prueba. Si la mandás y **no** coincide con la del token →
  `403`. Se acepta cuando coincide, por compatibilidad con este contrato.

**Response 200:**
```json
{
  "applicantId": "5f9c8b2e-...",
  "sumsubToken": "eyJhbGciOi...",   // token para inicializar el WebSDK
  "verificationLevel": "basic-kyc-level",
  "mock": false
}
```

- `verificationLevel` es el valor real de `SUMSUB_LEVEL` (default
  `"basic-kyc-level"`), no `"basic-kyc"` como decía este doc antes.
- **`mock: true`** → el backend arrancó **sin credenciales de Sumsub**. El
  `applicantId` y el `sumsubToken` son **falsos**: el WebSDK no va a funcionar
  con ellos. Sirve para levantar el front sin credenciales. Si el front detecta
  `mock: true`, conviene mostrar un cartel de "modo demo" en vez de abrir el SDK.

**Errores:**
- `401` — sin token, token vencido o inválido
- `403` — la `wallet` del body no coincide con la del JWT
- `409` — ya existe un applicant con ese email
- `422` — wallet inválida
- `502` — Sumsub no respondió

---

### 2. KYC — Estado de verificación
`GET /api/kyc/status?applicantId=5f9c8b2e-...`  · **requiere `Authorization: Bearer <jwt>`**

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
- Sólo devuelve applicants de **la wallet autenticada**: pedir el `applicantId`
  de otro inversor da `403`, no el dato.

**Mapeo de estados.** Sumsub no usa este vocabulario: devuelve
`reviewStatus` (`init | pending | prechecked | queued | completed`) más un
`reviewResult.reviewAnswer` (`GREEN | RED`). El backend traduce así:

| Sumsub | → este contrato |
|---|---|
| `init` / `pending` / `prechecked` / `queued` | `pending` |
| `completed` + `GREEN` | `approved` |
| `completed` + `RED` + `reviewRejectType: FINAL` | `declined` |
| `completed` + `RED` + `reviewRejectType: RETRY` | `review` |

El front **nunca** ve el vocabulario de Sumsub. `review` significa que el
usuario puede reintentar; `declined` es definitivo.

**Errores:**
- `401` — sin token, token vencido o inválido
- `403` — el applicant no pertenece a la wallet autenticada
- `404` — applicant desconocido
- `422` — falta `applicantId`

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
6. **Auth JWT: implementada** (ver arriba). CORS: configurable por `CORS_ORIGINS`,
   default `http://localhost:5173,http://localhost:3000`.
   **Pendiente:** rate limiting, y persistencia — los applicants y los nonces
   viven **en memoria**, así que reiniciar el server borra las sesiones. No es
   para producción todavía.
7. **Sólo `/api/kyc/*` pide auth.** Los endpoints de tokens y rentas (3-6) todavía
   no están implementados en el backend; cuando se implementen van a pedir el
   mismo `Authorization: Bearer`.

## Flujo del inversor (resumen)

```
0. Connect wallet → GET /api/auth/nonce → la wallet firma el message
                  → POST /api/auth/login → JWT en localStorage["morcat_token"]
1. Landing → "Invertir" → POST /api/kyc/start (email)   [Bearer]
2. Backend crea applicant en Sumsub → devuelve sumsubToken
3. Front abre Sumsub WebSDK → usuario sube DNI, liveness
4. Sumsub aprueba → webhook → backend emite claim on-chain
5. Front hace polling a /api/kyc/status → claimEmitted: true   [Bearer]
6. Usuario compra → POST /api/tokens/buy → tx on-chain
7. Dashboard: balance + historial de rentas
```
