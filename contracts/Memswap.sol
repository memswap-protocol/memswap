// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {WETH2} from "./WETH2.sol";

import "hardhat/console.sol";

contract Memswap is ReentrancyGuard {
    // --- Structs ---

    struct Intent {
        address maker;
        address filler;
        IERC20 tokenIn;
        IERC20 tokenOut;
        address referrer;
        uint32 referrerFeeBps;
        uint32 referrerSurplusBps;
        uint32 deadline;
        uint128 amountIn;
        uint128 startAmountOut;
        uint128 expectedAmountOut;
        uint128 endAmountOut;
        bytes signature;
    }

    // --- Events ---

    event IntentFulfilled(bytes32 intentHash, Intent intent);

    // --- Errors ---

    error IntentAlreadyFulfilled();
    error IntentExpired();
    error IntentNotFulfilled();
    error InvalidSignature();
    error Unauthorized();
    error UnsuccessfullCall();

    // --- Fields ---

    IERC20 public immutable WETH;
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public immutable ORDER_TYPEHASH;

    mapping(bytes32 => bool) public isDelegated;
    mapping(bytes32 => bool) public isFulfilled;

    // --- Constructor ---

    constructor() {
        WETH = IERC20(address(new WETH2()));

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
                "address filler,",
                "address tokenIn,",
                "address tokenOut,",
                "address referrer,",
                "uint32 referrerFeeBps,",
                "uint32 referrerSurplusBps,",
                "uint32 deadline,",
                "uint128 amountIn,",
                "uint128 startAmountOut,",
                "uint128 expectedAmountOut,",
                "uint128 endAmountOut",
                ")"
            )
        );
    }

    // Fallback

    receive() external payable {}

    // Public methods

    function delegate(address filler, bytes32 intentHash) external {
        isDelegated[
            keccak256(abi.encodePacked(msg.sender, filler, intentHash))
        ] = true;
    }

    function execute(
        Intent calldata intent,
        address fillContract,
        bytes calldata fillData
    ) external nonReentrant {
        bytes32 intentHash = getIntentHash(intent);
        bytes32 eip712Hash = _getEIP712Hash(intentHash);
        _verifySignature(intent.maker, eip712Hash, intent.signature);

        if (intent.filler != address(0)) {
            if (
                msg.sender != intent.filler &&
                !isDelegated[
                    keccak256(
                        abi.encodePacked(intent.filler, msg.sender, intentHash)
                    )
                ]
            ) {
                revert Unauthorized();
            }
        }

        if (isFulfilled[intentHash]) {
            revert IntentAlreadyFulfilled();
        }
        isFulfilled[intentHash] = true;

        if (intent.deadline < block.timestamp) {
            revert IntentExpired();
        }

        // Pull input tokens into filler's wallet
        _transferToken(
            intent.maker,
            fillContract,
            intent.tokenIn,
            intent.amountIn
        );

        (bool result, ) = fillContract.call(fillData);
        if (!result) {
            revert UnsuccessfullCall();
        }

        // Check

        uint128 amountDiff = intent.startAmountOut - intent.endAmountOut;
        uint128 timeDiff = intent.deadline - uint128(block.timestamp);

        uint128 amountOut = intent.startAmountOut -
            amountDiff /
            (timeDiff > 0 ? timeDiff : 1);

        uint256 tokenOutBalance = address(intent.tokenOut) == address(0)
            ? address(this).balance
            : intent.tokenOut.balanceOf(fillContract);

        if (tokenOutBalance < amountOut) {
            revert IntentNotFulfilled();
        }

        if (intent.referrer != address(0)) {
            if (
                intent.referrerSurplusBps > 0 &&
                intent.expectedAmountOut > amountOut &&
                tokenOutBalance > intent.expectedAmountOut
            ) {
                uint256 surplus = tokenOutBalance - intent.expectedAmountOut;
                uint256 amount = (intent.referrerSurplusBps * surplus) / 10000;
                if (amount > 0) {
                    _transferToken(
                        fillContract,
                        intent.referrer,
                        intent.tokenOut,
                        amount
                    );

                    tokenOutBalance -= amount;
                }
            }

            if (intent.referrerFeeBps > 0) {
                uint256 amount = (intent.referrerFeeBps * amountOut) / 10000;
                if (amount > 0) {
                    _transferToken(
                        fillContract,
                        intent.referrer,
                        intent.tokenOut,
                        amount
                    );

                    tokenOutBalance -= amount;
                }
            }
        }

        _transferToken(
            fillContract,
            intent.maker,
            intent.tokenOut,
            tokenOutBalance
        );

        emit IntentFulfilled(intentHash, intent);
    }

    // Views

    function getIntentHash(
        Intent memory intent
    ) public view returns (bytes32 intentHash) {
        // TODO: Optimize by using assembly
        intentHash = keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                intent.maker,
                intent.filler,
                intent.tokenIn,
                intent.tokenOut,
                intent.referrer,
                intent.referrerFeeBps,
                intent.referrerSurplusBps,
                intent.deadline,
                intent.amountIn,
                intent.startAmountOut,
                intent.expectedAmountOut,
                intent.endAmountOut
            )
        );
    }

    // Internal methods

    function _transferToken(
        address from,
        address to,
        IERC20 token,
        uint256 amount
    ) internal {
        bool success;
        if (address(token) == address(0)) {
            (success, ) = to.call{value: amount}("");
        } else {
            success = token.transferFrom(from, to, amount);
        }

        if (!success) {
            revert UnsuccessfullCall();
        }
    }

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
