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

  const { addresses, implementations } = await deployTrexSuite(ethers, deployer);

  // Se persiste a disco: si perdés la terminal, un deploy en una red real
  // queda huérfano y hay que rehacerlo entero (y repagar el gas).
  const chainId = (await ethers.provider.getNetwork()).chainId.toString();
  const deployment = {
    chainId,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    ...addresses,
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
