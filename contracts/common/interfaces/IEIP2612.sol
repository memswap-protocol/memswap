// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IEIP2612 {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}
