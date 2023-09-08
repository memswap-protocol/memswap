// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {MemswapERC721} from "../MemswapERC721.sol";
import {PermitExecutor} from "../../common/PermitExecutor.sol";
import {WETH2} from "../../common/WETH2.sol";

import {ISolution} from "../interfaces/ISolution.sol";

contract SolutionProxyERC721 is ISolution {
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
        MemswapERC721.Intent[] calldata intents,
        MemswapERC721.Solution calldata solution,
        PermitExecutor.Permit[] calldata permits
    ) external restrictCaller(owner) {
        MemswapERC721(payable(memswap)).solve(intents, solution, permits);
    }

    function solveWithOnChainAuthorizationCheck(
        MemswapERC721.Intent[] calldata intents,
        MemswapERC721.Solution calldata solution,
        PermitExecutor.Permit[] calldata permits
    ) external restrictCaller(owner) {
        MemswapERC721(payable(memswap)).solveWithOnChainAuthorizationCheck(
            intents,
            solution,
            permits
        );
    }

    function solveWithSignatureAuthorizationCheck(
        MemswapERC721.Intent[] calldata intents,
        MemswapERC721.Solution calldata solution,
        MemswapERC721.AuthorizationWithSignature[] calldata auths,
        PermitExecutor.Permit[] calldata permits
    ) external restrictCaller(owner) {
        MemswapERC721(payable(memswap)).solveWithSignatureAuthorizationCheck(
            intents,
            solution,
            auths,
            permits
        );
    }

    function callback(
        MemswapERC721.Intent[] memory intents,
        MemswapERC721.TokenDetails[][] memory tokenDetailsToFill,
        uint128[] memory,
        bytes memory data
    ) external override restrictCaller(memswap) {
        // Assumes a single intent is filled at once
        if (intents.length != 1) {
            revert NotSupported();
        }

        MemswapERC721.Intent memory intent = intents[0];
        MemswapERC721.TokenDetails[] memory detailsToFill = tokenDetailsToFill[
            0
        ];

        if (intent.isBuy) {
            Call[] memory calls = abi.decode(data, (Call[]));

            // Make calls

            unchecked {
                uint256 length = calls.length;
                for (uint256 i; i < length; i++) {
                    makeCall(calls[i]);
                }
            }

            // Push outputs

            unchecked {
                uint256 length = detailsToFill.length;
                for (uint256 i; i < length; i++) {
                    IERC721(intent.buyToken).approve(
                        memswap,
                        detailsToFill[i].tokenId
                    );
                }
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
            revert NotSupported();
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
