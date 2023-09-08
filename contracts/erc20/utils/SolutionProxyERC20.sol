// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MemswapERC20} from "../MemswapERC20.sol";
import {PermitExecutor} from "../../common/PermitExecutor.sol";
import {WETH2} from "../../common/WETH2.sol";

import {ISolution} from "../interfaces/ISolution.sol";

contract SolutionProxyERC20 is ISolution {
    // --- Structs ---

    struct Call {
        address to;
        bytes data;
        uint256 value;
    }

    // --- Errors ---

    error NotSupported();
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

    // --- Modifiers ---

    modifier restrictCaller(address caller) {
        if (msg.sender != caller) {
            revert Unauthorized();
        }

        _;
    }

    // --- Public methods ---

    function solve(
        MemswapERC20.Intent[] calldata intents,
        MemswapERC20.Solution calldata solution,
        PermitExecutor.Permit[] calldata permits
    ) external restrictCaller(owner) {
        MemswapERC20(payable(memswap)).solve(intents, solution, permits);
    }

    function solveWithOnChainAuthorizationCheck(
        MemswapERC20.Intent[] calldata intents,
        MemswapERC20.Solution calldata solution,
        PermitExecutor.Permit[] calldata permits
    ) external restrictCaller(owner) {
        MemswapERC20(payable(memswap)).solveWithOnChainAuthorizationCheck(
            intents,
            solution,
            permits
        );
    }

    function solveWithSignatureAuthorizationCheck(
        MemswapERC20.Intent[] calldata intents,
        MemswapERC20.Solution calldata solution,
        MemswapERC20.AuthorizationWithSignature[] calldata auths,
        PermitExecutor.Permit[] calldata permits
    ) external restrictCaller(owner) {
        MemswapERC20(payable(memswap)).solveWithSignatureAuthorizationCheck(
            intents,
            solution,
            auths,
            permits
        );
    }

    function callback(
        MemswapERC20.Intent[] memory intents,
        uint128[] memory amountsToFill,
        uint128[] memory amountsToExecute,
        bytes memory data
    ) external override restrictCaller(memswap) {
        // Assumes a single intent is filled at once
        if (intents.length != 1) {
            revert NotSupported();
        }

        MemswapERC20.Intent memory intent = intents[0];
        uint128 amountToFill = amountsToFill[0];
        uint128 amountToExecute = amountsToExecute[0];

        if (intent.isBuy) {
            Call[] memory calls = abi.decode(data, (Call[]));

            // Make calls

            uint256 length = calls.length;
            for (uint256 i; i < length; ) {
                makeCall(calls[i]);

                unchecked {
                    ++i;
                }
            }

            // Push outputs

            bool outputETH = intent.buyToken == address(0);
            if (outputETH) {
                makeCall(Call(memswap, "", amountToFill));
            } else {
                IERC20(intent.buyToken).approve(memswap, amountToFill);
            }

            // Take profits

            uint256 amountLeft;

            amountLeft = IERC20(intent.sellToken).balanceOf(address(this));
            if (amountLeft > 0) {
                IERC20(intent.sellToken).transfer(owner, amountLeft);
            }

            amountLeft = address(this).balance;
            if (amountLeft > 0) {
                makeCall(Call(owner, "", amountLeft));
            }
        } else {
            Call[] memory calls = abi.decode(data, (Call[]));

            // Make calls

            uint256 length = calls.length;
            for (uint256 i; i < length; ) {
                makeCall(calls[i]);

                unchecked {
                    ++i;
                }
            }

            // Push outputs and take profits

            bool outputETH = intent.buyToken == address(0);
            if (outputETH) {
                makeCall(Call(memswap, "", amountToExecute));

                uint256 amountLeft = address(this).balance;
                if (amountLeft > 0) {
                    makeCall(Call(owner, "", amountLeft));
                }
            } else {
                IERC20(intent.buyToken).approve(memswap, amountToExecute);

                uint256 amountLeft = IERC20(intent.buyToken).balanceOf(
                    address(this)
                ) - amountToExecute;
                if (amountLeft > 0) {
                    IERC20(intent.buyToken).transfer(owner, amountLeft);
                }
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
