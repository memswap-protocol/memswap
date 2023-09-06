// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MemswapERC20} from "../MemswapERC20.sol";
import {ISolution} from "../interfaces/ISolution.sol";

interface IMintableERC20 is IERC20 {
    function mint(uint256 amount) external;
}

contract MockSolutionProxyERC20 is ISolution {
    address public memswap;

    constructor(address memswapAddress) {
        memswap = memswapAddress;
    }

    receive() external payable {}

    function solve(
        MemswapERC20.Intent[] calldata intents,
        MemswapERC20.Solution calldata solution
    ) external {
        MemswapERC20(payable(memswap)).solve(intents, solution);
    }

    function solveWithOnChainAuthorizationCheck(
        MemswapERC20.Intent[] calldata intents,
        MemswapERC20.Solution calldata solution
    ) external {
        MemswapERC20(payable(memswap)).solveWithOnChainAuthorizationCheck(
            intents,
            solution
        );
    }

    function solveWithSignatureAuthorizationCheck(
        MemswapERC20.Intent[] calldata intents,
        MemswapERC20.Solution calldata solution,
        MemswapERC20.AuthorizationWithSignature[] calldata auths
    ) external {
        MemswapERC20(payable(memswap)).solveWithSignatureAuthorizationCheck(
            intents,
            solution,
            auths
        );
    }

    function callback(
        MemswapERC20.Intent[] memory,
        uint128[] memory,
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
