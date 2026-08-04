# 🏗️ Morcat Prototype — Setup & Faucets

## Estado
- ✅ **Compila** — 86 contratos, solc 0.8.17 (London)
- ✅ **Deploya** — suite T-REX completa, verificada end-to-end en la red local
- ✅ **T-REX v4.1.6 OFICIAL, sin modificar** — `@tokenysolutions/t-rex@4.1.6`
- ✅ **3 reglas de compliance activas** — supply, tope por inversor y país

### Por qué los contratos son los oficiales tal cual
`contracts/` es una copia literal de `@tokenysolutions/t-rex@4.1.6`, el paquete
que publica Tokeny. No se tocó ni un archivo, incluidos `_testContracts/` y
`compliance/legacy/` que el prototipo no usa. Borrarlos sería modificar el
paquete, y el valor acá es poder decir "son los oficiales" sin asteriscos.

Eso obliga a dos versiones que **no son elección nuestra**:
- **solc 0.8.17** — 83 de los 86 archivos clavan `pragma solidity 0.8.17;` sin `^`.
- **OpenZeppelin 4.8.3** — todas las releases de T-REX (hasta 4.2.0-beta) piden `^4.8.3`.

Con esto el layout de storage coincide con el de los contratos auditados por
Tokeny (`_agents` en slot 101). Una versión adaptada a OZ 5 compila y funciona
igual, pero deja el layout corrido ~100 slots y pierde compatibilidad con las
implementaciones oficiales.

## Estructura
```
morcat-prototype/
├── contracts/          # T-REX v4.1.6 OFICIAL (ERC-3643), sin modificar
│   ├── token/          # Token + IToken + TokenStorage
│   ├── registry/       # IdentityRegistry, ClaimTopics, TrustedIssuers
│   ├── compliance/     # ModularCompliance + 12 módulos de reglas
│   ├── proxy/          # TokenProxy + otros proxies
│   ├── factory/        # TREXFactory + Gateway
│   └── roles/          # AgentRole
├── contracts-morcat/   # Código NUESTRO, separado de lo oficial
│   └── DividendDistributor.sol
├── scripts/
│   ├── trex-suite.ts   # Deploy + wiring + verificación (compartido)
│   ├── deploy.ts       # Deploy completo → deployments/<chainId>.json
│   └── interact.ts     # registerIdentity → mint → unpause → transfer
├── test/
│   └── trex.test.ts    # 39 tests
├── deployments/        # Direcciones por red, generado por deploy.ts
├── hardhat.config.ts   # Solidity 0.8.17, Sepolia + hardhat + localhost
└── .env.example        # Variables de entorno, documentadas
```

## 🚀 Cómo deployar

### 0. Instalar dependencias y probar en local
```bash
npm install
npx hardhat compile
npx hardhat run scripts/deploy.ts --network hardhat   # deploy en memoria, gratis
```
Tiene que terminar en `✅ DEPLOY COMPLETO` con todos los checks de
verificación en ✔. **No sigas a Sepolia hasta ver eso.**

### 1. Crear .env
```bash
cp .env.example .env
# Editar .env con tu PRIVATE_KEY de MetaMask
```

### 2. Conseguir Sepolia ETH (Faucets)

| Faucet | Requiere | Límite |
|--------|----------|--------|
| https://www.alchemy.com/faucets/ethereum-sepolia | Cuenta Alchemy gratis | 0.5 ETH/día |
| https://cloud.google.com/application/web3/faucet/ethereum/sepolia | Cuenta Google (gratis) | 0.05 ETH/día |
| https://faucet.quicknode.com/ethereum/sepolia | Cuenta QuickNode gratis | 0.1 ETH/día |
| https://sepolia-faucet.pk910.de/ | PoW (minar en browser) | Variable |

**Recomendado:** Alchemy (más ETH, más rápido). Registro con email → dashboard → faucet.

### 3. Deploy
```bash
cd ~/morcat-prototype
npx hardhat compile          # Ya compila ✅
npx hardhat run scripts/deploy.ts --network sepolia
```

