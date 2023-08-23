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
        uint128 maximumAmountIn;
        uint128 minimumAmountOut;
        uint32 blockDeadline;
        bool isPartiallyFillable;
    }

    struct Solution {
        address to;
        bytes data;
        uint128 amount;
    }

    // --- Events ---

    event IntentCancelled(bytes32 indexed intentHash);
    event IntentPosted();
    event IntentSolved(
        bytes32 indexed intentHash,
        address tokenIn,
        address tokenOut,
        address maker,
        address filler,
        uint128 amountIn,
        uint128 amountOut
    );
    event IntentValidated(bytes32 indexed intentHash);

    // --- Errors ---

    error AuthorizationIsExpired();
    error AuthorizationIsInsufficient();
    error AuthorizationIsNotPartiallyFillable();
    error IntentIsCancelled();
    error IntentIsExpired();
    error IntentIsFilled();
    error IntentIsNotPartiallyFillable();
    error InvalidSignature();
    error InvalidSolution();
    error MerkleTreeTooLarge();
    error Unauthorized();
    error UnsuccessfullCall();

    // --- Fields ---

    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public immutable AUTHORIZATION_TYPEHASH;
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

        AUTHORIZATION_TYPEHASH = keccak256(
            abi.encodePacked(
                "Authorization(",
                "bytes32 intentHash,",
                "address authorizedFiller,",
                "uint128 maximumAmountIn,",
                "uint128 minimumAmountOut,",
                "uint32 blockDeadline,",
                "bool isPartiallyFillable",
                ")"
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

    /**
     * @notice Authorize an address to solve a particular intent
     *
     * @param intent Intent which is being solved
     * @param authorizedFiller The address authorized to solve the intent
     * @param auth Authorization details and conditions
     */
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

    /**
     * @notice Make an intent available on-chain (this method doesn't do
     *         anything useful, it's only used as a mechanism for intent
     *         distribution)
     *
     * @custom:param intent Intent being made available
     */
    function post(
        /**
         * @custom:name intent
         */
        Intent calldata
    ) external {
        emit IntentPosted();
    }

    /**
     * @notice Validate an arbitrary number of intents (the signature of each
     *         intent will be checked thus resulting in skipping verification
     *         on further attempts to solve the intent)
     *
     * @param intents Intents to validate
     */
    function validate(Intent[] calldata intents) external {
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

    /**
     * @notice Cancel an arbitrary number of intents
     *
     * @param intents Intents to cancel
     */
    function cancel(Intent[] calldata intents) external nonReentrant {
        uint256 length = intents.length;
        for (uint256 i; i < length; ) {
            Intent calldata intent = intents[i];
            if (intent.maker != msg.sender) {
                revert Unauthorized();
            }

            bytes32 intentHash = getIntentHash(intent);
            IntentStatus memory status = intentStatus[intentHash];
            status.isValidated = false;
            status.isCancelled = true;

            intentStatus[intentHash] = status;
            emit IntentCancelled(intentHash);

            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Solve an intent
     *
     * @param intent Intent to solve
     * @param solution Solution for the intent
     */
    function solve(
        Intent calldata intent,
        Solution calldata solution
    ) external nonReentrant {
        // The intent must be open or tied to the current filler
        if (intent.filler != address(0) && intent.filler != msg.sender) {
            revert Unauthorized();
        }

        // Solve (no minimum amount out restrictions when filling without authorization)
        _solve(intent, solution, 0);
    }

    /**
     * @notice Solve an intent with authorization (compared to the regular `solve`,
     *         this method allows filling intents tied to another filler as long as
     *         there is a valid authorization in-place for the current sender). The
     *         authorization check will be done on-chain.
     *
     * @param intent Intent to solve
     * @param solution Solution for the intent
     */
    function solveWithOnChainAuthorizationCheck(
        Intent calldata intent,
        Solution calldata solution
    ) external nonReentrant {
        bytes32 intentHash = getIntentHash(intent);

        // Fetch the authorization
        bytes32 authId = keccak256(abi.encodePacked(intentHash, msg.sender));
        Authorization memory auth = authorization[authId];

        // Check the authorization and solve
        _checkAuthorization(auth, solution.amount);
        _solve(intent, solution, auth.minimumAmountOut);
    }

    /**
     * @notice Solve an intent with authorization (compared to the regular `solve`,
     *         this method allows filling intents tied to another filler as long as
     *         there is a valid authorization in-place for the current sender). The
     *         authorization check will be done via a signature from the filler.
     *
     * @param intent Intent to solve
     * @param solution Solution for the intent
     * @param auth Authorization details/conditions
     * @param signature Authorization signature
     */
    function solveWithSignatureAuthorizationCheck(
        Intent calldata intent,
        Solution calldata solution,
        Authorization calldata auth,
        bytes calldata signature
    ) external nonReentrant {
        bytes32 intentHash = getIntentHash(intent);
        bytes32 authorizationHash = getAuthorizationHash(
            intentHash,
            msg.sender,
            auth
        );

        // Verify the authorization
        bytes32 digest = _getEIP712Hash(authorizationHash);
        _assertValidSignature(
            intent.filler,
            digest,
            digest,
            signature.length,
            signature
        );

        // Check the authorization and solve
        _checkAuthorization(auth, solution.amount);
        _solve(intent, solution, auth.minimumAmountOut);
    }

    // View methods

    /**
     * @notice Get the EIP712 struct hash for an authorization
     *
     * @param intentHash Intent EIP712 struct hash to authorize
     * @param authorizedFiller Filler to authorize
     * @param auth Authorization details/conditions
     *
     * @return authorizationHash The EIP712 struct hash of the authorization
     */
    function getAuthorizationHash(
        bytes32 intentHash,
        address authorizedFiller,
        Authorization memory auth
    ) public view returns (bytes32 authorizationHash) {
        authorizationHash = keccak256(
            abi.encode(
                AUTHORIZATION_TYPEHASH,
                intentHash,
                authorizedFiller,
                auth.maximumAmountIn,
                auth.minimumAmountOut,
                auth.blockDeadline,
                auth.isPartiallyFillable
            )
        );
    }

    /**
     * @notice Get the EIP712 struct hash for an intent
     *
     * @param intent Intent to compute the hash for
     *
     * @return intentHash The EIP712 struct hash of the intent
     */
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

    /**
     * @dev Solve an intent
     *
     * @param intent Intent to solve
     * @param solution Solution for the intent
     * @param minimumAmountOut The minimum amount out the solution is required to fulfill
     */
    function _solve(
        Intent calldata intent,
        Solution calldata solution,
        uint128 minimumAmountOut
    ) internal {
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
        if (!intent.isPartiallyFillable && solution.amount < amountAvailable) {
            revert IntentIsNotPartiallyFillable();
        }

        // Compute the amount available to fill
        uint128 amountToFill = solution.amount > amountAvailable
            ? amountAvailable
            : solution.amount;
        intentStatus[intentHash].amountFilled += amountToFill;

        // Transfer inputs to fill contract
        if (amountToFill > 0) {
            _transferToken(
                intent.maker,
                solution.to,
                intent.tokenIn,
                amountToFill
            );
        }

        // Execute solution
        (bool result, ) = solution.to.call(solution.data);
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

        if (requiredAmountOut < minimumAmountOut) {
            revert InvalidSolution();
        }

        uint256 tokenOutBalance = address(intent.tokenOut) == address(0)
            ? address(this).balance
            : intent.tokenOut.allowance(solution.to, address(this));

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
                    solution.to,
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
                solution.to,
                intent.maker,
                intent.tokenOut,
                tokenOutBalance
            );
        }

        emit IntentSolved(
            intentHash,
            address(intent.tokenIn),
            address(intent.tokenOut),
            intent.maker,
            msg.sender,
            amountToFill,
            uint128(tokenOutBalance)
        );
    }

    /**
     * @dev Check an authorization
     *
     * @param auth Authorization to check
     * @param amount Amount to check the authorization against
     */
    function _checkAuthorization(
        Authorization memory auth,
        uint128 amount
    ) internal view {
        // Ensure the authorization is not expired
        if (auth.blockDeadline < block.number) {
            revert AuthorizationIsExpired();
        }

        // Ensure the amount doesn't exceed the maximum authorized amount
        if (auth.maximumAmountIn < amount) {
            revert AuthorizationIsInsufficient();
        }

        // Ensure non-partially-fillable authorizations are fully filled
        if (!auth.isPartiallyFillable && auth.maximumAmountIn != amount) {
            revert AuthorizationIsNotPartiallyFillable();
        }
    }

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

    /**
     * @dev Validate an intent by checking its signature
     *
     * @param intentHash EIP712 intent struct hash to verify
     * @param maker The maker of the intent
     * @param signature The signature of the intent
     */
    function _validateIntent(
        bytes32 intentHash,
        address maker,
        bytes calldata signature
    ) internal {
        _verifySignature(intentHash, maker, signature);

        // Mark the intent as validated
        intentStatus[intentHash].isValidated = true;
    }

    /**
     * @dev Helper method for transferring native and ERC20 tokens
     *
     * @param from Transfer from this address
     * @param to Transfer to this address
     * @param token Token to transfer
     * @param amount Amonut to transfer
     */
    function _transferToken(
        address from,
        address to,
        IERC20 token,
        uint256 amount
    ) internal {
        bool success;

        // Represent native tokens as `address(0)`
        if (address(token) == address(0)) {
            (success, ) = to.call{value: amount}("");
        } else {
            success = token.transferFrom(from, to, amount);
        }

        if (!success) {
            revert UnsuccessfullCall();
        }
    }

    // Copied from Seaport's source code

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
        uint256 treeHeight
    ) internal pure returns (bytes32 typeHash) {
        // kecca256("BatchIntent(Intent[2]...[2] tree)Intent(address tokenIn,address tokenOut,address maker,address filler,address referrer,uint32 referrerFeeBps,uint32 referrerSurplusBps,uint32 deadline,bool isPartiallyFillable,uint128 amountIn,uint128 startAmountOut,uint128 expectedAmountOut,uint128 endAmountOut)")
        if (treeHeight == 1) {
            typeHash = 0x5888ead0bee66ec5c9b976d7d5f0d5a6ddcdbcb002828fa378f6baaf167922d5;
        } else if (treeHeight == 2) {
            typeHash = 0x60ae5aa548d57f8edc240ccfab272133c227a20488d90e659cc5cba57aac7dd1;
        } else if (treeHeight == 3) {
            typeHash = 0x3b37ca5e523d0714a522e69eeb94ff61f97b6b08f34b78e499bc74ce91cd880c;
        } else if (treeHeight == 4) {
            typeHash = 0xcba57bc231bdd9c56613856301179eac42096dc31cc3ff76c41c2d1ecbe0e88b;
        } else if (treeHeight == 5) {
            typeHash = 0x368cc56a56882cf105ced7b793a3396682e29f6d63f81c3642883256b38e22ed;
        } else if (treeHeight == 6) {
            typeHash = 0xa1dcb7e7297abf2b965bbd82354825d1ce0705a2c6533e24bec353dc5447c01e;
        } else if (treeHeight == 7) {
            typeHash = 0xe6653a68bcd0b9d6b207b8b2436e530343e63be828ced9fb0a751d1901e3ed14;
        } else if (treeHeight == 8) {
            typeHash = 0xfadd1d63d56ccbc53d70d60de34c8f45e85038325ecdfb8e2fba53e5846458f4;
        } else {
            revert MerkleTreeTooLarge();
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
