// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ISolution} from "./interfaces/ISolution.sol";

contract Memswap is ReentrancyGuard {
    // --- Structs and enums ---

    enum Side {
        BUY,
        SELL
    }

    struct Intent {
        // When side = BUY:
        // amount = amountOut
        // endAmount = endAmountIn
        // startAmountBps = startAmountInBps
        // expectedAmountBps = expectedAmountInBps

        // When side = SELL:
        // amount = amountIn
        // endAmount = endAmountOut
        // startAmountBps = startAmountOutBps
        // expectedAmountBps = expectedAmountOutBps

        // Exact output (BUY) or exact input (SELL)
        Side side;
        // Token to sell
        IERC20 tokenIn;
        // Token to buy
        IERC20 tokenOut;
        address maker;
        // The address allowed to solve or authorize others to solve
        address matchmaker;
        address source;
        uint16 feeBps;
        uint16 surplusBps;
        uint32 startTime;
        uint32 endTime;
        bool isPartiallyFillable;
        uint128 amount;
        uint128 endAmount;
        uint16 startAmountBps;
        uint16 expectedAmountBps;
        bool hasDynamicSignature;
        bytes signature;
    }

    struct IntentStatus {
        bool isPrevalidated;
        bool isCancelled;
        uint128 amountFilled;
    }

    struct Authorization {
        // When side = BUY:
        // fillAmountToCheck = amount to fill
        // executeAmountToCheck = maximum amount pulled from user

        // When side = SELL:
        // fillAmountToCheck = amount to fill
        // executeAmountToCheck = minimum amount pushed to user

        uint128 fillAmountToCheck;
        uint128 executeAmountToCheck;
        uint32 blockDeadline;
    }

    struct AuthorizationWithSignature {
        Authorization authorization;
        bytes signature;
    }

    struct Solution {
        // When side = BUY:
        // fillAmounts = amounts out to fill
        // executeAmounts = amounts in to pull from user

        // When side = SELL:
        // fillAmounts = amounts in to fill
        // executeAmounts = amounts out to push to user

        bytes data;
        uint128[] fillAmounts;
        uint128[] executeAmounts;
    }

    // --- Events ---

    event IntentCancelled(bytes32 indexed intentHash);
    event IntentPrevalidated(bytes32 indexed intentHash);
    event IntentSolved(
        bytes32 indexed intentHash,
        address tokenIn,
        address tokenOut,
        address maker,
        address solver,
        uint128 amountIn,
        uint128 amountOut
    );
    event IntentsPosted();
    event NonceIncremented(address maker, uint256 newNonce);

    // --- Errors ---

    error AmountCheckFailed();
    error AuthorizationAmountMismatch();
    error AuthorizationIsExpired();
    error IntentCannotBePrevalidated();
    error IntentIsCancelled();
    error IntentIsExpired();
    error IntentIsFilled();
    error IntentIsNotPartiallyFillable();
    error IntentIsNotStarted();
    error InvalidSignature();
    error InvalidSolution();
    error InvalidStartAndEndTimes();
    error MerkleTreeTooLarge();
    error Unauthorized();
    error UnsuccessfulCall();

    // --- Fields ---

    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public immutable AUTHORIZATION_TYPEHASH;
    bytes32 public immutable INTENT_TYPEHASH;

    mapping(address => uint256) public nonce;
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
                "address solver,",
                "uint128 fillAmountToCheck,",
                "uint128 executeAmountToCheck,",
                "uint32 blockDeadline",
                ")"
            )
        );

        INTENT_TYPEHASH = keccak256(
            abi.encodePacked(
                "Intent(",
                "uint8 side,",
                "address tokenIn,",
                "address tokenOut,",
                "address maker,",
                "address matchmaker,",
                "address source,",
                "uint16 feeBps,",
                "uint16 surplusBps,",
                "uint32 startTime,",
                "uint32 endTime,",
                "uint256 nonce,",
                "bool isPartiallyFillable,",
                "uint128 amount,",
                "uint128 endAmount,",
                "uint16 startAmountBps,",
                "uint16 expectedAmountBps,",
                "bool hasDynamicSignature"
                ")"
            )
        );
    }

    // Fallback

    receive() external payable {}

    // Public methods

    /**
     * @notice Authorize an address to solve particular intents
     *
     * @param intents Intents to solve
     * @param auths Authorizations
     * @param solver The address authorized to solve
     */
    function authorize(
        Intent[] calldata intents,
        Authorization[] calldata auths,
        address solver
    ) external {
        unchecked {
            uint256 intentsLength = intents.length;
            for (uint256 i; i < intentsLength; i++) {
                Intent calldata intent = intents[i];
                Authorization calldata auth = auths[i];

                if (intent.matchmaker != msg.sender) {
                    revert Unauthorized();
                }

                bytes32 intentHash = getIntentHash(intent);
                bytes32 authId = keccak256(
                    abi.encodePacked(intentHash, solver)
                );
                authorization[authId] = auth;
            }
        }
    }

    /**
     * @notice Make intents available on-chain (this method doesn't do anything
     *         useful - it's only used as a mechanism for intent distribution)
     *
     * @custom:param intents Intents being made available
     */
    function post(
        /**
         * @custom:name intents
         */
        Intent[] calldata
    ) external {
        emit IntentsPosted();
    }

    /**
     * @notice Pre-validate an arbitrary number of intents (the signature of each
     *         intent will be checked, thus resulting in skipping verification on
     *         further attempts to solve the intent, unless the intent explicitly
     *         enforces checking the signature on every fill)
     *
     * @param intents Intents to validate
     */
    function prevalidate(Intent[] calldata intents) external {
        unchecked {
            uint256 intentsLength = intents.length;
            for (uint256 i; i < intentsLength; i++) {
                Intent calldata intent = intents[i];
                if (intent.hasDynamicSignature) {
                    revert IntentCannotBePrevalidated();
                }

                bytes32 intentHash = getIntentHash(intent);

                _prevalidateIntent(
                    intentHash,
                    intent.maker,
                    intent.hasDynamicSignature,
                    intent.signature
                );
                emit IntentPrevalidated(intentHash);
            }
        }
    }

    /**
     * @notice Cancel an arbitrary number of intents
     *
     * @param intents Intents to cancel
     */
    function cancel(Intent[] calldata intents) external {
        unchecked {
            uint256 intentsLength = intents.length;
            for (uint256 i; i < intentsLength; i++) {
                Intent calldata intent = intents[i];
                if (intent.maker != msg.sender) {
                    revert Unauthorized();
                }

                bytes32 intentHash = getIntentHash(intent);
                IntentStatus memory status = intentStatus[intentHash];
                status.isPrevalidated = false;
                status.isCancelled = true;

                intentStatus[intentHash] = status;
                emit IntentCancelled(intentHash);
            }
        }
    }

    /**
     * @notice Increment the nonce for `msg.sender`. This will result in
     *         the invalidation of any intents signed with a lower nonce
     *         than the latest value.
     */
    function incrementNonce() external nonReentrant {
        unchecked {
            uint256 newNonce = nonce[msg.sender] + 1;
            nonce[msg.sender] = newNonce;
            emit NonceIncremented(msg.sender, newNonce);
        }
    }

    /**
     * @notice Solve intents
     *
     * @param intents Intents to solve
     * @param solution Solution
     */
    function solve(
        Intent[] calldata intents,
        Solution calldata solution
    ) external nonReentrant {
        uint128[] memory amountsToCheck;

        // Check
        unchecked {
            uint256 intentsLength = intents.length;
            amountsToCheck = new uint128[](intentsLength);
            for (uint256 i; i < intentsLength; i++) {
                Intent calldata intent = intents[i];

                // The intent must be open or tied to the current solver
                if (
                    intent.matchmaker != address(0) &&
                    intent.matchmaker != msg.sender
                ) {
                    revert Unauthorized();
                }

                amountsToCheck[i] = intent.side == Side.SELL
                    ? 0
                    : type(uint128).max;
            }
        }

        // Solve
        _solve(intents, solution, amountsToCheck);
    }

    /**
     * @notice Solve intents with authorization (compared to the regular `solve`,
     *         this method allows solving intents of a matchmaker as long as there
     *         is a valid authorization in-place for the current solver). The auth
     *         will be done on-chain (via a transaction from the matchmaker).
     *
     * @param intents Intents to solve
     * @param solution Solution
     */
    function solveWithOnChainAuthorizationCheck(
        Intent[] calldata intents,
        Solution calldata solution
    ) external nonReentrant {
        uint128[] memory amountsToCheck;

        // Check
        unchecked {
            uint256 intentsLength = intents.length;
            amountsToCheck = new uint128[](intentsLength);
            for (uint256 i; i < intentsLength; i++) {
                Intent calldata intent = intents[i];

                bytes32 intentHash = getIntentHash(intent);
                bytes32 authId = keccak256(
                    abi.encodePacked(intentHash, msg.sender)
                );

                Authorization memory auth = authorization[authId];
                _checkAuthorization(auth, solution.fillAmounts[i]);

                amountsToCheck[i] = auth.executeAmountToCheck;
            }
        }

        // Solve
        _solve(intents, solution, amountsToCheck);
    }

    /**
     * @notice Solve intents with authorization (compared to the regular `solve`,
     *         this method allows solving intents of a matchmaker as long as there
     *         is a valid authorization in-place for the current solver). The auth
     *         will be done off-chain (via a signature from the matchmaker).
     *
     * @param intents Intents to solve
     * @param solution Solution for the intent
     * @param auths Authorizations
     */
    function solveWithSignatureAuthorizationCheck(
        Intent[] calldata intents,
        Solution calldata solution,
        AuthorizationWithSignature[] calldata auths
    ) external nonReentrant {
        uint128[] memory amountsToCheck;

        // Check
        unchecked {
            uint256 intentsLength = intents.length;
            amountsToCheck = new uint128[](intentsLength);
            for (uint256 i; i < intentsLength; i++) {
                Intent calldata intent = intents[i];
                AuthorizationWithSignature calldata authWithSig = auths[i];
                Authorization calldata auth = authWithSig.authorization;

                bytes32 intentHash = getIntentHash(intent);
                bytes32 authorizationHash = getAuthorizationHash(
                    intentHash,
                    msg.sender,
                    auth
                );
                bytes32 digest = _getEIP712Hash(authorizationHash);

                _assertValidSignature(
                    intent.matchmaker,
                    digest,
                    digest,
                    authWithSig.signature.length,
                    authWithSig.signature
                );
                _checkAuthorization(auth, solution.fillAmounts[i]);

                amountsToCheck[i] = auth.executeAmountToCheck;
            }
        }

        // Solve
        _solve(intents, solution, amountsToCheck);
    }

    // View methods

    /**
     * @notice Get the EIP712 struct hash for an authorization
     *
     * @param intentHash Intent EIP712 struct hash to authorize
     * @param solver Solver to authorize
     * @param auth Authorization details/conditions
     *
     * @return authorizationHash The EIP712 struct hash of the authorization
     */
    function getAuthorizationHash(
        bytes32 intentHash,
        address solver,
        Authorization memory auth
    ) public view returns (bytes32 authorizationHash) {
        authorizationHash = keccak256(
            abi.encode(
                AUTHORIZATION_TYPEHASH,
                intentHash,
                solver,
                auth.fillAmountToCheck,
                auth.executeAmountToCheck,
                auth.blockDeadline
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
            bytes.concat(
                abi.encode(
                    INTENT_TYPEHASH,
                    intent.side,
                    intent.tokenIn,
                    intent.tokenOut,
                    intent.maker,
                    intent.matchmaker,
                    intent.source,
                    intent.feeBps,
                    intent.surplusBps,
                    intent.startTime,
                    intent.endTime,
                    nonce[intent.maker]
                ),
                abi.encode(
                    intent.isPartiallyFillable,
                    intent.amount,
                    intent.endAmount,
                    intent.startAmountBps,
                    intent.expectedAmountBps,
                    intent.hasDynamicSignature
                )
            )
        );
    }

    // Internal methods

    function _preProcess(
        Intent[] calldata intents,
        uint128[] memory amountsToFill,
        uint128[] memory amountsToExecute,
        uint128[] memory amountsToCheck
    ) internal returns (uint128[] memory actualAmountsToFill) {
        actualAmountsToFill = new uint128[](intents.length);

        uint256 intentsLength = intents.length;
        for (uint256 i; i < intentsLength; ) {
            Intent calldata intent = intents[i];
            bytes32 intentHash = getIntentHash(intent);

            // Verify start and end times

            if (intent.startTime > block.timestamp) {
                revert IntentIsNotStarted();
            }

            if (intent.endTime < block.timestamp) {
                revert IntentIsExpired();
            }

            if (intent.startTime >= intent.endTime) {
                revert InvalidStartAndEndTimes();
            }

            IntentStatus memory status = intentStatus[intentHash];

            // Verify cancellation status
            if (status.isCancelled) {
                revert IntentIsCancelled();
            }

            // Verify signature
            if (!status.isPrevalidated) {
                _prevalidateIntent(
                    intentHash,
                    intent.maker,
                    intent.hasDynamicSignature,
                    intent.signature
                );
            }

            // Ensure there's still some amount left to be filled
            uint128 amountAvailable = intent.amount - status.amountFilled;
            if (amountAvailable == 0) {
                revert IntentIsFilled();
            }

            // Ensure non-partially-fillable intents are fully filled
            if (
                !intent.isPartiallyFillable &&
                amountsToFill[i] < amountAvailable
            ) {
                revert IntentIsNotPartiallyFillable();
            }

            // Compute the actual amount to fill
            uint128 actualAmountToFill = amountsToFill[i] > amountAvailable
                ? amountAvailable
                : amountsToFill[i];
            intentStatus[intentHash].amountFilled += actualAmountToFill;

            if (actualAmountToFill > 0) {
                if (intent.side == Side.SELL) {
                    // When side = SELL:
                    // amount = amountIn
                    // endAmount = endAmountOut
                    // startAmount = startAmountOut
                    // expectedAmount = expectedAmountOut

                    // Transfer inputs to solver
                    _transferToken(
                        intent.maker,
                        msg.sender,
                        intent.tokenIn,
                        actualAmountToFill
                    );
                } else {
                    // When side = BUY:
                    // amount = amountOut
                    // endAmount = endAmountIn
                    // startAmount = startAmountIn
                    // expectedAmount = expectedAmountIn

                    uint128 endAmount = (intent.endAmount *
                        actualAmountToFill) / intent.amount;
                    uint128 startAmount = endAmount -
                        (endAmount * intent.startAmountBps) /
                        10000;
                    uint128 expectedAmount = endAmount -
                        (endAmount * intent.expectedAmountBps) /
                        10000;

                    //                                                           (now() - startTime)
                    // requiredAmount = startAmount + (endAmount - startAmount) ---------------------
                    //                                                          (endTime - startTime)

                    uint128 requiredAmount = startAmount +
                        ((endAmount - startAmount) *
                            (uint32(block.timestamp) - intent.startTime)) /
                        (intent.endTime - intent.startTime);

                    uint128 executeAmount = amountsToExecute[i];

                    // The amount to execute should be lower than the required amount
                    if (executeAmount > requiredAmount) {
                        revert InvalidSolution();
                    }

                    // The amount to execute should be lower than the check amount
                    if (executeAmount > amountsToCheck[i]) {
                        revert AmountCheckFailed();
                    }

                    if (intent.source != address(0)) {
                        uint128 amount;

                        // Charge fee
                        if (intent.feeBps > 0) {
                            amount += (executeAmount * intent.feeBps) / 10000;
                        }

                        // Charge surplus fee
                        if (
                            intent.surplusBps > 0 &&
                            executeAmount < expectedAmount
                        ) {
                            amount +=
                                ((expectedAmount - executeAmount) *
                                    intent.surplusBps) /
                                10000;
                        }

                        // Transfer fees
                        if (amount > 0) {
                            _transferToken(
                                intent.maker,
                                intent.source,
                                intent.tokenIn,
                                amount
                            );

                            executeAmount -= amount;
                        }
                    }

                    // Transfer inputs to solver
                    if (executeAmount > 0) {
                        _transferToken(
                            intent.maker,
                            msg.sender,
                            intent.tokenIn,
                            executeAmount
                        );
                    }

                    emit IntentSolved(
                        intentHash,
                        address(intent.tokenIn),
                        address(intent.tokenOut),
                        intent.maker,
                        msg.sender,
                        executeAmount,
                        actualAmountToFill
                    );
                }
            }

            actualAmountsToFill[i] = actualAmountToFill;

            unchecked {
                ++i;
            }
        }
    }

    function _postProcess(
        Intent[] calldata intents,
        uint128[] memory amountsToFill,
        uint128[] memory amountsToExecute,
        uint128[] memory amountsToCheck
    ) internal {
        uint256 intentsLength = intents.length;
        for (uint256 i; i < intentsLength; ) {
            Intent calldata intent = intents[i];
            bytes32 intentHash = getIntentHash(intent);

            if (intent.side == Side.SELL) {
                // When side = SELL:
                // amount = amountIn
                // endAmount = endAmountOut
                // startAmount = startAmountOut
                // expectedAmount = expectedAmountOut

                uint128 endAmount = (intent.endAmount * amountsToFill[i]) /
                    intent.amount;
                uint128 startAmount = endAmount +
                    (endAmount * intent.startAmountBps) /
                    10000;
                uint128 expectedAmount = endAmount +
                    (endAmount * intent.expectedAmountBps) /
                    10000;

                //                                                           (now() - startTime)
                // requiredAmount = startAmount - (startAmount - endAmount) ---------------------
                //                                                          (endTime - startTime)

                uint128 requiredAmount = startAmount -
                    ((startAmount - endAmount) *
                        (uint32(block.timestamp) - intent.startTime)) /
                    (intent.endTime - intent.startTime);

                uint128 executeAmount = amountsToExecute[i];

                // The amount to execute should be greater than the required amount
                if (executeAmount < requiredAmount) {
                    revert InvalidSolution();
                }

                // The amount to execute should be greater than the check amount
                if (executeAmount < amountsToCheck[i]) {
                    revert AmountCheckFailed();
                }

                if (intent.source != address(0)) {
                    uint128 amount;

                    // Charge fee
                    if (intent.feeBps > 0) {
                        amount += (executeAmount * intent.feeBps) / 10000;
                    }

                    // Charge surplus fee
                    if (
                        intent.surplusBps > 0 && executeAmount > expectedAmount
                    ) {
                        amount +=
                            ((executeAmount - expectedAmount) *
                                intent.surplusBps) /
                            10000;
                    }

                    // Transfer fees
                    if (amount > 0) {
                        _transferToken(
                            msg.sender,
                            intent.source,
                            intent.tokenOut,
                            amount
                        );

                        executeAmount -= amount;
                    }
                }

                // Transfer ouputs to maker
                if (executeAmount > 0) {
                    _transferToken(
                        msg.sender,
                        intent.maker,
                        intent.tokenOut,
                        executeAmount
                    );
                }

                emit IntentSolved(
                    intentHash,
                    address(intent.tokenIn),
                    address(intent.tokenOut),
                    intent.maker,
                    msg.sender,
                    amountsToFill[i],
                    executeAmount
                );
            } else {
                // When side = BUY:
                // amount = amountOut
                // endAmount = endAmountIn
                // startAmount = startAmountIn
                // expectedAmount = expectedAmountIn

                // Transfer ouputs to maker
                if (amountsToFill[i] > 0) {
                    _transferToken(
                        msg.sender,
                        intent.maker,
                        intent.tokenOut,
                        amountsToFill[i]
                    );
                }
            }

            unchecked {
                ++i;
            }
        }
    }

    /**
     * @dev Solve intents
     *
     * @param intents Intents to solve
     * @param amountsToCheck The amounts to check the solution against
     * @param solution Solution for the intent
     */
    function _solve(
        Intent[] calldata intents,
        Solution calldata solution,
        uint128[] memory amountsToCheck
    ) internal {
        uint128[] memory amountsToFill = solution.fillAmounts;
        uint128[] memory amountsToExecute = solution.executeAmounts;

        // Pre-process
        uint128[] memory actualAmountsToFill = _preProcess(
            intents,
            amountsToFill,
            amountsToExecute,
            amountsToCheck
        );

        // Solve
        ISolution(msg.sender).callback(
            intents,
            amountsToExecute,
            solution.data
        );

        // Post-process
        _postProcess(
            intents,
            actualAmountsToFill,
            amountsToExecute,
            amountsToCheck
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

        // Ensure the amount to fill matches the authorized amount
        if (auth.fillAmountToCheck != amount) {
            revert AuthorizationAmountMismatch();
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
     * @dev Pre-validate an intent by checking its signature
     *
     * @param intentHash EIP712 intent struct hash to verify
     * @param maker The maker of the intent
     * @param hasDynamicSignature Whether the intent has a dynamic signature
     * @param signature The signature of the intent
     */
    function _prevalidateIntent(
        bytes32 intentHash,
        address maker,
        bool hasDynamicSignature,
        bytes calldata signature
    ) internal {
        _verifySignature(intentHash, maker, signature);

        // Mark the intent as validated if allowed
        if (!hasDynamicSignature) {
            intentStatus[intentHash].isPrevalidated = true;
        }
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
            revert UnsuccessfulCall();
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
        // kecca256("BatchIntent(Intent[2]...[2] tree)Intent(uint8 side,address tokenIn,address tokenOut,address maker,address matchmaker,address source,uint16 feeBps,uint16 surplusBps,uint32 startTime,uint32 endTime,uint256 nonce,bool isPartiallyFillable,uint128 amount,uint128 endAmount,uint16 startAmountBps,uint16 expectedAmountBps,bool hasDynamicSignature)")
        if (treeHeight == 1) {
            typeHash = 0x752fe66f461ad26607dab37df65d9f145c404f6d987af0a1396c53aa63c4090f;
        } else if (treeHeight == 2) {
            typeHash = 0x2594282edb473d84da7e88a9b9f66f7fe3cd2c33e20e5b2c690421db86a32380;
        } else if (treeHeight == 3) {
            typeHash = 0x76b81fdcb4be73e208608de69da4cba1fdec2fb82f31781205e378d92e98758e;
        } else if (treeHeight == 4) {
            typeHash = 0xd9a65e15256d62ef180250f50ac26068de751b679b4f9ed7f1615e832c5e988e;
        } else if (treeHeight == 5) {
            typeHash = 0x9a36ed08b115bb0e421302aa0cdeb7072a9ceaa7eb0732ef2c7bbcdaaaf25abf;
        } else if (treeHeight == 6) {
            typeHash = 0x5cddea5c888c2bb7db8e1416408984d8c376bef466804fc27955802d1e66e580;
        } else if (treeHeight == 7) {
            typeHash = 0x31af46d3e7c43bed478af23e497cd1e4b8cd346912e6e5d83f380af2bc0607c5;
        } else if (treeHeight == 8) {
            typeHash = 0x37e29d72978727485bc0d786835c69d98615b7402d54452b99e92709d29e546e;
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