### 4. Deploy script hace:
1. Las 6 **implementaciones** (Token, CTR, IR, IRS, TIR, MC) — nunca se usan
   directo, sólo como destino de delegatecall
2. **TREXImplementationAuthority** + `addAndUseTREXVersion(4.1.6, ...)`
   ← este paso es obligatorio *antes* de cualquier proxy: los proxies leen su
   implementación desde la IA en el propio constructor
3. Los **proxies** en orden (CTR, TIR, IRS, IR, MC, Token) — cada uno corre su
   `init()` por delegatecall
4. **Wiring**: bind del IRS al IR, deployer como agente del IR y del Token
5. **Módulos de compliance** — antes del primer mint (ver sección abajo)
6. **Verificación** on-chain de que todo quedó apuntando a donde corresponde
7. Guarda todas las direcciones en `deployments/<chainId>.json` (Sepolia = 11155111)

> ⚠️ El `IdentityRegistry` recibe `(trustedIssuers, claimTopics, identityStorage)`
> **en ese orden**. Invertirlos no revierte — las tres son direcciones válidas y
> no-cero — y te deja el registry cableado al revés en silencio. Por eso el
> script verifica el resultado contra la cadena en el paso 5.

### 5. Probar que el token funciona
```bash
npx hardhat run scripts/interact.ts --network sepolia
```
Corre el ciclo completo sobre el deploy que ya hiciste: `registerIdentity()` →
`mint()` → `unpause()` → `transfer()`. Lee las direcciones de
`deployments/<chainId>.json`. Es idempotente: si un paso ya está hecho, lo saltea.

Se configura por `.env`: `HOLDER`, `ONCHAIN_ID`, `AMOUNT`.

> Para probar deploy + interact en local hacen falta **dos terminales**, porque
> la red `hardhat` es efímera (cada `hardhat run` levanta una cadena nueva y el
> deploy anterior desaparece):
> ```bash
> npx hardhat node                                        # terminal 1
> npx hardhat run scripts/deploy.ts   --network localhost # terminal 2
> npx hardhat run scripts/interact.ts --network localhost # terminal 2
> ```

