// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "hardhat/console.sol";

contract Memswap {
    // --- Structs ---

    struct Intent {
        address maker;
        IERC20 tokenIn;
        IERC20 tokenOut;
        uint256 amountIn;
        uint256 startAmountOut;
        uint256 endAmountOut;
        uint256 deadline;
        bytes signature;
    }

    // --- Errors ---

    error IntentAlreadyFulfilled();
    error IntentExpired();
    error IntentNotFulfilled();
    error InvalidSignature();
    error UnsuccessfullCall();

    // --- Fields ---

    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public immutable ORDER_TYPEHASH;

    mapping(bytes32 => bool) public isFulfilled;

    // --- Constructor ---

    constructor() {
        uint256 chainId;
        assembly {
            chainId := chainid()
        }

        // TODO: Pre-compute and store as a constant
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
                keccak256("Memswap"),
                keccak256("1.0"),
                chainId,
                address(this)
            )
        );

        // TODO: Pre-compute and store as a constant
        ORDER_TYPEHASH = keccak256(
            abi.encodePacked(
                "Intent(",
                "address maker,",
                "address tokenIn,",
                "address tokenOut,",
                "uint256 amountIn,",
                "uint256 startAmountOut,",
                "uint256 endAmountOut,",
                "uint256 deadline",
                ")"
            )
        );
    }

    // Public methods

    function getIntentHash(
        Intent memory intent
    ) public view returns (bytes32 orderHash) {
        // TODO: Optimize by using assembly
        orderHash = keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                intent.maker,
                intent.tokenIn,
                intent.tokenOut,
                intent.amountIn,
                intent.startAmountOut,
                intent.endAmountOut,
                intent.deadline
            )
        );
    }

    function executeIntent(
        Intent calldata intent,
        address fillContract,
        bytes calldata fillData
    ) external {
        bytes32 intentHash = getIntentHash(intent);
        bytes32 eip712Hash = _getEIP712Hash(intentHash);
        _verifySignature(intent.maker, eip712Hash, intent.signature);

        if (isFulfilled[intentHash]) {
            revert IntentAlreadyFulfilled();
        }
        isFulfilled[intentHash] = true;

        if (intent.deadline < block.timestamp) {
            revert IntentExpired();
        }

        // Pull funds
        intent.tokenIn.transferFrom(
            intent.maker,
            address(this),
            intent.amountIn
        );

        // Give approval
        intent.tokenIn.approve(fillContract, intent.amountIn);

        (bool result, ) = fillContract.call(fillData);
        if (!result) {
            revert UnsuccessfullCall();
        }

        // Revoke approval
        intent.tokenIn.approve(fillContract, 0);

        // Check

        uint256 amountOut = intent.startAmountOut -
            (intent.startAmountOut - intent.endAmountOut) /
            (intent.deadline - block.timestamp);

        uint256 tokenOutBalance = intent.tokenOut.balanceOf(intent.maker);
        if (tokenOutBalance < amountOut) {
            revert IntentAlreadyFulfilled();
        }

        // Push funds
        intent.tokenOut.transfer(intent.maker, tokenOutBalance);
    }

    // Internal methods

    function _getEIP712Hash(
        bytes32 structHash
    ) internal view returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(hex"1901", DOMAIN_SEPARATOR, structHash)
            );
    }

    // Taken from:
    // https://github.com/ProjectOpenSea/seaport/blob/e4c6e7b294d7b564fe3fe50c1f786cae9c8ec575/contracts/lib/SignatureVerification.sol#L31-L35
    function _verifySignature(
        address signer,
        bytes32 digest,
        bytes memory signature
    ) internal view {
        bool success;

        // TODO: Add support for EIP1271 contract signatures
        assembly {
            // Ensure that first word of scratch space is empty
            mstore(0, 0)

            let v
            let signatureLength := mload(signature)

            // Get the pointer to the value preceding the signature length
            let wordBeforeSignaturePtr := sub(signature, 0x20)

            // Cache the current value behind the signature to restore it later
            let cachedWordBeforeSignature := mload(wordBeforeSignaturePtr)

            // Declare lenDiff + recoveredSigner scope to manage stack pressure
            {
                // Take the difference between the max ECDSA signature length and the actual signature length
                // Overflow desired for any values > 65
                // If the diff is not 0 or 1, it is not a valid ECDSA signature
                let lenDiff := sub(65, signatureLength)

                let recoveredSigner

                // If diff is 0 or 1, it may be an ECDSA signature, so try to recover signer
                if iszero(gt(lenDiff, 1)) {
                    // Read the signature `s` value
                    let originalSignatureS := mload(add(signature, 0x40))

                    // Read the first byte of the word after `s`
                    // If the signature is 65 bytes, this will be the real `v` value
                    // If not, it will need to be modified - doing it this way saves an extra condition
                    v := byte(0, mload(add(signature, 0x60)))

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
                            1, // Call ecrecover precompile
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

                // Set success to true if the signature provided was a valid ECDSA signature and the signer is not the null address
                // Use gt instead of direct as success is used outside of assembly
                success := and(eq(signer, recoveredSigner), gt(signer, 0))
            }
        }

        if (!success) {
            revert InvalidSignature();
        }
    }
}
