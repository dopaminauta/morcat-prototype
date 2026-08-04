/**
 * Deploy de una suite T-REX (ERC-3643) completa.
 *
 * Vive acá y no dentro de deploy.ts para que los tests ejerciten exactamente
 * el mismo camino que el deploy real. Un test que deploya distinto que el
 * script de producción no prueba el script de producción.
 *
 * Orden obligatorio — los proxies leen su implementación desde la
 * ImplementationAuthority en el propio constructor, así que la IA tiene que
 * tener una versión registrada ANTES de deployar cualquier proxy:
 *
 *   1. implementaciones (nunca se usan directo, sólo como destino de delegatecall)
 *   2. ImplementationAuthority + addAndUseTREXVersion()
 *   3. proxies (cada uno corre su init() por delegatecall en el constructor)
 *   4. wiring (bind del IRS al IR, agentes)
 *   5. verificación on-chain del cableado
 */

/**
 * Reglas de compliance a enganchar. Se aplican en el orden en que aparecen.
 * `undefined` = ese módulo no se deploya.
 */
export interface ModuleOptions {
  /** Supply máximo total, en wei. Ej: 1000 tokens = la propiedad entera. */
  supplyLimit?: bigint;
  /** Balance máximo por inversor, en wei. Ej: 20% del total. */
  maxBalance?: bigint;
  /** Códigos de país ISO-3166 numéricos permitidos. Ej: [32] = Argentina. */
  allowedCountries?: number[];
}

export interface TrexOptions {
  name?: string;
  symbol?: string;
  decimals?: number;
  /** ONCHAINID del token (un contrato Identity). Cero = se setea después. */
  onchainId?: string;
  /** false para que los tests no ensucien la salida. */
  log?: boolean;
  /** Módulos de compliance. Omitir = token sin ninguna regla aplicada. */
  modules?: ModuleOptions;
}

