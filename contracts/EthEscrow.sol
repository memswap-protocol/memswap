// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

contract EthEscrow {
    // --- Errors ---

    error Unauthorized();
    error UnsuccessfulCall();

    // --- Fields ---

    address public immutable memswap;

    mapping(address => uint256) public balanceOf;

    // --- Constructor ---

    constructor() {
        memswap = msg.sender;
    }

    // Permissioned methods

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool success) {
        if (msg.sender != memswap) {
            revert Unauthorized();
        }

        balanceOf[from] -= amount;
        _transferETH(to, amount);

        success = true;
    }

    // Public methods

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) public {
        balanceOf[msg.sender] -= amount;
        _transferETH(msg.sender, amount);
    }

    // Internal methods

    function _transferETH(address to, uint256 amount) internal {
        (bool success, ) = to.call{value: amount}("");
        if (!success) {
            revert UnsuccessfulCall();
        }
    }
}
