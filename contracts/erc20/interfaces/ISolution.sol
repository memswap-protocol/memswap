// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {MemswapERC20} from "../MemswapERC20.sol";

interface ISolution {
    function callback(
        MemswapERC20.Intent memory intent,
        uint128 amountToFill,
        bytes memory data
    ) external;
}
