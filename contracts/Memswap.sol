// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Memswap is ReentrancyGuard {
    // --- Structs ---

    struct Intent {
        IERC20 tokenIn;
        IERC20 tokenOut;
        address maker;
        address filler;
        address referrer;
        uint32 referrerFeeBps;
        uint32 referrerSurplusBps;
        uint32 deadline;
        bool isPartiallyFillable;
        uint128 amountIn;
        uint128 startAmountOut;
        uint128 expectedAmountOut;
        uint128 endAmountOut;
        bytes signature;
    }

    struct IntentStatus {
        bool isValidated;
        bool isCancelled;
        uint128 amountFilled;
    }

    struct Authorization {
        uint128 maximumAmount;
        uint32 blockDeadline;
        bool isPartiallyFillable;
    }

    struct Fill {
        address to;
        bytes data;
        uint128 amount;
    }

    // --- Events ---

    event IntentCancelled(bytes32 indexed intentHash);
    event IntentPosted();
    event IntentSolved(bytes32 indexed intentHash, Intent intent, Fill fill);
    event IntentValidated(bytes32 indexed intentHash);

    // --- Errors ---

    error IntentIsCancelled();
    error IntentIsExpired();
    error IntentIsFilled();
    error IntentIsNotPartiallyFillable();
    error InvalidSignature();
    error InvalidSolution();
    error Unauthorized();
    error UnsuccessfullCall();

    // --- Fields ---

    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public immutable INTENT_TYPEHASH;

    mapping(bytes32 => IntentStatus) public intentStatus;
    mapping(bytes32 => Authorization) public authorization;

    // --- Constructor ---

    constructor() {
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
                keccak256("Memswap"),
                keccak256("1.0"),
                chainId,
                address(this)
            )
        );

        INTENT_TYPEHASH = keccak256(
            abi.encodePacked(
                "Intent(",
                "address tokenIn,",
                "address tokenOut,",
                "address maker,",
                "address filler,",
                "address referrer,",
                "uint32 referrerFeeBps,",
                "uint32 referrerSurplusBps,",
                "uint32 deadline,",
                "bool isPartiallyFillable,",
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

    function authorize(
        Intent calldata intent,
        address authorizedFiller,
        Authorization calldata auth
    ) external {
        if (intent.filler != msg.sender) {
            revert Unauthorized();
        }

        bytes32 intentHash = getIntentHash(intent);
        bytes32 authId = keccak256(
            abi.encodePacked(intentHash, authorizedFiller)
        );
        authorization[authId] = auth;
    }

    function post(Intent calldata) external {
        emit IntentPosted();
    }

    function validate(Intent[] calldata intents) external nonReentrant {
        uint256 length = intents.length;
        for (uint256 i; i < length; ) {
            Intent calldata intent = intents[i];

            bytes32 intentHash = getIntentHash(intent);
            _validateIntent(intentHash, intent.maker, intent.signature);

            emit IntentValidated(intentHash);

            unchecked {
                ++i;
            }
        }
    }

    function cancel(Intent[] calldata intents) external nonReentrant {
        uint256 length = intents.length;
        for (uint256 i; i < length; ) {
            Intent calldata intent = intents[i];
            if (intent.maker != msg.sender) {
                revert Unauthorized();
            }

            bytes32 intentHash = getIntentHash(intent);
            emit IntentCancelled(intentHash);

            unchecked {
                ++i;
            }
        }
    }

    function solve(
        Intent calldata intent,
        Fill calldata fill
    ) external nonReentrant {
        if (intent.filler != address(0) && intent.filler != msg.sender) {
            revert Unauthorized();
        }

        _solve(intent, fill);
    }

    function solveWithOnChainAuthorizationCheck(
        Intent calldata intent,
        Fill calldata fill
    ) external nonReentrant {
        bytes32 intentHash = getIntentHash(intent);

        bytes32 authId = keccak256(abi.encodePacked(intentHash, msg.sender));
        Authorization memory auth = authorization[authId];

        if (auth.blockDeadline < block.number) {
            revert Unauthorized();
        }
        if (auth.maximumAmount < fill.amount) {
            revert Unauthorized();
        }
        if (!auth.isPartiallyFillable && auth.maximumAmount != fill.amount) {
            revert Unauthorized();
        }

        _solve(intent, fill);
    }

    function solveWithSignatureAuthorizationCheck(
        Intent calldata intent,
        Fill calldata fill,
        Authorization calldata auth,
        bytes calldata signature
    ) external nonReentrant {
        bytes32 intentHash = getIntentHash(intent);

        bytes32 digest = keccak256(
            abi.encodePacked(
                intentHash,
                msg.sender,
                auth.maximumAmount,
                auth.blockDeadline,
                auth.isPartiallyFillable
            )
        );
        _assertValidSignature(
            intent.filler,
            digest,
            digest,
            signature.length,
            signature
        );

        if (auth.blockDeadline < block.number) {
            revert Unauthorized();
        }
        if (auth.maximumAmount < fill.amount) {
            revert Unauthorized();
        }
        if (!auth.isPartiallyFillable && auth.maximumAmount != fill.amount) {
            revert Unauthorized();
        }

        _solve(intent, fill);
    }

    // View methods

    function getIntentHash(
        Intent memory intent
    ) public view returns (bytes32 intentHash) {
        intentHash = keccak256(
            abi.encode(
                INTENT_TYPEHASH,
                intent.tokenIn,
                intent.tokenOut,
                intent.maker,
                intent.filler,
                intent.referrer,
                intent.referrerFeeBps,
                intent.referrerSurplusBps,
                intent.deadline,
                intent.isPartiallyFillable,
                intent.amountIn,
                intent.startAmountOut,
                intent.expectedAmountOut,
                intent.endAmountOut
            )
        );
    }

    // Internal methods

    function _solve(Intent calldata intent, Fill calldata fill) internal {
        bytes32 intentHash = getIntentHash(intent);

        // Verify deadline
        if (intent.deadline < block.timestamp) {
            revert IntentIsExpired();
        }

        IntentStatus memory status = intentStatus[intentHash];

        // Verify cancellation status
        if (status.isCancelled) {
            revert IntentIsCancelled();
        }

        // Verify signature
        if (!status.isValidated) {
            _validateIntent(intentHash, intent.maker, intent.signature);
        }

        // Ensure there's still some amount left to be filled
        uint128 amountAvailable = intent.amountIn - status.amountFilled;
        if (amountAvailable == 0) {
            revert IntentIsFilled();
        }

        // Ensure non-partially-fillable intents are fully filled
        if (!intent.isPartiallyFillable && fill.amount < amountAvailable) {
            revert IntentIsNotPartiallyFillable();
        }

        // Compute the amount available to fill
        uint128 amountToFill = fill.amount > amountAvailable
            ? amountAvailable
            : fill.amount;
        intentStatus[intentHash].amountFilled += amountToFill;

        // Transfer inputs to fill contract
        if (amountToFill > 0) {
            _transferToken(intent.maker, fill.to, intent.tokenIn, amountToFill);
        }

        // Execute solution
        (bool result, ) = fill.to.call(fill.data);
        if (!result) {
            revert UnsuccessfullCall();
        }

        // Check

        //                                (startAmount - endAmount)
        // requiredAmount = startAmount - -------------------------
        //                                   (deadline - now())

        uint128 amountDiff = intent.startAmountOut - intent.endAmountOut;
        uint128 timeDiff = intent.deadline - uint32(block.timestamp);
        uint128 requiredAmountOut = intent.startAmountOut -
            amountDiff /
            (timeDiff > 0 ? timeDiff : 1);

        uint256 tokenOutBalance = address(intent.tokenOut) == address(0)
            ? address(this).balance
            : intent.tokenOut.allowance(fill.to, address(this));

        // Ensure the maker got at least what he intended
        if (tokenOutBalance < requiredAmountOut) {
            revert InvalidSolution();
        }

        if (intent.referrer != address(0)) {
            uint256 amount;

            // Charge referrer fee
            if (intent.referrerFeeBps > 0) {
                amount += (intent.referrerFeeBps * requiredAmountOut) / 10000;
            }

            // Charge surplus fee
            if (
                intent.referrerSurplusBps > 0 &&
                tokenOutBalance > intent.expectedAmountOut &&
                intent.expectedAmountOut > requiredAmountOut
            ) {
                amount +=
                    (intent.referrerSurplusBps *
                        (tokenOutBalance - intent.expectedAmountOut)) /
                    10000;
            }

            // Transfer fees to referrer
            if (amount > 0) {
                _transferToken(
                    fill.to,
                    intent.referrer,
                    intent.tokenOut,
                    amount
                );

                tokenOutBalance -= amount;
            }
        }

        // Transfer ouputs to maker
        if (tokenOutBalance > 0) {
            _transferToken(
                fill.to,
                intent.maker,
                intent.tokenOut,
                tokenOutBalance
            );
        }

        emit IntentSolved(intentHash, intent, fill);
    }

    function _getEIP712Hash(
        bytes32 structHash
    ) internal view returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(hex"1901", DOMAIN_SEPARATOR, structHash)
            );
    }

    function _validateIntent(
        bytes32 intentHash,
        address maker,
        bytes calldata signature
    ) internal {
        _verifySignature(intentHash, maker, signature);
        intentStatus[intentHash].isValidated = true;
    }

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

        // Read the length of the signature from memory and place on the stack
        uint256 originalSignatureLength = signature.length;

        // Determine effective digest if signature has a valid bulk order size
        bytes32 digest;
        if (_isValidBulkOrderSize(originalSignatureLength)) {
            // Rederive order hash and digest using bulk order proof
            (intentHash) = _computeBulkOrderProof(signature, intentHash);
            digest = _getEIP712Hash(intentHash);
        } else {
            // Supply the original digest as the effective digest
            digest = originalDigest;
        }

        // Ensure that the signature for the digest is valid for the signer
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

    function _lookupBulkOrderTypehash(
        uint256 _treeHeight
    ) internal pure returns (bytes32 _typeHash) {
        // Utilize assembly to efficiently retrieve correct bulk order typehash
        assembly {
            // Use a Yul function to enable use of the `leave` keyword to stop searching once the appropriate type hash is found
            function lookupTypeHash(treeHeight) -> typeHash {
                // Handle tree heights one through eight
                if lt(treeHeight, 9) {
                    // Handle tree heights one through four
                    if lt(treeHeight, 5) {
                        // Handle tree heights one and two
                        if lt(treeHeight, 3) {
                            // Utilize branchless logic to determine typehash
                            typeHash := ternary(
                                eq(treeHeight, 1),
                                0x59e4eeeffa771fdcf6e0b2bdd57eec1d4c28a6b46d763d7b0630bd454c9897ac,
                                0xd9007baeff9e48dd0f15d53a782f644083a72c112216c77ecc9ddf95e252d051
                            )

                            // Exit the function once typehash has been located
                            leave
                        }

                        // Handle height three and four via branchless logic
                        typeHash := ternary(
                            eq(treeHeight, 3),
                            0xea55668d4e1cbca6c2d769ad1de685f6428b14911f37c15d0c4c63d66df0bef6,
                            0xace16f6c79c4e96a97f8fe124281ba9165df225bcac18a4b33d80d6afe0f3b9f
                        )

                        // Exit the function once typehash has been located.
                        leave
                    }

                    // Handle tree height five and six
                    if lt(treeHeight, 7) {
                        // Utilize branchless logic to determine typehash
                        typeHash := ternary(
                            eq(treeHeight, 5),
                            0xec7e70800fd0629d8c3eded1bb2f4d97bf0d77df90f2c2c6044a6baf2ca21972,
                            0x65506a9614d79aef337b38d9dad2956745a60454300e4f9c0974be9d39ecb551
                        )

                        // Exit the function once typehash has been located
                        leave
                    }

                    // Handle height seven and eight via branchless logic
                    typeHash := ternary(
                        eq(treeHeight, 7),
                        0x30faccc97d26554244cd814088f1ef96cf00285061b3bd5f1c102e08887e9025,
                        0x76aa4166a496e03b1f3e584949597a41c9441abbb0b9cb5c5f489dee990d25d1
                    )

                    // Exit the function once typehash has been located
                    leave
                }

                // Handle tree height nine through sixteen
                if lt(treeHeight, 17) {
                    // Handle tree height nine through twelve
                    if lt(treeHeight, 13) {
                        // Handle tree height nine and ten
                        if lt(treeHeight, 11) {
                            // Utilize branchless logic to determine typehash
                            typeHash := ternary(
                                eq(treeHeight, 9),
                                0xe216f4d3d6757777d884cbfd67ce72a84f4f3eb21850580fb707558cd508d2d5,
                                0x23cc45baf83992e33599e36cbf0222a27b2afd5cbf6450447a662b449ad64a83
                            )

                            // Exit the function once typehash has been located
                            leave
                        }

                        // Handle height eleven and twelve via branchless logic
                        typeHash := ternary(
                            eq(treeHeight, 11),
                            0xee6f3fb74c101dcb03fb9769cbf717ec8e78404839d17aa4841c6ab2ac20cd56,
                            0xbe0fad3317cebf51b686dd0a66d27acb869b1faccee40514c702b977aa3c574f
                        )

                        // Exit the function once typehash has been located
                        leave
                    }

                    // Handle tree height thirteen and fourteen
                    if lt(treeHeight, 15) {
                        // Utilize branchless logic to determine typehash
                        typeHash := ternary(
                            eq(treeHeight, 13),
                            0x81e342983c1b9a4e90bbebaf8475371ac2c4e09d2a8056b8e8062016d93bbb31,
                            0x9c6d24f7e815aebe72ce8db091c513f9f93019c2620d8e038bcd7941d4b10e9a
                        )

                        // Exit the function once typehash has been located
                        leave
                    }
                    // Handle height fifteen and sixteen via branchless logic
                    typeHash := ternary(
                        eq(treeHeight, 15),
                        0xcc0d75d3c41d7664567cad6888c1ead146b2150cd988112bddc8f26446acd79d,
                        0xa5cc5a30f8bf2a8ce65aa2ee7870f1d52b6a0fe28b30abded726dadd5ed0287a
                    )

                    // Exit the function once typehash has been located
                    leave
                }

                // Handle tree height seventeen through twenty
                if lt(treeHeight, 21) {
                    // Handle tree height seventeen and eighteen
                    if lt(treeHeight, 19) {
                        // Utilize branchless logic to determine typehash
                        typeHash := ternary(
                            eq(treeHeight, 17),
                            0xe3eab514e6c7ec3ac6078212d0c0be660069e16067a7fc48c8c9517ea63735f6,
                            0xd61fb347b606f8fcfdc36f4c09793046583f026219bb2ab74333e2edc6741eb8
                        )

                        // Exit the function once typehash has been located
                        leave
                    }

                    // Handle height nineteen and twenty via branchless logic
                    typeHash := ternary(
                        eq(treeHeight, 19),
                        0xe9fd80f8457f4a61cb5cd938afb305eed232f5ce20e3f134407b9e93eb60a795,
                        0xf66db8956e120af5d2fb81966c74672890d2bd2b6035bee4ed510194242a864c
                    )

                    // Exit the function once typehash has been located
                    leave
                }

                // Handle tree height twenty-one and twenty-two
                if lt(treeHeight, 23) {
                    // Utilize branchless logic to determine typehash
                    typeHash := ternary(
                        eq(treeHeight, 21),
                        0x37510ac615d338f9af92458407fe93f4cb8b477363541f6613a94434b2407496,
                        0x32889c87bb942b09a8c3d3ff461cb65366dd5103d2a78cc795f1a64b8f6df15f
                    )

                    // Exit the function once typehash has been located
                    leave
                }

                // Handle height twenty-three & twenty-four w/ branchless logic
                typeHash := ternary(
                    eq(treeHeight, 23),
                    0x3b302549a3e7d1f55e22e140315fb9412e8362482210413a1151a3b8c403cf91,
                    0xf7531e6ddb5b7f8342387ddf44ee2c90190fe54293b489a87763980298e0c337
                )

                // Exit the function once typehash has been located
                leave
            }

            // Implement ternary conditional using branchless logic
            function ternary(cond, ifTrue, ifFalse) -> c {
                c := xor(ifFalse, mul(cond, xor(ifFalse, ifTrue)))
            }

            // Look up the typehash using the supplied tree height
            _typeHash := lookupTypeHash(_treeHeight)
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
