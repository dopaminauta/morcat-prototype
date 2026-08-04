import { network } from "hardhat";
import { mkdir, writeFile } from "node:fs/promises";
import { deployTrexSuite } from "./trex-suite.js";

async function main() {
  const { ethers } = await network.getOrCreate();
  const [deployer] = await ethers.getSigners();

  console.log("Deployer:", deployer.address);
  console.log(
    "Balance :",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "ETH\n"
  );

  // Reglas del prototipo: "Casa Modular #1, Ushuaia".
  // 1000 tokens = la propiedad entera. Nadie puede acumular más del 20%.
  // Sólo inversores de Argentina (32) e India (356).
  const { addresses, implementations, moduleAddresses } = await deployTrexSuite(ethers, deployer, {
    modules: {
      supplyLimit: ethers.parseEther("1000"),
      maxBalance: ethers.parseEther("200"),
      allowedCountries: [32, 356],
    },
  });

  // ─── Distribuidor de dividendos ─────────────────────────────────────────
  // No es parte de T-REX: el estándar no dice nada de repartir ingresos.
  // Vive en contracts-morcat/ y sólo lee el token, no lo modifica.
  console.log("\n── Dividendos ──");
  const distributor = await (await ethers.getContractFactory("DividendDistributor")).deploy(
    addresses.token
  );
  await distributor.waitForDeployment();
  const distributorAddress = await distributor.getAddress();
  console.log("  DividendDistributor  :", distributorAddress);

  // Se persiste a disco: si perdés la terminal, un deploy en una red real
  // queda huérfano y hay que rehacerlo entero (y repagar el gas).
  const chainId = (await ethers.provider.getNetwork()).chainId.toString();
  const deployment = {
    chainId,
    deployedAt: new Date().toISOString(),
    // Bloque desde el que escanear eventos Transfer para saber quiénes son
    // los holders. Sin esto habría que barrer la cadena desde el bloque 0.
    startBlock: await ethers.provider.getBlockNumber(),
    deployer: deployer.address,
    ...addresses,
    dividendDistributor: distributorAddress,
    complianceModules: moduleAddresses,
    implementations,
  };

  await mkdir("deployments", { recursive: true });
  const outPath = `deployments/${chainId}.json`;
  await writeFile(outPath, JSON.stringify(deployment, null, 2) + "\n");

  console.log("\n✅ DEPLOY COMPLETO\n");
  console.log(JSON.stringify(deployment, null, 2));
  console.log(`\nGuardado en ${outPath}`);

  console.log(`
⚠️  Antes de que esto sea un token compliant de verdad:
   · El token arranca PAUSADO — token.unpause() cuando corresponda.
   · ClaimTopicsRegistry está vacío ⇒ isVerified() devuelve true para
     cualquier identidad registrada. Cargá los claim topics.
   · ModularCompliance no tiene módulos ⇒ no se aplica ninguna regla.
   · Falta registrar trusted issuers y las ONCHAINID de los holders.
`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
