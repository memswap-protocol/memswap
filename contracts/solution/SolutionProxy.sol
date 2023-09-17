// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {MemswapERC20} from "../erc20/MemswapERC20.sol";
import {MemswapERC721} from "../erc721/MemswapERC721.sol";
import {PermitExecutor} from "../common/PermitExecutor.sol";

import {ISolutionERC20} from "../erc20/interfaces/ISolutionERC20.sol";
import {ISolutionERC721} from "../erc721/interfaces/ISolutionERC721.sol";

contract SolutionProxy is ISolutionERC20, ISolutionERC721 {
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

    address public owner;
    address public memswapERC20;
    address public memswapERC721;

    // --- Constructor ---

    constructor(
        address ownerAddress,
        address memswapERC20Address,
        address memswapERC721Address
    ) {
        owner = ownerAddress;
        memswapERC20 = memswapERC20Address;
        memswapERC721 = memswapERC721Address;
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

    // --- Owner methods ---

    function transferOwnership(
        address newOwner
    ) external restrictCaller(owner) {
        owner = newOwner;
    }

    function updateMemswapERC20(
        address newMemswapERC20
    ) external restrictCaller(owner) {
        memswapERC20 = newMemswapERC20;
    }

    function updateMemswapERC721(
        address newMemswapERC721
    ) external restrictCaller(owner) {
        memswapERC721 = newMemswapERC721;
    }

    // --- Common ---

    function refund()
        external
        payable
        override(ISolutionERC20, ISolutionERC721)
    {
        makeCall(Call(owner, "", address(this).balance));
    }

    // --- ERC20 ---

    function solveERC20(
        MemswapERC20.Intent calldata intent,
        MemswapERC20.Solution calldata solution,
        PermitExecutor.Permit[] calldata permits
    ) external payable restrictCaller(owner) {
        MemswapERC20(payable(memswapERC20)).solve{value: msg.value}(
            intent,
            solution,
            permits
        );
    }

    function solveWithOnChainAuthorizationCheckERC20(
        MemswapERC20.Intent calldata intent,
        MemswapERC20.Solution calldata solution,
        PermitExecutor.Permit[] calldata permits
    ) external payable restrictCaller(owner) {
        MemswapERC20(payable(memswapERC20)).solveWithOnChainAuthorizationCheck{
            value: msg.value
        }(intent, solution, permits);
    }

    function solveWithSignatureAuthorizationCheckERC20(
        MemswapERC20.Intent calldata intent,
        MemswapERC20.Solution calldata solution,
        MemswapERC20.Authorization calldata auth,
        bytes calldata authSignature,
        PermitExecutor.Permit[] calldata permits
    ) external payable restrictCaller(owner) {
        MemswapERC20(payable(memswapERC20))
            .solveWithSignatureAuthorizationCheck{value: msg.value}(
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
    ) external override restrictCaller(memswapERC20) {
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
            uint256 amountLeft;

            // Push outputs to maker
            bool outputETH = intent.buyToken == address(0);
            if (outputETH) {
                makeCall(Call(intent.maker, "", amountToExecute));

                // Take profits in native token
                amountLeft = address(this).balance;
                if (amountLeft > 0) {
                    makeCall(Call(owner, "", amountLeft));
                }
            } else {
                IERC20(intent.buyToken).transfer(intent.maker, amountToExecute);

                // Take profits in buy token
                amountLeft = IERC20(intent.buyToken).balanceOf(address(this));
                if (amountLeft > 0) {
                    IERC20(intent.buyToken).transfer(owner, amountLeft);
                }
            }
        }
    }

    // --- ERC721 ---

    function solveERC721(
        MemswapERC721.Intent calldata intent,
        MemswapERC721.Solution calldata solution,
        PermitExecutor.Permit[] calldata permits
    ) external payable restrictCaller(owner) {
        MemswapERC721(payable(memswapERC721)).solve{value: msg.value}(
            intent,
            solution,
            permits
        );
    }

    function solveWithOnChainAuthorizationCheckERC721(
        MemswapERC721.Intent calldata intent,
        MemswapERC721.Solution calldata solution,
        PermitExecutor.Permit[] calldata permits
    ) external payable restrictCaller(owner) {
        MemswapERC721(payable(memswapERC721))
            .solveWithOnChainAuthorizationCheck{value: msg.value}(
            intent,
            solution,
            permits
        );
    }

    function solveWithSignatureAuthorizationCheckERC721(
        MemswapERC721.Intent calldata intent,
        MemswapERC721.Solution calldata solution,
        MemswapERC721.Authorization calldata auth,
        bytes calldata authSignature,
        PermitExecutor.Permit[] calldata permits
    ) external payable restrictCaller(owner) {
        MemswapERC721(payable(memswapERC721))
            .solveWithSignatureAuthorizationCheck{value: msg.value}(
            intent,
            solution,
            auth,
            authSignature,
            permits
        );
    }

    function callback(
        MemswapERC721.Intent memory intent,
        MemswapERC721.TokenDetails[] memory,
        bytes memory data
    ) external override restrictCaller(memswapERC721) {
        Call[] memory calls = abi.decode(data, (Call[]));

        // Make calls
        unchecked {
            uint256 callsLength = calls.length;
            for (uint256 i; i < callsLength; i++) {
                makeCall(calls[i]);
            }
        }

        if (intent.isBuy) {
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
