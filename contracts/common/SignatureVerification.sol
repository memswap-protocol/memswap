// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {EIP712} from "./EIP712.sol";

// Copied from Seaport's source code
abstract contract SignatureVerification is EIP712 {
    // --- Errors ---

    error InvalidSignature();

    // --- Virtual methods ---

    function _lookupBulkOrderTypehash(
        uint256 treeHeight
    ) internal pure virtual returns (bytes32 typeHash);

    // --- Internal methods ---

    function _verifySignature(
        bytes32 intentHash,
        address signer,
        bytes memory signature
    ) internal view {
        // Skip signature verification if the signer is the caller
        if (signer == msg.sender) {
            return;
        }

        bytes32 originalDigest = _getEIP712Hash(intentHash);
        uint256 originalSignatureLength = signature.length;

        bytes32 digest;
        if (_isValidBulkOrderSize(originalSignatureLength)) {
            (intentHash) = _computeBulkOrderProof(signature, intentHash);
            digest = _getEIP712Hash(intentHash);
        } else {
            digest = originalDigest;
        }

        _assertValidSignature(
            signer,
            digest,
            originalDigest,
            originalSignatureLength,
            signature
        );
    }

    function _isValidBulkOrderSize(
        uint256 signatureLength
    ) internal pure returns (bool validLength) {
        // Utilize assembly to validate the length:
        // (64 + x) + 3 + 32y where (0 <= x <= 1) and (1 <= y <= 24)
        assembly {
            validLength := and(
                lt(sub(signatureLength, 0x63), 0x2e2),
                lt(and(add(signatureLength, 0x1d), 0x1f), 0x2)
            )
        }
    }

    function _computeBulkOrderProof(
        bytes memory proofAndSignature,
        bytes32 leaf
    ) internal pure returns (bytes32 bulkOrderHash) {
        // Declare arguments for the root hash and the height of the proof
        bytes32 root;
        uint256 height;

        // Utilize assembly to efficiently derive the root hash using the proof
        assembly {
            // Retrieve the length of the proof, key, and signature combined
            let fullLength := mload(proofAndSignature)

            // If proofAndSignature has odd length, it is a compact signature with 64 bytes
            let signatureLength := sub(65, and(fullLength, 1))

            // Derive height (or depth of tree) with signature and proof length
            height := shr(0x5, sub(fullLength, signatureLength))

            // Update the length in memory to only include the signature
            mstore(proofAndSignature, signatureLength)

            // Derive the pointer for the key using the signature length
            let keyPtr := add(proofAndSignature, add(0x20, signatureLength))

            // Retrieve the three-byte key using the derived pointer
            let key := shr(0xe8, mload(keyPtr))

            // Retrieve pointer to first proof element by applying a constant for the key size to the derived key pointer
            let proof := add(keyPtr, 0x3)

            // Compute level 1
            let scratchPtr1 := shl(0x5, and(key, 1))
            mstore(scratchPtr1, leaf)
            mstore(xor(scratchPtr1, 0x20), mload(proof))

            // Compute remaining proofs
            for {
                let i := 1
            } lt(i, height) {
                i := add(i, 1)
            } {
                proof := add(proof, 0x20)
                let scratchPtr := shl(0x5, and(shr(i, key), 1))
                mstore(scratchPtr, keccak256(0, 0x40))
                mstore(xor(scratchPtr, 0x20), mload(proof))
            }

            // Compute root hash
            root := keccak256(0, 0x40)
        }

        // Retrieve appropriate typehash constant based on height.
        bytes32 rootTypeHash = _lookupBulkOrderTypehash(height);

        // Use the typehash and the root hash to derive final bulk order hash
        assembly {
            mstore(0, rootTypeHash)
            mstore(0x20, root)
            bulkOrderHash := keccak256(0, 0x40)
        }
    }

    function _assertValidSignature(
        address signer,
        bytes32 digest,
        bytes32 originalDigest,
        uint256 originalSignatureLength,
        bytes memory signature
    ) internal view {
        // Declare value for ecrecover equality or 1271 call success status
        bool success;

        // Utilize assembly to perform optimized signature verification check
        assembly {
            // Ensure that first word of scratch space is empty
            mstore(0, 0)

            // Get the length of the signature.
            let signatureLength := mload(signature)

            // Get the pointer to the value preceding the signature length
            // This will be used for temporary memory overrides - either the signature head for isValidSignature or the digest for ecrecover
            let wordBeforeSignaturePtr := sub(signature, 0x20)

            // Cache the current value behind the signature to restore it later
            let cachedWordBeforeSignature := mload(wordBeforeSignaturePtr)

            // Declare lenDiff + recoveredSigner scope to manage stack pressure
            {
                // Take the difference between the max ECDSA signature length and the actual signature length (overflow desired for any values > 65)
                // If the diff is not 0 or 1, it is not a valid ECDSA signature - move on to EIP1271 check
                let lenDiff := sub(65, signatureLength)

                // Declare variable for recovered signer
                let recoveredSigner

                // If diff is 0 or 1, it may be an ECDSA signature
                // Try to recover signer
                if iszero(gt(lenDiff, 1)) {
                    // Read the signature `s` value
                    let originalSignatureS := mload(add(signature, 0x40))

                    // Read the first byte of the word after `s`
                    // If the signature is 65 bytes, this will be the real `v` value
                    // If not, it will need to be modified - doing it this way saves an extra condition.
                    let v := byte(0, mload(add(signature, 0x60)))

                    // If lenDiff is 1, parse 64-byte signature as ECDSA
                    if lenDiff {
                        // Extract yParity from highest bit of vs and add 27 to get v
                        v := add(shr(0xff, originalSignatureS), 27)

                        // Extract canonical s from vs, all but the highest bit
                        // Temporarily overwrite the original `s` value in the signature
                        mstore(
                            add(signature, 0x40),
                            and(
                                originalSignatureS,
                                0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
                            )
                        )
                    }
                    // Temporarily overwrite the signature length with `v` to conform to the expected input for ecrecover
                    mstore(signature, v)

                    // Temporarily overwrite the word before the length with `digest` to conform to the expected input for ecrecover
                    mstore(wordBeforeSignaturePtr, digest)

                    // Attempt to recover the signer for the given signature
                    // Do not check the call status as ecrecover will return a null address if the signature is invalid
                    pop(
                        staticcall(
                            gas(),
                            0x1, // Call ecrecover precompile
                            wordBeforeSignaturePtr, // Use data memory location
                            0x80, // Size of digest, v, r, and s
                            0, // Write result to scratch space
                            0x20 // Provide size of returned result
                        )
                    )

                    // Restore cached word before signature
                    mstore(wordBeforeSignaturePtr, cachedWordBeforeSignature)

                    // Restore cached signature length
                    mstore(signature, signatureLength)

                    // Restore cached signature `s` value
                    mstore(add(signature, 0x40), originalSignatureS)

                    // Read the recovered signer from the buffer given as return space for ecrecover
                    recoveredSigner := mload(0)
                }

                // Set success to true if the signature provided was a valid
                // ECDSA signature and the signer is not the null address
                // Use gt instead of direct as success is used outside of assembly
                success := and(eq(signer, recoveredSigner), gt(signer, 0))
            }

            // If the signature was not verified with ecrecover, try EIP1271
            if iszero(success) {
                // Reset the original signature length
                mstore(signature, originalSignatureLength)

                // Temporarily overwrite the word before the signature length and use it as the
                // head of the signature input to `isValidSignature`, which has a value of 64
                mstore(wordBeforeSignaturePtr, 0x40)

                // Get pointer to use for the selector of `isValidSignature`
                let selectorPtr := sub(signature, 0x44)

                // Cache the value currently stored at the selector pointer
                let cachedWordOverwrittenBySelector := mload(selectorPtr)

                // Cache the value currently stored at the digest pointer
                let cachedWordOverwrittenByDigest := mload(sub(signature, 0x40))

                // Write the selector first, since it overlaps the digest
                mstore(selectorPtr, 0x44)

                // Next, write the original digest
                mstore(sub(signature, 0x40), originalDigest)

                // Call signer with `isValidSignature` to validate signature
                success := staticcall(
                    gas(),
                    signer,
                    selectorPtr,
                    add(originalSignatureLength, 0x64),
                    0,
                    0x20
                )

                // Determine if the signature is valid on successful calls
                if success {
                    // If first word of scratch space does not contain EIP-1271 signature selector, revert
                    if iszero(
                        eq(
                            mload(0),
                            0x1626ba7e00000000000000000000000000000000000000000000000000000000
                        )
                    ) {
                        success := 0
                    }
                }

                // Restore the cached values overwritten by selector, digest and signature head
                mstore(wordBeforeSignaturePtr, cachedWordBeforeSignature)
                mstore(selectorPtr, cachedWordOverwrittenBySelector)
                mstore(sub(signature, 0x40), cachedWordOverwrittenByDigest)
            }
        }

        if (!success) {
            revert InvalidSignature();
        }
    }
}
