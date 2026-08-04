import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { deployTrexSuite } from "../scripts/trex-suite.js";

/**
 * Tests de la suite T-REX.
 *
 * Usan deployTrexSuite() — el mismo código que corre scripts/deploy.ts — para
 * que lo que se prueba acá sea lo que se deploya de verdad.
 */

const ONE = (n: string | number) => BigInt(n) * 10n ** 18n;

async function setup() {
  const { ethers } = await network.getOrCreate();
  const [deployer, alice, bob, carol] = await ethers.getSigners();
  const suite = await deployTrexSuite(ethers, deployer, { log: false });
  return { ethers, deployer, alice, bob, carol, ...suite };
}

describe("deploy y cableado", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  before(async () => { ctx = await setup(); });

  it("el IdentityRegistry apunta a los tres registries correctos", async () => {
    const { contracts: c, addresses: a } = ctx;
    // Regresión del bug original: el script viejo pasaba (irs, ctr, tir) a un
    // init() que espera (trustedIssuers, claimTopics, identityStorage).
    assert.equal((await c.ir.issuersRegistry()).toLowerCase(), a.trustedIssuersRegistry.toLowerCase());
    assert.equal((await c.ir.topicsRegistry()).toLowerCase(), a.claimTopicsRegistry.toLowerCase());
    assert.equal((await c.ir.identityStorage()).toLowerCase(), a.identityRegistryStorage.toLowerCase());
  });

  it("el token apunta al IdentityRegistry y a la compliance", async () => {
    const { contracts: c, addresses: a } = ctx;
    assert.equal((await c.token.identityRegistry()).toLowerCase(), a.identityRegistry.toLowerCase());
    assert.equal((await c.token.compliance()).toLowerCase(), a.modularCompliance.toLowerCase());
  });

  it("la compliance quedó bindeada al token (lo hace Token.init() por dentro)", async () => {
    assert.equal((await ctx.contracts.mc.getTokenBound()).toLowerCase(), ctx.addresses.token.toLowerCase());
  });

  it("el IRS reconoce al IdentityRegistry como agente", async () => {
    assert.ok(await ctx.contracts.irs.isAgent(ctx.addresses.identityRegistry));
  });

  it("la metadata del token es la esperada", async () => {
    const { token } = ctx.contracts;
    assert.equal(await token.name(), "Morcat Property Token");
    assert.equal(await token.symbol(), "MPT");
    assert.equal(Number(await token.decimals()), 18);
  });

  it("el token arranca PAUSADO", async () => {
    assert.equal(await ctx.contracts.token.paused(), true);
  });

  it("cruzar el orden de los registries NO revierte — falla en silencio", async () => {
    // Este test documenta por qué deployTrexSuite verifica el cableado a mano.
    // Los tres parámetros son direcciones válidas y no-cero, así que el
    // require() del init() pasa igual y el registry queda al revés.
    const { ethers, addresses: a } = ctx;
    const malCableado = await (await ethers.getContractFactory("IdentityRegistryProxy")).deploy(
      a.implementationAuthority,
      a.identityRegistryStorage, // ← va trustedIssuers
      a.claimTopicsRegistry,
      a.trustedIssuersRegistry   // ← va identityStorage
    );
    await malCableado.waitForDeployment();

    const roto = await ethers.getContractAt("IdentityRegistry", await malCableado.getAddress());
    assert.equal(
      (await roto.issuersRegistry()).toLowerCase(),
      a.identityRegistryStorage.toLowerCase(),
      "el deploy con los args cruzados debería completarse sin revertir"
    );
  });
});

describe("registro de identidades", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  before(async () => { ctx = await setup(); });

  it("una address sin registrar no está verificada", async () => {
    assert.equal(await ctx.contracts.ir.isVerified(ctx.alice.address), false);
  });

  it("solo un agente puede registrar identidades", async () => {
    const { contracts: c, alice, bob } = ctx;
    await assert.rejects(
      c.ir.connect(alice).registerIdentity(bob.address, bob.address, 32),
      /Agent/
    );
  });

  it("⚠️ acepta CUALQUIER address no-cero como ONCHAINID, aunque no sea un contrato", async () => {
    // Agujero conocido y documentado: registerIdentity() no valida que el
    // ONCHAINID sea un contrato Identity. Con el ClaimTopicsRegistry vacío,
    // isVerified() devuelve true igual. Se cierra cargando claim topics.
    const { contracts: c, alice } = ctx;
    const noEsUnContrato = "0x000000000000000000000000000000000000dEaD";

    await (await c.ir.registerIdentity(alice.address, noEsUnContrato, 32)).wait();

    assert.equal(await c.ir.isVerified(alice.address), true);
    assert.equal(await ctx.ethers.provider.getCode(noEsUnContrato), "0x");
  });

  it("borrar la identidad la des-verifica", async () => {
    const { contracts: c, alice } = ctx;
    await (await c.ir.deleteIdentity(alice.address)).wait();
    assert.equal(await c.ir.isVerified(alice.address), false);
  });
});

