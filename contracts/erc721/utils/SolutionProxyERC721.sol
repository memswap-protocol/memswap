// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {MemswapERC721} from "../MemswapERC721.sol";
import {PermitExecutor} from "../../common/PermitExecutor.sol";

import {ISolutionERC721} from "../interfaces/ISolutionERC721.sol";

contract SolutionProxyERC721 is ISolutionERC721 {
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
        MemswapERC721.Intent calldata intent,
        MemswapERC721.Solution calldata solution,
        PermitExecutor.Permit[] calldata permits
    ) external restrictCaller(owner) {
        MemswapERC721(payable(memswap)).solve(intent, solution, permits);
    }

    function solveWithOnChainAuthorizationCheck(
        MemswapERC721.Intent calldata intent,
        MemswapERC721.Solution calldata solution,
        PermitExecutor.Permit[] calldata permits
    ) external restrictCaller(owner) {
        MemswapERC721(payable(memswap)).solveWithOnChainAuthorizationCheck(
            intent,
            solution,
            permits
        );
    }

    function solveWithSignatureAuthorizationCheck(
        MemswapERC721.Intent calldata intent,
        MemswapERC721.Solution calldata solution,
        MemswapERC721.Authorization calldata auth,
        bytes calldata authSignature,
        PermitExecutor.Permit[] calldata permits
    ) external restrictCaller(owner) {
        MemswapERC721(payable(memswap)).solveWithSignatureAuthorizationCheck(
            intent,
            solution,
            auth,
            authSignature,
            permits
        );
    }

    // --- Overrides ---

    function refund() external payable override {
        makeCall(Call(owner, "", address(this).balance));
    }

    function callback(
        MemswapERC721.Intent memory intent,
        MemswapERC721.TokenDetails[] memory tokenDetails,
        bytes memory data
    ) external override restrictCaller(memswap) {
        Call[] memory calls = abi.decode(data, (Call[]));

        // Make calls
        unchecked {
            uint256 callsLength = calls.length;
            for (uint256 i; i < callsLength; i++) {
                makeCall(calls[i]);
            }
        }

        uint256 amountToFill = tokenDetails.length;
        if (intent.isBuy) {
            // Push outputs to maker
            unchecked {
                for (uint256 i; i < amountToFill; i++) {
                    IERC721(intent.buyToken).transferFrom(
                        owner,
                        intent.maker,
                        tokenDetails[i].tokenId
                    );
                }
            }

            uint256 amountLeft;

            // Take profits in sell token
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