### 6. Verificar el código en Etherscan
```bash
npx hardhat verify --network sepolia <address> <args del constructor>
```
Necesita `ETHERSCAN_API_KEY` en el `.env` (gratis en
https://etherscan.io/myapikey). Los constructor args de cada contrato están en
`deployments/<chainId>.json` y en `scripts/trex-suite.ts`.

Sin esto los contratos quedan como bytecode sin fuente: nadie puede auditarlos
desde el explorador, ni tu equipo ni un tercero.

## 🛡️ Reglas de compliance activas
El deploy engancha tres módulos oficiales a la `ModularCompliance`, pensados
para "Casa Modular #1, Ushuaia":

| Módulo | Regla | Qué demuestra |
|---|---|---|
| `SupplyLimitModule` | Máx **1000 tokens** en total | 1000 tokens = la propiedad entera; no se puede emitir de más |
| `MaxBalanceModule` | Máx **200 tokens** por inversor | Nadie acapara más del 20% |
| `CountryAllowModule` | Sólo países **32** (Argentina) y **356** (India) | Restricción por jurisdicción |

Se configuran en `scripts/deploy.ts`. Para cambiarlas, tocá el objeto
`modules` que se le pasa a `deployTrexSuite()`.

> **Orden obligatorio:** `MaxBalanceModule` sólo acepta bindearse si el token
> todavía tiene `totalSupply == 0` (`MaxBalanceModule.canComplianceBind`). Los
> módulos van **sí o sí antes del primer mint**.

> **El tope es por ONCHAINID, no por wallet** (`MaxBalanceModule.sol:245`). Una
> persona con dos wallets y el mismo ONCHAINID sigue topeada — no se esquiva
> abriendo una billetera nueva. Hay un test que lo prueba.

### Ver los rechazos en vivo
```bash
npx hardhat run scripts/interact.ts --network <red>
```
```
── Demo de compliance (3 módulos activos) ──
   inversor de país no permitido: RECHAZADO ✔
   mint por encima del tope por inversor: RECHAZADO ✔
   wallet sin KYC: RECHAZADO ✔
```

## 💰 Dividendos
T-REX **no trae nada** de reparto de ingresos: el estándar sólo cubre la
transferencia compliant. `contracts-morcat/DividendDistributor.sol` es código
nuestro, vive fuera de `contracts/` y sólo **lee** el token — no lo modifica.

```
Alquiler cobrado → createRound(holders) → cada holder hace claim()
```

Tres decisiones que vale la pena entender:

**1. Pull, no push.** Nadie recorre la lista de holders mandándoles plata. Cada
uno reclama lo suyo. Un push se queda sin gas cuando hay muchos holders, y si
un holder es un contrato que rechaza ETH, tumba el reparto entero.

**2. Snapshot al crear la ronda.** Los balances se congelan en el momento del
reparto. Si no, el ataque es obvio: cobro, me mando los tokens a otra wallet,
cobro de nuevo. Hay un test que lo prueba.

**3. La lista de holders se verifica contra el supply.** El operador pasa las
direcciones, pero el contrato lee los balances él mismo y **exige que sumen
exactamente `totalSupply()`**. No se puede dejar a nadie afuera ni inventar
saldos — omitir un holder hace revertir la transacción.

`interact.ts` descubre los holders barriendo los eventos `Transfer` desde el
bloque del deploy, así que el demo no depende de una lista hardcodeada:

```
── Demo de dividendos ──
   Alquiler a repartir: 0.01 ETH entre 2 holders
   0xf39F...2266   90.0%  →  0.009 ETH
   0x7099...79C8   10.0%  →  0.001 ETH
   Cobrado por el deployer ✔
```

Lo no reclamado se puede recuperar recién después de `CLAIM_PERIOD` (365 días).

## ❗ Lo que falta para que sea compliant de verdad
- El token arranca **pausado** (`unpause()` cuando corresponda).
- `ClaimTopicsRegistry` está vacío ⇒ `isVerified()` devuelve **true** para
  cualquier identidad registrada (`IdentityRegistry.sol:176`). O sea: las
  reglas de compliance de arriba **sí** se aplican, pero el KYC en sí todavía
  no valida nada. Son dos capas distintas.
- Faltan trusted issuers reales y las ONCHAINID de verdad de los holders.

## 🧪 Tests
```bash
npx hardhat test
```
39 tests sobre `test/trex.test.ts`, cubriendo cableado, reglas de compliance,
registro de identidades, mint, transferencias, congelamiento y dividendos. Usan `deployTrexSuite()`
—el mismo código que corre `scripts/deploy.ts`— para que lo que se prueba sea
lo que se deploya.

Dos de ellos documentan agujeros conocidos en vez de taparlos:
- `cruzar el orden de los registries NO revierte` — por qué el deploy verifica
  el cableado a mano.
- `acepta CUALQUIER address no-cero como ONCHAINID` — `registerIdentity()` no
  valida que sea un contrato Identity. Se cierra cargando claim topics.

## 📚 Referencias
- `Beginning Ethereum and Solidity Smart Contracts` (Wei-Meng Lee, Apress)
- Documentación de T-REX: https://docs.tokeny.com/

## 🔑 Próximos pasos para deployar en Sepolia
1. Correr primero el paso 0 (deploy local, gratis) y ver `✅ DEPLOY COMPLETO`
2. Conseguir Sepolia ETH del faucet
3. Mandarlo a la wallet que va a deployar
4. `npx hardhat run scripts/deploy.ts --network sepolia`
5. Verificar en https://sepolia.etherscan.io/

**Nota:** `npm install` es obligatorio de cada lado — el proyecto necesita
`@nomicfoundation/hardhat-ethers` y `ethers`, que no venían en el scaffold inicial.

---
*Setup: 04/08/2026 17:25 ART · Camarón 🦐*
