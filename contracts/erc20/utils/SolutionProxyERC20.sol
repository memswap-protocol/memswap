// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MemswapERC20} from "../MemswapERC20.sol";
import {PermitExecutor} from "../../common/PermitExecutor.sol";

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

    // --- Constructor ---

    constructor(address ownerAddress, address memswapAddress) {
        owner = ownerAddress;
        memswap = memswapAddress;
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
        MemswapERC20.Intent calldata intent,
        MemswapERC20.Solution calldata solution,
        PermitExecutor.Permit[] calldata permits
    ) external restrictCaller(owner) {
        MemswapERC20(payable(memswap)).solve(intent, solution, permits);
    }

    function solveWithOnChainAuthorizationCheck(
        MemswapERC20.Intent calldata intent,
        MemswapERC20.Solution calldata solution,
        PermitExecutor.Permit[] calldata permits
    ) external restrictCaller(owner) {
        MemswapERC20(payable(memswap)).solveWithOnChainAuthorizationCheck(
            intent,
            solution,
            permits
        );
    }

    function solveWithSignatureAuthorizationCheck(
        MemswapERC20.Intent calldata intent,
        MemswapERC20.Solution calldata solution,
        MemswapERC20.Authorization calldata auth,
        bytes calldata authSignature,
        PermitExecutor.Permit[] calldata permits
    ) external restrictCaller(owner) {
        MemswapERC20(payable(memswap)).solveWithSignatureAuthorizationCheck(
            intent,
            solution,
            auth,
            authSignature,
            permits
        );
    }

    function callback(
        MemswapERC20.Intent memory intent,
        uint128 amountToFill,
        bytes memory data
    ) external override restrictCaller(memswap) {
        (uint128 amountToExecute, Call[] memory calls) = abi.decode(
            data,
            (uint128, Call[])
        );

        // Make calls
        unchecked {
            uint256 callsLength = calls.length;
            for (uint256 i; i < callsLength; i++) {
                makeCall(calls[i]);
            }
        }

        if (intent.isBuy) {
            // Push outputs to maker
            bool outputETH = intent.buyToken == address(0);
            if (outputETH) {
                makeCall(Call(intent.maker, "", amountToFill));
            } else {
                IERC20(intent.buyToken).transfer(intent.maker, amountToFill);
            }

            // Take profits in sell token
            uint256 amountLeft;
            amountLeft = IERC20(intent.sellToken).balanceOf(address(this));
            if (amountLeft > 0) {
                IERC20(intent.sellToken).transfer(owner, amountLeft);
            }

            // Take profits in native token
            amountLeft = address(this).balance;
            if (amountLeft > 0) {
                makeCall(Call(owner, "", amountLeft));
            }
        } else {
            // Push outputs to maker
            bool outputETH = intent.buyToken == address(0);
            if (outputETH) {
                makeCall(Call(intent.maker, "", amountToExecute));

                // Take profits in native token
                uint256 amountLeft = address(this).balance;
                if (amountLeft > 0) {
                    makeCall(Call(owner, "", amountLeft));
                }
            } else {
                IERC20(intent.buyToken).transfer(intent.maker, amountToExecute);

                // Take profits in buy token
                uint256 amountLeft = IERC20(intent.buyToken).balanceOf(
                    address(this)
                );
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
