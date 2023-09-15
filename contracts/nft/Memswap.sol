// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract Memswap is ERC721, Ownable {
    // --- Errors ---

    error Unauthorized();

    // --- Fields ---

    // Public

    string public baseTokenURI;
    string public contractURI;

    mapping(address => bool) public isAllowedToMint;

    // Private

    uint256 private nextTokenId;

    // --- Constructor ---

    constructor(
        address _owner,
        string memory _baseTokenURI,
        string memory _contractURI
    ) ERC721("Memswap", "MEM") {
        baseTokenURI = _baseTokenURI;
        contractURI = _contractURI;

        _transferOwnership(_owner);
    }

    // --- Public methods ---

    function mint(address recipient) external {
        if (!isAllowedToMint[msg.sender]) {
            revert Unauthorized();
        }

        _mint(recipient, nextTokenId++);
    }

    // --- Owner methods ---

    function updateBaseTokenURI(
        string memory newBaseTokenURI
    ) external onlyOwner {
        baseTokenURI = newBaseTokenURI;
    }

    function updateContractURI(
        string memory newContractURI
    ) external onlyOwner {
        contractURI = newContractURI;
    }

    function setIsAllowedToMint(
        address[] calldata minters,
        bool[] calldata allowed
    ) external onlyOwner {
        unchecked {
            for (uint256 i; i < minters.length; i++) {
                isAllowedToMint[minters[i]] = allowed[i];
            }
        }
    }

    // --- Internal methods ---

    function _baseURI() internal view override returns (string memory) {
        return baseTokenURI;
    }
}
