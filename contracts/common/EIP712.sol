// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract EIP712 {
    // --- Public fields ---

    bytes32 public immutable DOMAIN_SEPARATOR;

    // --- Constructor ---

    constructor(bytes memory name, bytes memory version) {
        uint256 chainId;
        assembly {
            chainId := chainid()
        }

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain("
                    "string name,"
                    "string version,"
                    "uint256 chainId,"
                    "address verifyingContract"
                    ")"
                ),
                keccak256(name),
                keccak256(version),
                chainId,
                address(this)
            )
        );
    }

    // --- Internal methods ---

    /**
     * @dev Get the EIP712 hash of a struct hash
     *
     * @param structHash Struct hash to get the EIP712 hash for
     *
     * @return eip712Hash The resulting EIP712 hash
     */
    function _getEIP712Hash(
        bytes32 structHash
    ) internal view returns (bytes32 eip712Hash) {
        eip712Hash = keccak256(
            abi.encodePacked(hex"1901", DOMAIN_SEPARATOR, structHash)
        );
    }
}
