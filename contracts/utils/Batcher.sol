// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Memswap} from "../Memswap.sol";
import {WETH2} from "../WETH2.sol";

contract Batcher {
    // --- Structs ---

    struct Fill {
        Memswap.Intent intent;
        address fillContract;
        bytes fillData;
    }

    // --- Errors ---

    error Unauthorized();
    error UnsuccessfulBatch();

    // --- Fields ---

    address public immutable owner;
    address public immutable memswap;

    // --- Constructor ---

    constructor(address ownerAddress, address memswapAddress) {
        owner = ownerAddress;
        memswap = memswapAddress;
    }

    // --- Public methods ---

    function batch(Fill[] calldata fills) external {
        if (msg.sender != owner) {
            revert Unauthorized();
        }

        bool atLeastOneSucceeded;
        uint256 length = fills.length;
        for (uint256 i; i < length; ) {
            Fill calldata fill = fills[i];
            try
                Memswap(payable(memswap)).execute(
                    fill.intent,
                    fill.fillContract,
                    fill.fillData
                )
            {
                atLeastOneSucceeded = true;
            } catch {}

            unchecked {
                ++i;
            }
        }

        if (!atLeastOneSucceeded) {
            revert UnsuccessfulBatch();
        }
    }
}
