# Morcat Prototype

Tokenized real estate on **ERC-3643 (T-REX)** — a security token where only
KYC-approved wallets can hold or trade, with on-chain compliance rules and
proportional rent distribution.

> ⚠️ **Prototype. Testnet only. Not audited. No real money.**
> The compliance layer works and rejects for real. The KYC layer is simulated —
> see [What's real vs. simulated](#whats-real-vs-simulated) before showing this
> to anyone as a finished product.

---

## What it does today

One command runs the full lifecycle against a live chain:

```
1. Identidad registrada. isVerified: true          # identity registered
2. Minteados 100.0 MPT                             # minted
3. Token despausado.                               # unpaused
4. Transferidos 10 MPT                             # transferred

── Demo de compliance (3 módulos activos) ──
   inversor de país no permitido: RECHAZADO ✔      # disallowed country
   mint por encima del tope por inversor: RECHAZADO ✔   # over per-investor cap
   wallet sin KYC: RECHAZADO ✔                     # no KYC

── Demo de dividendos ──
   Alquiler a repartir: 0.01 ETH entre 2 holders   # rent split across holders
   0xf39F...2266   90.0%  →  0.009 ETH
   0x7099...79C8   10.0%  →  0.001 ETH
   Cobrado por el deployer ✔                       # claimed
```

> **Note on language:** script output, code comments and `SETUP.md` are in
> Spanish; this README is in English. Inline glosses above are for reference —
> they are not printed by the script.

That output is the point of the whole repo: **the compliance layer is not
decorative.** A wallet that isn't approved genuinely cannot receive tokens.

---

## Quick start

```bash
npm install
npm test                  # 39 tests
npm run deploy:local      # deploy to an in-memory chain, free
```

You should see `✅ DEPLOY COMPLETO` with every verification check passing.
**Don't move to a public testnet until you do.**

### Full local run (deploy + interact)

The in-memory `hardhat` network is ephemeral — every `hardhat run` spins up a
fresh chain, so a previous deployment is gone. To run deploy and interact as
two separate processes (like a real network), use a persistent node:

```bash
npx hardhat node                              # terminal 1
npm run deploy:localhost                      # terminal 2
npm run interact:localhost                    # terminal 2
```

### Sepolia

```bash
cp .env.example .env      # fill in PRIVATE_KEY — use a throwaway wallet
npm run deploy            # deploys to Sepolia
npm run interact
```

Every field in `.env.example` is documented, including where to get each
credential. Detailed walkthrough and faucet list: **[SETUP.md](SETUP.md)**
(in Spanish).

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│  LAYER 4: FRONTEND    connect wallet, buy, view   │  ← not in this repo
├──────────────────────────────────────────────────┤
│  LAYER 3: BACKEND     KYC form, approval, whitelist│ ← not in this repo
├──────────────────────────────────────────────────┤
│  LAYER 2: CONTRACTS   T-REX + compliance + dividends│ ← THIS REPO
├──────────────────────────────────────────────────┤
│  LAYER 1: FOUNDATION  Hardhat, Sepolia, MetaMask   │  ← this repo
└──────────────────────────────────────────────────┘
```

| Contract | Role |
|---|---|
| `Token` | The property shares (ERC-3643) |
| `IdentityRegistry` | Who is allowed to hold them |
| `IdentityRegistryStorage` | Where that list is stored |
| `ClaimTopicsRegistry` | Which KYC claims are required |
| `TrustedIssuersRegistry` | Who may certify those claims |
| `ModularCompliance` | Transfer rules engine |
| `TREXImplementationAuthority` | Which implementation each proxy uses |
| `DividendDistributor` | Rent distribution *(ours, not T-REX)* |

Every T-REX contract is deployed behind a proxy that reads its implementation
from the `TREXImplementationAuthority`. That authority must have a registered
version **before** any proxy is deployed — the proxies resolve their
implementation inside their own constructor.

### Official contracts, unmodified

`contracts/` is a **verbatim copy of `@tokenysolutions/t-rex@4.1.6`**. Not one
file is edited, including the parts this prototype doesn't use. Our own code
lives in `contracts-morcat/`, kept separate so the guarantee holds.

This pins two versions that are **not our choice**:

- **solc 0.8.17** — 83 of the 86 official files hardcode `pragma solidity 0.8.17;`
- **OpenZeppelin 4.8.3** — every T-REX release requires `^4.8.3`

The payoff: storage layout matches Tokeny's audited contracts exactly
(`_agents` at slot 101). An OZ 5 port compiles and runs fine but shifts the
layout ~100 slots and loses compatibility with the official implementations.

---

## What's real vs. simulated

The single most important table in this repo. Read it before demoing.

| Piece | Status |
|---|---|
| ERC-3643 token, transfers, freeze, pause | ✅ Real — official Tokeny contracts |
| Compliance rules (supply, per-investor cap, country) | ✅ Real — genuinely rejects |
| Unapproved wallets blocked | ✅ Real |
| Proportional dividend split + claim | ✅ Real, with snapshot + reentrancy protection |
| **KYC validation** | ⚠️ **Simulated** — `ClaimTopicsRegistry` is empty, so `isVerified()` returns `true` for any registered identity, and `registerIdentity()` doesn't check the ONCHAINID is even a contract |
| Dividend trigger | ⚠️ Manual — the owner calls `createRound()` with the holder list |
| Buy flow (pay → receive tokens) | ❌ Not built |
| Frontend / backend | ❌ Not in this repo |

**These are two separate layers.** Compliance rules *do* apply. KYC itself
does not validate credentials yet. Closing that gap means loading claim topics
and registering real trusted issuers.

---

## Compliance rules

Configured in `scripts/deploy.ts`, sized for a single property split into
1000 tokens:

| Module | Rule |
|---|---|
| `SupplyLimitModule` | max **1000 tokens** total — the whole property |
| `MaxBalanceModule` | max **200 tokens** per investor — nobody exceeds 20% |
| `CountryAllowModule` | only ISO country codes **32** and **356** |

Two things worth knowing:

- **Modules must be attached before the first mint.** `MaxBalanceModule` only
  accepts binding while `totalSupply == 0`.
- **The cap is per ONCHAINID, not per wallet.** One person with two wallets and
  the same identity still shares one cap — you can't dodge it by opening a new
  address. There's a test for that.

---

## Dividends

T-REX covers compliant transfer; it says nothing about distributing income.
`contracts-morcat/DividendDistributor.sol` is ours. It only *reads* the token.

```
rent collected → createRound(holders) → each holder calls claim()
```

Three design decisions:

1. **Pull, not push.** Holders claim; nobody iterates paying them out. A push
   runs out of gas with many holders, and one holder that rejects ETH would
   break the entire distribution.
2. **Balances snapshot when the round is created.** Otherwise: claim, move
   tokens to another wallet, claim again.
3. **The holder list is verified against total supply.** The caller supplies
   addresses, but the contract reads balances itself and requires they sum to
   exactly `totalSupply()`. Omitting a holder reverts the transaction.

That third one is what makes the distribution trustworthy without modifying
the Token, which has no native snapshot support.

---

## Tests

```bash
npm test
```

39 tests covering wiring, compliance rules, identity registration, minting,
transfers, freezing and dividends. They call `deployTrexSuite()` — the same
function `scripts/deploy.ts` runs — so what's tested is what gets deployed.

Some tests document known gaps rather than hiding them:

- `crossing the registry order does NOT revert` — why the deploy verifies its
  own wiring on-chain
- `accepts ANY non-zero address as ONCHAINID` — the KYC gap, in writing

The two security-critical tests are mutation-tested: replacing the dividend
snapshot with a live `balanceOf()` breaks the double-claim test, and removing
the reentrancy guard breaks the reentrancy test.

---

## Project layout

```
morcat-prototype/
├── contracts/           # T-REX v4.1.6 OFFICIAL — verbatim, unmodified
├── contracts-morcat/    # Our code
│   └── DividendDistributor.sol
├── scripts/
│   ├── trex-suite.ts    # deploy + wiring + on-chain verification
│   ├── deploy.ts        # full deploy → deployments/<chainId>.json
│   └── interact.ts      # lifecycle + compliance + dividend demo
├── test/trex.test.ts    # 39 tests
├── deployments/         # addresses per network
└── SETUP.md             # detailed guide (Spanish)
```

---

## License

**GPL-3.0.** The T-REX contracts in `contracts/` are © Tokeny sàrl and licensed
under GPL-3.0, which this repository redistributes. Our own code in
`contracts-morcat/` and `scripts/` is released under the same license.

See [LICENSE](LICENSE).
