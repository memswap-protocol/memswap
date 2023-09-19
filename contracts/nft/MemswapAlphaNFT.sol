// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

contract MemswapAlphaNFT is ERC1155, Ownable {
    using Strings for uint256;

    // --- Errors ---

    error Unauthorized();

    // --- Fields ---

    // Public

    string public name;
    string public symbol;

    string public contractURI;
    mapping(address => bool) public isAllowedToMint;

    // Private

    uint256 private constant TOKEN_ID = 0;

    // --- Constructor ---

    constructor(
        address _owner,
        string memory _tokenURI,
        string memory _contractURI
    ) ERC1155(_tokenURI) {
        name = "Memswap Alpha NFT";
        symbol = "MEM";

        contractURI = _contractURI;

        _transferOwnership(_owner);
    }

    // --- Public methods ---

    function mint(address recipient) external {
        if (!isAllowedToMint[msg.sender]) {
            revert Unauthorized();
        }

        _mint(recipient, TOKEN_ID, 1, "");
    }

    // --- View methods ---

    function uri(
        uint256 tokenId
    ) public view virtual override returns (string memory) {
        return string(abi.encodePacked(super.uri(tokenId), tokenId.toString()));
    }

    // --- Owner methods ---

    function updateTokenURI(string memory newTokenURI) external onlyOwner {
        _setURI(newTokenURI);
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
}
