// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {MemswapERC721} from "../MemswapERC721.sol";

interface ISolutionERC721 {
    function callback(
        MemswapERC721.Intent memory intent,
        MemswapERC721.TokenDetails[] memory tokenDetailsToFill,
        bytes memory data
    ) external;

    function refund() external payable;
}
