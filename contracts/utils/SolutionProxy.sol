// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {WETH2} from "../WETH2.sol";

contract SolutionProxy {
    // --- Errors ---

    error Unauthorized();
    error UnsuccessfulCall();

    // --- Fields ---

    address public immutable owner;
    address public immutable memswap;
    address public immutable weth2;

    // --- Constructor ---

    constructor(
        address ownerAddress,
        address memswapAddress,
        address weth2Address
    ) {
        owner = ownerAddress;
        memswap = memswapAddress;
        weth2 = weth2Address;
    }

    // --- Fallback ---

    receive() external payable {}

    // --- Public methods ---

    function fill(
        address callTo,
        address approveTo,
        bytes calldata data,
        IERC20 tokenIn,
        uint256 amountIn,
        IERC20 tokenOut,
        uint256 amountOut
    ) external {
        if (msg.sender != memswap) {
            revert Unauthorized();
        }

        bool success;

        bool inputETH = address(tokenIn) == address(weth2);
        if (inputETH) {
            WETH2(payable(weth2)).withdraw(amountIn);
        } else {
            tokenIn.approve(approveTo, amountIn);
        }

        (success, ) = callTo.call{value: inputETH ? amountIn : 0}(data);
        if (!success) {
            revert UnsuccessfulCall();
        }

        bool outputETH = address(tokenOut) == address(0);
        if (outputETH) {
            (success, ) = memswap.call{value: amountOut}("");
            if (!success) {
                revert UnsuccessfulCall();
            }

            uint256 amountLeft = address(this).balance;
            if (amountLeft > 0) {
                (success, ) = owner.call{value: amountLeft}("");
                if (!success) {
                    revert UnsuccessfulCall();
                }
            }
        } else {
            tokenOut.approve(memswap, amountOut);

            uint256 amountLeft = tokenOut.balanceOf(address(this)) - amountOut;
            if (amountLeft > 0) {
                tokenOut.transfer(owner, amountLeft);
            }
        }
    }

    // --- Restricted methods ---

    function ownerCall(
        address to,
        bytes calldata data,
        uint256 value
    ) external payable {
        if (msg.sender != owner) {
            revert Unauthorized();
        }

        (bool success, ) = to.call{value: value}(data);
        if (!success) {
            revert UnsuccessfulCall();
        }
    }
}
