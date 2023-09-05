// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {WETH2} from "../WETH2.sol";

contract SolutionProxy {
    // --- Structs ---

    struct Call {
        address to;
        bytes data;
        uint256 value;
    }

    // --- Errors ---

    error Unauthorized();
    error UnsuccessfulCall();

    // --- Fields ---

    address public immutable owner;
    address public immutable memswap;

    // --- Constructor ---

    constructor(address ownerAddress, address memswapAddress) {
        owner = ownerAddress;
        memswap = memswapAddress;
    }

    // --- Fallback ---

    receive() external payable {}

    // --- Public methods ---

    function fill(
        Call[] calldata calls,
        IERC20 tokenOut,
        uint256 minAmountOut
    ) external {
        uint256 length = calls.length;
        for (uint256 i; i < length; ) {
            makeCall(calls[i]);

            unchecked {
                ++i;
            }
        }

        bool outputETH = address(tokenOut) == address(0);
        if (outputETH) {
            makeCall(Call(memswap, "", minAmountOut));

            uint256 amountLeft = address(this).balance;
            if (amountLeft > 0) {
                makeCall(Call(owner, "", amountLeft));
            }
        } else {
            tokenOut.approve(memswap, minAmountOut);

            uint256 amountLeft = tokenOut.balanceOf(address(this)) -
                minAmountOut;
            if (amountLeft > 0) {
                tokenOut.transfer(owner, amountLeft);
            }
        }
    }

    // --- Internal methods ---

    function makeCall(Call memory call) internal {
        (bool success, ) = call.to.call{value: call.value}(call.data);
        if (!success) {
            revert UnsuccessfulCall();
        }
    }
}
