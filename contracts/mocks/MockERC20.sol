// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}

    function mint(uint256 amount) external {
        _mint(msg.sender, amount);
    }

    // Mock implementations for EIP2612 (no checks are performed)

    function version() external pure returns (string memory) {
        return "1.0";
    }

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256,
        uint8,
        bytes32,
        bytes32
    ) external {
        _approve(owner, spender, value);
    }
}
