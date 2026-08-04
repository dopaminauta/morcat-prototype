import { network } from "hardhat";
import { readFile } from "node:fs/promises";

/**
 * Recorre el ciclo de vida completo del token sobre un deploy ya hecho:
 *
 *   registerIdentity() → mint() → unpause() → transfer()
 *
 * Lee las direcciones de deployments/<chainId>.json, así que corre igual en
 * local que en Sepolia. Es idempotente: si un paso ya está hecho, lo saltea.
 *
 *   npx hardhat run scripts/interact.ts --network hardhat
 *   npx hardhat run scripts/interact.ts --network sepolia
 *
 * Variables opcionales (.env o inline):
 *   HOLDER      address que recibe los tokens (default: el deployer)
 *   ONCHAIN_ID  ONCHAINID del holder (default: placeholder, ver aviso abajo)
 *   AMOUNT      cantidad a mintear, en unidades enteras (default: 1000)
 */
async function main() {
  const { ethers } = await network.getOrCreate();
  const [deployer] = await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId.toString();

  const path = `deployments/${chainId}.json`;
  let d: any;
  try {
    d = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(
      `No encontré ${path}. Corré primero:\n` +
        `  npx hardhat run scripts/deploy.ts --network <red>`
    );
  }

  const holder = process.env.HOLDER ?? deployer.address;
  // 100 por defecto: el MaxBalanceModule topea en 200 por inversor.
  const amount = ethers.parseEther(process.env.AMOUNT ?? "100");
  const PLACEHOLDER = "0x000000000000000000000000000000000000dEaD";
  const onchainId = process.env.ONCHAIN_ID ?? PLACEHOLDER;

  const token = await ethers.getContractAt("Token", d.token);
  const ir = await ethers.getContractAt("IdentityRegistry", d.identityRegistry);

  console.log(`Red      : chainId ${chainId}`);
  console.log(`Token    : ${d.token}`);
  console.log(`Operador : ${deployer.address}`);
  console.log(`Holder   : ${holder}\n`);

  if (!(await token.isAgent(deployer.address))) {
    throw new Error(`${deployer.address} no es agente del token — no puede mintear.`);
  }

  // ─── 1. Identidad ───────────────────────────────────────────────────────
  if (await ir.isVerified(holder)) {
    console.log("1. Identidad ya registrada, salteo.");
  } else {
    if (onchainId === PLACEHOLDER) {
      console.log(
        "⚠️  Usando un ONCHAINID placeholder que NO es un contrato Identity.\n" +
          "   Sirve para probar el flujo porque el ClaimTopicsRegistry está vacío.\n" +
          "   Para algo real: deployá un ONCHAINID y pasalo en ONCHAIN_ID.\n"
      );
    }
    // 32 = código de país ISO-3166 (Argentina)
    await (await ir.registerIdentity(holder, onchainId, 32)).wait();
    console.log(`1. Identidad registrada. isVerified: ${await ir.isVerified(holder)}`);
  }

  // ─── 2. Mint ────────────────────────────────────────────────────────────
  const antes = await token.balanceOf(holder);
  await (await token.mint(holder, amount)).wait();
  console.log(
    `2. Minteados ${ethers.formatEther(amount)} MPT ` +
      `(${ethers.formatEther(antes)} → ${ethers.formatEther(await token.balanceOf(holder))})`
  );

  // ─── 3. Unpause ─────────────────────────────────────────────────────────
  if (await token.paused()) {
    await (await token.unpause()).wait();
    console.log("3. Token despausado.");
  } else {
    console.log("3. Token ya estaba despausado.");
  }

  // ─── 4. Transfer ────────────────────────────────────────────────────────
  // Sólo si tenemos una segunda cuenta local con la que firmar.
  const signers = await ethers.getSigners();
  if (signers.length > 1 && holder.toLowerCase() === deployer.address.toLowerCase()) {
    const dest = signers[1];
    if (!(await ir.isVerified(dest.address))) {
      await (await ir.registerIdentity(dest.address, onchainId, 32)).wait();
    }
    const monto = ethers.parseEther("10");
    await (await token.transfer(dest.address, monto)).wait();
    console.log(
      `4. Transferidos 10 MPT a ${dest.address}\n` +
        `   ${deployer.address} → ${ethers.formatEther(await token.balanceOf(deployer.address))} MPT\n` +
        `   ${dest.address} → ${ethers.formatEther(await token.balanceOf(dest.address))} MPT`
    );
  } else {
    console.log("4. Transfer salteado (hace falta una segunda cuenta local para firmar).");
  }

  // ─── 5. Demo de compliance ──────────────────────────────────────────────
  // Lo que hay que mostrarle al cliente: la capa de compliance rechaza de
  // verdad, no es decorativa.
  const mc = await ethers.getContractAt("ModularCompliance", d.modularCompliance);
  const modulos: string[] = await mc.getModules();

  if (modulos.length > 0) {
    console.log(`\n── Demo de compliance (${modulos.length} módulos activos) ──`);

    const rechaza = async (etiqueta: string, fn: () => Promise<any>) => {
      try {
        await (await fn()).wait();
        console.log(`   ${etiqueta}: PASÓ ⚠️  (se esperaba un rechazo)`);
      } catch {
        console.log(`   ${etiqueta}: RECHAZADO ✔`);
      }
    };

    const signers = await ethers.getSigners();
    if (signers.length > 9) {
      // País no permitido: 156 = China. Sólo están habilitados 32 y 356.
      const extranjero = signers[9];
      if (!(await ir.isVerified(extranjero.address))) {
        await (await ir.registerIdentity(extranjero.address, "0x" + "9".repeat(40), 156)).wait();
      }
      await rechaza("inversor de país no permitido", () => token.mint(extranjero.address, ethers.parseEther("1")));
    }

    // Pasarse del tope por inversor
    await rechaza("mint por encima del tope por inversor", () =>
      token.mint(holder, ethers.parseEther("100000"))
    );

    // Wallet sin KYC
    const sinKyc = ethers.Wallet.createRandom().address;
    await rechaza("wallet sin KYC", () => token.mint(sinKyc, ethers.parseEther("1")));
  }

  // ─── 6. Demo de dividendos ──────────────────────────────────────────────
  // Simula el cobro de un alquiler y su reparto proporcional.
  if (d.dividendDistributor) {
    console.log("\n── Demo de dividendos ──");
    const dist = await ethers.getContractAt("DividendDistributor", d.dividendDistributor);

    // Los holders se descubren de la cadena, no se hardcodean: se barren los
    // eventos Transfer y se queda con los que hoy tienen saldo. El contrato
    // igual exige que la lista cubra el 100% del supply.
    const logs = await token.queryFilter(token.filters.Transfer(), d.startBlock ?? 0, "latest");
    const candidatos = new Set<string>();
    for (const l of logs) {
      if (l.args?.from && l.args.from !== ethers.ZeroAddress) candidatos.add(l.args.from);
      if (l.args?.to && l.args.to !== ethers.ZeroAddress) candidatos.add(l.args.to);
    }

    const holders: string[] = [];
    let suma = 0n;
    for (const a of candidatos) {
      const bal = await token.balanceOf(a);
      if (bal > 0n) {
        holders.push(a);
        suma += bal;
      }
    }

    const supply = await token.totalSupply();
    if (suma !== supply) {
      console.log(`   ⚠️  Los holders detectados suman ${ethers.formatEther(suma)} de ${ethers.formatEther(supply)}. Salteo el reparto.`);
    } else {
      const alquiler = ethers.parseEther("0.01");
      console.log(`   Alquiler a repartir: ${ethers.formatEther(alquiler)} ETH entre ${holders.length} holders`);

      const ronda = Number(await dist.roundsCount());
      await (await dist.createRound(holders, { value: alquiler })).wait();

      for (const h of holders) {
        const parte = await dist.claimable(ronda, h);
        const pct = (Number(await token.balanceOf(h)) / Number(supply)) * 100;
        console.log(`   ${h}  ${pct.toFixed(1).padStart(5)}%  →  ${ethers.formatEther(parte)} ETH`);
      }

      // El deployer cobra lo suyo para mostrar que el claim funciona.
      if (holders.some((h) => h.toLowerCase() === deployer.address.toLowerCase())) {
        const antes = await ethers.provider.getBalance(deployer.address);
        await (await dist.claim(ronda)).wait();
        const despues = await ethers.provider.getBalance(deployer.address);
        console.log(`   Cobrado por el deployer ✔ (balance ${despues > antes ? "subió" : "bajó por gas"})`);
      }
    }
  }

  console.log(`\n✅ Listo. Total supply: ${ethers.formatEther(await token.totalSupply())} MPT`);
  if (chainId === "11155111") {
    console.log(`   https://sepolia.etherscan.io/address/${d.token}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
