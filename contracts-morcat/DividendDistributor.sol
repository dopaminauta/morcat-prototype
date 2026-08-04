// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title DividendDistributor
 * @notice Reparte ingresos (alquileres) entre los holders de un token T-REX,
 *         en proporción a lo que tenían en el momento del reparto.
 *
 * Por qué existe: T-REX / ERC-3643 no trae nada de dividendos. Y como no
 * queremos tocar los contratos oficiales de Tokeny, este contrato vive afuera
 * y sólo lee el token.
 *
 * ── Decisiones de diseño ────────────────────────────────────────────────────
 *
 * 1. PULL, no PUSH. Nadie itera holders para mandarles plata: cada uno reclama
 *    lo suyo. Un push se queda sin gas cuando hay muchos holders, y si un
 *    holder es un contrato que rechaza ETH, tumba el reparto entero.
 *
 * 2. SNAPSHOT AL CREAR LA RONDA. Los balances se congelan cuando se crea el
 *    reparto. Si no, alguien cobra, se manda los tokens a otra wallet, y cobra
 *    de nuevo.
 *
 * 3. LA LISTA DE HOLDERS SE VERIFICA CONTRA EL SUPPLY. El operador pasa la
 *    lista de holders, pero el contrato lee los balances él mismo con
 *    balanceOf() y exige que sumen exactamente totalSupply(). O sea: no se
 *    puede dejar a nadie afuera ni inventar balances. Lo único que aporta el
 *    operador son las direcciones, y omitir una hace revertir la transacción.
 *
 *    El token no soporta snapshots nativos y no lo vamos a modificar, así que
 *    esta es la forma de tener un reparto verificable sin tocarlo.
 */
contract DividendDistributor is Ownable, ReentrancyGuard {

    struct Round {
        uint256 amount;       // ETH total del reparto
        uint256 totalSupply;  // supply en el momento del snapshot
        uint256 claimed;      // cuánto se reclamó hasta ahora
        uint64  createdAt;
    }

    /// Token cuyos holders cobran. Inmutable: un distribuidor por token.
    IERC20 public immutable token;

    /// Plazo tras el cual el owner puede recuperar lo no reclamado.
    uint256 public constant CLAIM_PERIOD = 365 days;

    Round[] private _rounds;
    mapping(uint256 => mapping(address => uint256)) private _snapshot;
    mapping(uint256 => mapping(address => bool)) private _claimed;

    event RoundCreated(uint256 indexed roundId, uint256 amount, uint256 totalSupply, uint256 holders);
    event Claimed(uint256 indexed roundId, address indexed holder, uint256 amount);
    event UnclaimedRecovered(uint256 indexed roundId, uint256 amount);

    constructor(address _token) {
        require(_token != address(0), "invalid argument - zero address");
        token = IERC20(_token);
    }

    /**
     * @notice Crea un reparto con el ETH enviado en la llamada.
     * @param holders Todas las direcciones con saldo. Tienen que cubrir el
     *        100% del supply o la transacción revierte.
     */
    function createRound(address[] calldata holders)
        external
        payable
        onlyOwner
        returns (uint256 roundId)
    {
        require(msg.value > 0, "sin fondos para repartir");
        uint256 supply = token.totalSupply();
        require(supply > 0, "el token no tiene supply");

        roundId = _rounds.length;

        uint256 suma;
        for (uint256 i = 0; i < holders.length; i++) {
            address holder = holders[i];
            require(holder != address(0), "invalid argument - zero address");
            require(_snapshot[roundId][holder] == 0, "holder repetido");

            uint256 balance = token.balanceOf(holder);
            require(balance > 0, "holder sin saldo");

            _snapshot[roundId][holder] = balance;
            suma += balance;
        }

        // El chequeo que hace confiable al reparto: si falta un holder,
        // la suma no da y no se puede crear la ronda.
        require(suma == supply, "los holders no cubren el supply total");

        _rounds.push(Round({
            amount: msg.value,
            totalSupply: supply,
            claimed: 0,
            createdAt: uint64(block.timestamp)
        }));

        emit RoundCreated(roundId, msg.value, supply, holders.length);
    }

    /// @notice Cuánto le toca a `holder` en la ronda `roundId` (0 si ya cobró).
    function claimable(uint256 roundId, address holder) public view returns (uint256) {
        require(roundId < _rounds.length, "ronda inexistente");
        if (_claimed[roundId][holder]) {
            return 0;
        }
        Round storage round = _rounds[roundId];
        return (round.amount * _snapshot[roundId][holder]) / round.totalSupply;
    }

    /// @notice Reclama lo que corresponde de una ronda.
    function claim(uint256 roundId) public nonReentrant {
        uint256 amount = claimable(roundId, msg.sender);
        require(amount > 0, "nada para reclamar");

        // Efectos antes de la interacción — el nonReentrant es cinturón y tiradores.
        _claimed[roundId][msg.sender] = true;
        _rounds[roundId].claimed += amount;

        // solhint-disable-next-line avoid-low-level-calls
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "transferencia fallida");

        emit Claimed(roundId, msg.sender, amount);
    }

    /// @notice Reclama varias rondas de una.
    function claimMany(uint256[] calldata roundIds) external {
        for (uint256 i = 0; i < roundIds.length; i++) {
            if (claimable(roundIds[i], msg.sender) > 0) {
                claim(roundIds[i]);
            }
        }
    }

    /**
     * @notice Recupera lo no reclamado de una ronda, pasado CLAIM_PERIOD.
     * @dev También barre el polvo de redondeo: la división entera deja
     *      migajas que no le tocan a nadie.
     */
    function recoverUnclaimed(uint256 roundId) external onlyOwner nonReentrant {
        require(roundId < _rounds.length, "ronda inexistente");
        Round storage round = _rounds[roundId];
        require(block.timestamp >= round.createdAt + CLAIM_PERIOD, "todavia se puede reclamar");

        uint256 restante = round.amount - round.claimed;
        require(restante > 0, "nada que recuperar");

        round.claimed = round.amount;

        // solhint-disable-next-line avoid-low-level-calls
        (bool ok, ) = payable(owner()).call{value: restante}("");
        require(ok, "transferencia fallida");

        emit UnclaimedRecovered(roundId, restante);
    }

    function roundsCount() external view returns (uint256) {
        return _rounds.length;
    }

    function getRound(uint256 roundId)
        external
        view
        returns (uint256 amount, uint256 totalSupply, uint256 claimed, uint64 createdAt)
    {
        require(roundId < _rounds.length, "ronda inexistente");
        Round storage round = _rounds[roundId];
        return (round.amount, round.totalSupply, round.claimed, round.createdAt);
    }

    function snapshotOf(uint256 roundId, address holder) external view returns (uint256) {
        return _snapshot[roundId][holder];
    }

    function hasClaimed(uint256 roundId, address holder) external view returns (bool) {
        return _claimed[roundId][holder];
    }
}