describe("mint", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  before(async () => {
    ctx = await setup();
    await (await ctx.contracts.ir.registerIdentity(ctx.alice.address, ctx.bob.address, 32)).wait();
  });

  it("mintea a una address verificada", async () => {
    const { contracts: c, alice } = ctx;
    await (await c.token.mint(alice.address, ONE(1000))).wait();
    assert.equal(await c.token.balanceOf(alice.address), ONE(1000));
    assert.equal(await c.token.totalSupply(), ONE(1000));
  });

  it("no mintea a una address no verificada", async () => {
    const { contracts: c, carol } = ctx;
    await assert.rejects(c.token.mint(carol.address, ONE(1)), /Identity is not verified/);
  });

  it("solo un agente puede mintear", async () => {
    const { contracts: c, alice } = ctx;
    await assert.rejects(c.token.connect(alice).mint(alice.address, ONE(1)), /Agent/);
  });

  it("mintear funciona aunque el token esté pausado", async () => {
    // mint() no lleva whenNotPaused. Es a propósito en T-REX, pero conviene
    // tenerlo escrito para que no sorprenda: acá nunca se llamó a unpause().
    const { contracts: c, alice } = ctx;
    assert.equal(await c.token.paused(), true);
    const antes = await c.token.balanceOf(alice.address);
    await (await c.token.mint(alice.address, ONE(5))).wait();
    assert.equal(await c.token.balanceOf(alice.address), antes + ONE(5));
  });
});

describe("transferencias", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  before(async () => {
    ctx = await setup();
    const { contracts: c, alice, bob } = ctx;
    const id = "0x000000000000000000000000000000000000dEaD";
    await (await c.ir.registerIdentity(alice.address, id, 32)).wait();
    await (await c.ir.registerIdentity(bob.address, id, 32)).wait();
    await (await c.token.mint(alice.address, ONE(1000))).wait();
  });

  it("no se puede transferir con el token pausado", async () => {
    const { contracts: c, alice, bob } = ctx;
    await assert.rejects(c.token.connect(alice).transfer(bob.address, ONE(10)), /Pausable|paused/i);
  });

  it("solo un agente puede despausar", async () => {
    const { contracts: c, alice } = ctx;
    await assert.rejects(c.token.connect(alice).unpause(), /Agent/);
  });

  it("transfiere entre dos verificados una vez despausado", async () => {
    const { contracts: c, alice, bob } = ctx;
    await (await c.token.unpause()).wait();
    await (await c.token.connect(alice).transfer(bob.address, ONE(10))).wait();
    assert.equal(await c.token.balanceOf(alice.address), ONE(990));
    assert.equal(await c.token.balanceOf(bob.address), ONE(10));
  });

  it("no transfiere a alguien sin identidad registrada", async () => {
    const { contracts: c, alice, carol } = ctx;
    await assert.rejects(c.token.connect(alice).transfer(carol.address, ONE(1)), /Transfer not possible/);
  });

  it("no transfiere más de lo que hay", async () => {
    const { contracts: c, alice, bob } = ctx;
    await assert.rejects(c.token.connect(alice).transfer(bob.address, ONE(99999)), /Insufficient Balance/);
  });
});

describe("congelamiento", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  before(async () => {
    ctx = await setup();
    const { contracts: c, alice, bob } = ctx;
    const id = "0x000000000000000000000000000000000000dEaD";
    await (await c.ir.registerIdentity(alice.address, id, 32)).wait();
    await (await c.ir.registerIdentity(bob.address, id, 32)).wait();
    await (await c.token.mint(alice.address, ONE(1000))).wait();
    await (await c.token.unpause()).wait();
  });

  it("una wallet congelada no puede transferir", async () => {
    const { contracts: c, alice, bob } = ctx;
    await (await c.token.setAddressFrozen(alice.address, true)).wait();
    assert.equal(await c.token.isFrozen(alice.address), true);
    await assert.rejects(c.token.connect(alice).transfer(bob.address, ONE(1)), /wallet is frozen/);
    await (await c.token.setAddressFrozen(alice.address, false)).wait();
  });

  it("los tokens congelados parcialmente no se pueden mover", async () => {
    const { contracts: c, alice, bob } = ctx;
    await (await c.token.freezePartialTokens(alice.address, ONE(950))).wait();
    assert.equal(await c.token.getFrozenTokens(alice.address), ONE(950));

    // quedan 50 libres
    await (await c.token.connect(alice).transfer(bob.address, ONE(50))).wait();
    await assert.rejects(c.token.connect(alice).transfer(bob.address, ONE(1)), /Insufficient Balance/);
  });

  it("descongelar devuelve la disponibilidad", async () => {
    const { contracts: c, alice, bob } = ctx;
    await (await c.token.unfreezePartialTokens(alice.address, ONE(950))).wait();
    await (await c.token.connect(alice).transfer(bob.address, ONE(100))).wait();
    assert.equal(await c.token.balanceOf(bob.address), ONE(150));
  });
});
