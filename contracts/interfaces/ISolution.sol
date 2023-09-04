// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Memswap} from "../Memswap.sol";

interface ISolution {
    function callback(
        Memswap.Intent[] memory intents,
        uint128[] memory amountsToFill,
        bytes memory data
    ) external;
}