export async function deployTrexSuite(ethers: any, deployer: any, opts: TrexOptions = {}) {
  const {
    name = "Morcat Property Token",
    symbol = "MPT",
    decimals = 18,
    onchainId = ethers.ZeroAddress,
    log = true,
    modules,
  } = opts;

  const say = (...a: any[]) => log && console.log(...a);

  const deploy = async (contractName: string, ...args: any[]) => {
    const c = await (await ethers.getContractFactory(contractName)).deploy(...args);
    await c.waitForDeployment();
    return c;
  };

  // ─── 1. Implementaciones ────────────────────────────────────────────────
  // Quedan sin init() a propósito: sólo se las invoca por delegatecall desde
  // los proxies, nunca directamente.
  say("── Implementaciones ──");

  const tokenImpl = await deploy("Token");
  const ctrImpl = await deploy("ClaimTopicsRegistry");
  const irImpl = await deploy("IdentityRegistry");
  const irsImpl = await deploy("IdentityRegistryStorage");
  const tirImpl = await deploy("TrustedIssuersRegistry");
  const mcImpl = await deploy("ModularCompliance");

  const implementations = {
    token: await tokenImpl.getAddress(),
    claimTopicsRegistry: await ctrImpl.getAddress(),
    identityRegistry: await irImpl.getAddress(),
    identityRegistryStorage: await irsImpl.getAddress(),
    trustedIssuersRegistry: await tirImpl.getAddress(),
    modularCompliance: await mcImpl.getAddress(),
  };
  for (const [k, v] of Object.entries(implementations)) say(`  ${k.padEnd(24)}: ${v}`);

  // ─── 2. ImplementationAuthority ─────────────────────────────────────────
  say("\n── ImplementationAuthority ──");

  // (referenceStatus, trexFactory, iaFactory) — reference contract, sin factory
  const ia = await deploy("TREXImplementationAuthority", true, ethers.ZeroAddress, ethers.ZeroAddress);
  const iaAddress = await ia.getAddress();
  say("  implementationAuthority :", iaAddress);

  await (
    await ia.addAndUseTREXVersion(
      { major: 4, minor: 1, patch: 6 },
      {
        tokenImplementation: implementations.token,
        ctrImplementation: implementations.claimTopicsRegistry,
        irImplementation: implementations.identityRegistry,
        irsImplementation: implementations.identityRegistryStorage,
        tirImplementation: implementations.trustedIssuersRegistry,
        mcImplementation: implementations.modularCompliance,
      }
    )
  ).wait();
  say("  versión 4.1.6 registrada y en uso ✔");

  // ─── 3. Proxies ─────────────────────────────────────────────────────────
  say("\n── Proxies ──");

  const ctrAddress = await (await deploy("ClaimTopicsRegistryProxy", iaAddress)).getAddress();
  const tirAddress = await (await deploy("TrustedIssuersRegistryProxy", iaAddress)).getAddress();
  const irsAddress = await (await deploy("IdentityRegistryStorageProxy", iaAddress)).getAddress();

  // OJO con el orden: init(trustedIssuers, claimTopics, identityStorage).
  // Las tres son direcciones válidas, así que invertirlas NO revierte —
  // te deja el registry cableado al revés en silencio. Ver test "wiring".
  const irAddress = await (
    await deploy("IdentityRegistryProxy", iaAddress, tirAddress, ctrAddress, irsAddress)
  ).getAddress();

  const mcAddress = await (await deploy("ModularComplianceProxy", iaAddress)).getAddress();

  const tokenAddress = await (
    await deploy("TokenProxy", iaAddress, irAddress, mcAddress, name, symbol, decimals, onchainId)
  ).getAddress();

  const addresses = {
    implementationAuthority: iaAddress,
    claimTopicsRegistry: ctrAddress,
    trustedIssuersRegistry: tirAddress,
    identityRegistryStorage: irsAddress,
    identityRegistry: irAddress,
    modularCompliance: mcAddress,
    token: tokenAddress,
  };
  for (const [k, v] of Object.entries(addresses)) say(`  ${k.padEnd(24)}: ${v}`);

  // ─── 4. Wiring ──────────────────────────────────────────────────────────
  say("\n── Wiring ──");

  const ctr = await ethers.getContractAt("ClaimTopicsRegistry", ctrAddress);
  const tir = await ethers.getContractAt("TrustedIssuersRegistry", tirAddress);
  const irs = await ethers.getContractAt("IdentityRegistryStorage", irsAddress);
  const ir = await ethers.getContractAt("IdentityRegistry", irAddress);
  const mc = await ethers.getContractAt("ModularCompliance", mcAddress);
  const token = await ethers.getContractAt("Token", tokenAddress);

  await (await irs.bindIdentityRegistry(irAddress)).wait();
  say("  IRS ← IdentityRegistry bindeado ✔");

  await (await ir.addAgent(deployer.address)).wait();
  say("  deployer es agente del IdentityRegistry ✔");

  await (await token.addAgent(deployer.address)).wait();
  say("  deployer es agente del Token ✔");

  // ─── 4b. Módulos de compliance ──────────────────────────────────────────
  // OJO con el orden: MaxBalanceModule sólo acepta bindearse si el token
  // todavía tiene totalSupply == 0 (ver MaxBalanceModule.canComplianceBind).
  // O sea que los módulos van SÍ o SÍ antes del primer mint.
  const moduleAddresses: Record<string, string> = {};

  if (modules) {
    say("\n── Módulos de compliance ──");

    /**
     * Cada módulo es UUPS: se deploya la implementación, después un
     * ModuleProxy que corre initialize(), y recién ahí se lo engancha.
     * Los setters son onlyComplianceCall, así que van por callModuleFunction.
     */
    const addModule = async (contractName: string, setter?: { fn: string; args: any[] }) => {
      const impl = await deploy(contractName);
      const initData = impl.interface.encodeFunctionData("initialize", []);
      const proxy = await deploy("ModuleProxy", await impl.getAddress(), initData);
      const addr = await proxy.getAddress();

      await (await mc.addModule(addr)).wait();
      if (setter) {
        await (
          await mc.callModuleFunction(impl.interface.encodeFunctionData(setter.fn, setter.args), addr)
        ).wait();
      }

      moduleAddresses[contractName] = addr;
      return addr;
    };

    if (modules.supplyLimit !== undefined) {
      await addModule("SupplyLimitModule", { fn: "setSupplyLimit", args: [modules.supplyLimit] });
      say(`  SupplyLimitModule    : máx ${ethers.formatEther(modules.supplyLimit)} tokens en total ✔`);
    }

    if (modules.maxBalance !== undefined) {
      await addModule("MaxBalanceModule", { fn: "setMaxBalance", args: [modules.maxBalance] });
      say(`  MaxBalanceModule     : máx ${ethers.formatEther(modules.maxBalance)} tokens por inversor ✔`);
    }

    if (modules.allowedCountries?.length) {
      await addModule("CountryAllowModule", {
        fn: "batchAllowCountries",
        args: [modules.allowedCountries],
      });
      say(`  CountryAllowModule   : países ${modules.allowedCountries.join(", ")} ✔`);
    }
  }

  // ─── 5. Verificación ────────────────────────────────────────────────────
  say("\n── Verificación ──");

  const checks: [string, string, string][] = [
    ["IR → issuersRegistry", await ir.issuersRegistry(), tirAddress],
    ["IR → topicsRegistry", await ir.topicsRegistry(), ctrAddress],
    ["IR → identityStorage", await ir.identityStorage(), irsAddress],
    ["Token → identityRegistry", await token.identityRegistry(), irAddress],
    ["Token → compliance", await token.compliance(), mcAddress],
    // El bind del token en la compliance lo hace Token.init() por dentro
    // (setCompliance → bindToken). Si fallara, quedaría una compliance suelta.
    ["Compliance → token", await mc.getTokenBound(), tokenAddress],
  ];

  for (const [label, actual, expected] of checks) {
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`${label}: esperaba ${expected}, obtuve ${actual}`);
    }
    say(`  ${label} ✔`);
  }

  if (!(await irs.isAgent(irAddress))) {
    throw new Error("El IdentityRegistry no quedó como agente del IRS");
  }
  say("  IRS reconoce al IR como agente ✔");

  if ((await token.symbol()) !== symbol || Number(await token.decimals()) !== decimals) {
    throw new Error("Metadata del token incorrecta");
  }
  say("  metadata del token ✔");

  const bound: string[] = await mc.getModules();
  const esperados = Object.values(moduleAddresses);
  for (const [nombre, addr] of Object.entries(moduleAddresses)) {
    if (!bound.some((b) => b.toLowerCase() === addr.toLowerCase())) {
      throw new Error(`${nombre} no quedó bindeado a la compliance`);
    }
  }
  if (bound.length !== esperados.length) {
    throw new Error(`La compliance tiene ${bound.length} módulos, esperaba ${esperados.length}`);
  }
  if (esperados.length) say(`  ${esperados.length} módulos bindeados a la compliance ✔`);

  return {
    addresses,
    implementations,
    moduleAddresses,
    contracts: { ia, ctr, tir, irs, ir, mc, token },
  };
}
