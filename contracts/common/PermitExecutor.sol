// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IPermit2} from "./interfaces/IPermit2.sol";
import {IEIP2612} from "./interfaces/IEIP2612.sol";

contract PermitExecutor {
    // --- Structs and enums ---

    enum Kind {
        EIP2612,
        PERMIT2
    }

    struct Permit {
        Kind kind;
        bytes data;
    }

    // --- Public fields ---

    address public immutable permit2 =
        0x000000000022D473030F116dDEE9F6B43aC78BA3;

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
                if (permit.kind == Kind.EIP2612) {
                    (
                        address token,
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
                                address,
                                uint256,
                                uint256,
                                uint8,
                                bytes32,
                                bytes32
                            )
                        );

                    IEIP2612(token).permit(
                        owner,
                        spender,
                        value,
                        deadline,
                        v,
                        r,
                        s
                    );
                } else {
                    (
                        address owner,
                        IPermit2.PermitSingle memory permitSingle,
                        bytes memory signature
                    ) = abi.decode(
                            permit.data,
                            (address, IPermit2.PermitSingle, bytes)
                        );

                    IPermit2(permit2).permit(owner, permitSingle, signature);
                }
            }
        }

        _;
    }

    // --- Internal methods ---

    function _permit2TransferFrom(
        address from,
        address to,
        uint160 amount,
        address token
    ) internal {
        IPermit2(permit2).transferFrom(from, to, amount, token);
    }
}
