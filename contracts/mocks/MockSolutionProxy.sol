// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Memswap} from "../Memswap.sol";
import {ISolution} from "../interfaces/ISolution.sol";

interface IMintableERC20 is IERC20 {
    function mint(uint256 amount) external;
}

contract MockSolutionProxy is ISolution {
    address public memswap;

    constructor(address memswapAddress) {
        memswap = memswapAddress;
    }

    receive() external payable {}

    function solve(
        Memswap.Intent[] calldata intents,
        Memswap.Solution calldata solution
    ) external {
        Memswap(payable(memswap)).solve(intents, solution);
    }

    function solveWithOnChainAuthorizationCheck(
        Memswap.Intent[] calldata intents,
        Memswap.Solution calldata solution
    ) external {
        Memswap(payable(memswap)).solveWithOnChainAuthorizationCheck(
            intents,
            solution
        );
    }

    function solveWithSignatureAuthorizationCheck(
        Memswap.Intent[] calldata intents,
        Memswap.Solution calldata solution,
        Memswap.AuthorizationWithSignature[] calldata auths
    ) external {
        Memswap(payable(memswap)).solveWithSignatureAuthorizationCheck(
            intents,
            solution,
            auths
        );
    }

    function callback(
        Memswap.Intent[] memory,
        uint128[] memory,
        bytes memory data
    ) external {
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
