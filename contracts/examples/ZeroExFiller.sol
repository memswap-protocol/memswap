// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract ZeroExFiller {
    address public immutable owner;

    constructor() {
        owner = msg.sender;
    }

    function call(
        address to,
        bytes calldata data,
        uint256 value
    ) external payable {
        require(msg.sender == owner);

        (bool success, ) = to.call{value: value}(data);
        require(success);
    }

    function fill(
        address to,
        bytes calldata data,
        IERC20 tokenIn,
        IERC20 tokenOut
    ) external {
        require(tx.origin == owner);

        bool success;

        if (address(tokenIn) != address(0)) {
            tokenIn.approve(to, type(uint256).max);
        }

        (success, ) = to.call{value: address(this).balance}(data);
        if (!success) {
            revert();
        }

        if (address(tokenOut) != address(0)) {
            tokenOut.approve(msg.sender, type(uint256).max);
        } else {
            (success, ) = msg.sender.call{value: address(this).balance}("");
            if (!success) {
                revert();
            }
        }
    }
}
