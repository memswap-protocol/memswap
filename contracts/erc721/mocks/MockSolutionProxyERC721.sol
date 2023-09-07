// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {MemswapERC721} from "../MemswapERC721.sol";
import {PermitExecutor} from "../../common/PermitExecutor.sol";

import {ISolution} from "../interfaces/ISolution.sol";

interface IMintableERC20 is IERC20 {
    function mint(uint256 amount) external;
}

interface IMintableERC721 is IERC721 {
    function mint(uint256 tokenId) external;
}

contract MockSolutionProxyERC721 is ISolution {
    address public memswap;

    constructor(address memswapAddress) {
        memswap = memswapAddress;
    }

    receive() external payable {}

    function solve(
        MemswapERC721.Intent[] calldata intents,
        MemswapERC721.Solution calldata solution,
        PermitExecutor.Permit[] calldata permits
    ) external {
        MemswapERC721(payable(memswap)).solve(intents, solution, permits);
    }

    function solveWithOnChainAuthorizationCheck(
        MemswapERC721.Intent[] calldata intents,
        MemswapERC721.Solution calldata solution,
        PermitExecutor.Permit[] calldata permits
    ) external {
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
    ) external {
        MemswapERC721(payable(memswap)).solveWithSignatureAuthorizationCheck(
            intents,
            solution,
            auths,
            permits
        );
    }

    function callback(
        MemswapERC721.Intent[] memory intents,
        uint128[] memory,
        bytes memory data
    ) external {
        if (intents[0].isBuy) {
            (address token, uint256[] memory tokenIds) = abi.decode(
                data,
                (address, uint256[])
            );
            unchecked {
                uint256 tokenIdsLength = tokenIds.length;
                for (uint256 i; i < tokenIdsLength; i++) {
                    IMintableERC721(token).mint(tokenIds[i]);
                    IMintableERC721(token).approve(msg.sender, tokenIds[i]);
                }
            }
        } else {
            (address tokenOut, uint128 amount) = abi.decode(
                data,
                (address, uint128)
            );
            if (tokenOut == address(0)) {
                (bool success, ) = msg.sender.call{value: amount}("");
                if (!success) {
                    revert();
                }
            } else {
                IMintableERC20(tokenOut).mint(amount);
                IMintableERC20(tokenOut).approve(msg.sender, amount);
            }
        }
    }
}
