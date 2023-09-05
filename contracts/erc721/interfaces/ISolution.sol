// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {MemswapERC721} from "../MemswapERC721.sol";

interface ISolution {
    function callback(
        MemswapERC721.Intent[] memory intents,
        uint128[] memory amountsToFill,
        bytes memory data
    ) external;
}
