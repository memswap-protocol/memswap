// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IMintableERC20 is IERC20 {
    function mint(uint256 amount) external;
}

contract MockFiller {
    receive() external payable {}

    function fill(IERC20 tokenOut, uint256 amount) external payable {
        if (address(tokenOut) == address(0)) {
            (bool success, ) = msg.sender.call{value: amount}("");
            if (!success) {
                revert();
            }
        } else {
            IMintableERC20(address(tokenOut)).mint(amount);
            tokenOut.approve(msg.sender, amount);
        }
    }
}
