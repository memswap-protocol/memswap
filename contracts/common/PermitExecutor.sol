// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IPermit2} from "./interfaces/IPermit2.sol";
import {IUSDC} from "./interfaces/IUSDC.sol";

contract PermitExecutor {
    // --- Structs and enums ---

    enum Kind {
        PERMIT2,
        USDC
    }

    struct Permit {
        Kind kind;
        bytes data;
    }

    // --- Public fields ---

    address public immutable permit2;
    address public immutable usdc;

    // --- Constructor ---

    constructor(address permit2Address, address usdcAddress) {
        permit2 = permit2Address;
        usdc = usdcAddress;
    }

    // --- Modifiers ---

    /**
     * @dev Execute permits
     *
     * @param permits Permits to execute
     */
    modifier executePermits(Permit[] calldata permits) {
        unchecked {
            uint256 permitsLength = permits.length;
            for (uint256 i; i < permitsLength; i++) {
                Permit calldata permit = permits[i];
                if (permit.kind == Kind.PERMIT2) {
                    (
                        address owner,
                        IPermit2.PermitSingle memory permitSingle,
                        bytes memory signature
                    ) = abi.decode(
                            permit.data,
                            (address, IPermit2.PermitSingle, bytes)
                        );

                    IPermit2(permit2).permit(owner, permitSingle, signature);
                } else {
                    (
                        address owner,
                        address spender,
                        uint256 value,
                        uint256 deadline,
                        uint8 v,
                        bytes32 r,
                        bytes32 s
                    ) = abi.decode(
                            permit.data,
                            (
                                address,
                                address,
                                uint256,
                                uint256,
                                uint8,
                                bytes32,
                                bytes32
                            )
                        );

                    IUSDC(usdc).permit(
                        owner,
                        spender,
                        value,
                        deadline,
                        v,
                        r,
                        s
                    );
                }
            }
        }

        _;
    }

    // --- Internal methods ---

    function _transferFrom(
        address from,
        address to,
        uint160 amount,
        address token
    ) internal {
        IPermit2(permit2).transferFrom(from, to, amount, token);
    }
}
