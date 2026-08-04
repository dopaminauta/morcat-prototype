# 🏗️ Morcat Prototype — Setup & Faucets

## Estado
- ✅ **Compila** — 86 contratos, solc 0.8.17 (London)
- ✅ **Deploya** — suite T-REX completa, verificada end-to-end en la red local
- ✅ **T-REX v4.1.6 OFICIAL, sin modificar** — `@tokenysolutions/t-rex@4.1.6`
- ⚠️ **Sin reglas de compliance cargadas** — ver "Lo que falta" abajo

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
├── contracts/          # T-REX v4.1.3 (ERC-3643)
│   ├── token/          # Token + IToken + TokenStorage
│   ├── registry/       # IdentityRegistry, ClaimTopics, TrustedIssuers
│   ├── compliance/     # ModularCompliance
│   ├── proxy/          # TokenProxy + otros proxies
│   ├── factory/        # TREXFactory + Gateway
│   └── roles/          # AgentRole
├── scripts/
│   ├── trex-suite.ts   # Deploy + wiring + verificación (compartido)
│   ├── deploy.ts       # Deploy completo → deployments/<chainId>.json
│   └── interact.ts     # registerIdentity → mint → unpause → transfer
├── test/
│   └── trex.test.ts    # 23 tests
├── deployments/        # Direcciones por red, generado por deploy.ts
├── hardhat.config.ts   # Solidity 0.8.24, Sepolia + hardhat + localhost
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
2. **TREXImplementationAuthority** + `addAndUseTREXVersion(4.1.3, ...)`
   ← este paso es obligatorio *antes* de cualquier proxy: los proxies leen su
   implementación desde la IA en el propio constructor
3. Los **proxies** en orden (CTR, TIR, IRS, IR, MC, Token) — cada uno corre su
   `init()` por delegatecall
4. **Wiring**: bind del IRS al IR, deployer como agente del IR y del Token
5. **Verificación** on-chain de que todo quedó apuntando a donde corresponde
6. Guarda todas las direcciones en `deployments/<chainId>.json` (Sepolia = 11155111)

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
desde el explorador, ni Gaurang ni un tercero.

## ❗ Lo que falta para que sea compliant de verdad
El deploy levanta la infraestructura, no las reglas. Hoy:
- El token arranca **pausado** (`unpause()` cuando corresponda).
- `ClaimTopicsRegistry` está vacío ⇒ `isVerified()` devuelve **true** para
  cualquier identidad registrada (`IdentityRegistry.sol:176`).
- `ModularCompliance` no tiene módulos **enganchados** ⇒ no se aplica ninguna regla.
  Los módulos ahora **sí están en el repo** (vinieron con el paquete oficial):
  `CountryAllowModule`, `CountryRestrictModule`, `MaxBalanceModule`,
  `SupplyLimitModule`, `TransferFeesModule`, `TransferRestrictModule`,
  `ConditionalTransferModule`, `TimeTransfersLimitsModule` y varios más, en
  `contracts/compliance/modular/modules/`. Falta deployarlos y llamar a
  `ModularCompliance.addModule()`.
- Faltan trusted issuers y las ONCHAINID de los holders.

## 🧪 Tests
```bash
npx hardhat test
```
23 tests sobre `test/trex.test.ts`, cubriendo cableado, registro de
identidades, mint, transferencias y congelamiento. Usan `deployTrexSuite()`
—el mismo código que corre `scripts/deploy.ts`— para que lo que se prueba sea
lo que se deploya.

Dos de ellos documentan agujeros conocidos en vez de taparlos:
- `cruzar el orden de los registries NO revierte` — por qué el deploy verifica
  el cableado a mano.
- `acepta CUALQUIER address no-cero como ONCHAINID` — `registerIdentity()` no
  valida que sea un contrato Identity. Se cierra cargando claim topics.

## 📚 Libro de referencia
- `Beginning Ethereum and Solidity Smart Contracts` — Descargado en `~/Descargas/`
- Roadmap completo: `reports/roadmap_tokenizacion_morcat.md`

## 🔑 Próximos pasos cuando Gaurang mande la wallet
1. Que él corra primero el paso 0 (deploy local, gratis) y vea `✅ DEPLOY COMPLETO`
2. Conseguir Sepolia ETH del faucet
3. Mandar a la wallet de Gaurang
4. Él deploya con `npx hardhat run scripts/deploy.ts --network sepolia`
5. Verificar en https://sepolia.etherscan.io/

**Nota:** `npm install` es obligatorio de su lado — el proyecto necesita
`@nomicfoundation/hardhat-ethers` y `ethers`, que no venían en el repo original.

---
*Setup: 04/08/2026 17:25 ART · Camarón 🦐*
