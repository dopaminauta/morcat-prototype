// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.17;

import "../DividendDistributor.sol";

/**
 * Contrato SOLO para tests. No se deploya en ninguna red real.
 *
 * Intenta reentrar en claim() desde el receive(), que es el vector clásico:
 * el distribuidor manda ETH con .call, eso ejecuta código del receptor, y ahí
 * se vuelve a llamar a claim() antes de que el primero termine.
 */
contract ReentrantClaimer {
    DividendDistributor public immutable dist;
    uint256 public roundId;
    uint256 public intentos;
    uint256 public reentradasExitosas;

    constructor(address _dist) {
        dist = DividendDistributor(_dist);
    }

    function atacar(uint256 _roundId) external {
        roundId = _roundId;
        dist.claim(_roundId);
    }

    receive() external payable {
        if (intentos < 3) {
            intentos++;
            // try/catch para que el fallo de la reentrada no tumbe el claim
            // legítimo: queremos medir si entra, no reventar el test.
            try dist.claim(roundId) {
                reentradasExitosas++;
            } catch {}
        }
    }
}
