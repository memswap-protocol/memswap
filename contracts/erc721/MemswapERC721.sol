// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {EIP712} from "../common/EIP712.sol";
import {SignatureVerification} from "../common/SignatureVerification.sol";

import {ISolution} from "./interfaces/ISolution.sol";

contract MemswapERC721 is ReentrancyGuard, SignatureVerification {
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

        Side side;
        // Token to sell
        address tokenIn;
        // Token to buy
        address tokenOut;
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
        // fillTokenIds = token ids to push to user
        // executeAmounts = amounts in to pull from user

        // When side = SELL:
        // fillTokenIds = token ids to pull from user
        // executeAmounts = amounts out to push to user

        bytes data;
        uint256[][] fillTokenIds;
        uint128[] executeAmounts;
    }

    // --- Events ---

    event IntentCancelled(bytes32 indexed intentHash);
    event IntentPrevalidated(bytes32 indexed intentHash);
    event IntentSolved(
        bytes32 indexed intentHash,
        Side side,
        address tokenIn,
        address tokenOut,
        address maker,
        address solver,
        uint128 amount,
        uint256[] tokenIds
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
    error InvalidFillAmount();
    error InvalidSolution();
    error InvalidStartAndEndTimes();
    error MerkleTreeTooLarge();
    error Unauthorized();
    error UnsuccessfulCall();

    // --- Fields ---

    bytes32 public immutable AUTHORIZATION_TYPEHASH;
    bytes32 public immutable INTENT_TYPEHASH;

    mapping(address => uint256) public nonce;
    mapping(bytes32 => IntentStatus) public intentStatus;
    mapping(bytes32 => Authorization) public authorization;

    // --- Constructor ---

    constructor() EIP712("MemswapERC721", "1.0") {
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
                _checkAuthorization(
                    auth,
                    uint128(solution.fillTokenIds[i].length)
                );

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
                _checkAuthorization(
                    auth,
                    uint128(solution.fillTokenIds[i].length)
                );

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
        uint256[][] memory tokenIdsToFill,
        uint128[] memory amountsToExecute,
        uint128[] memory amountsToCheck
    ) internal returns (uint256[][] memory actualTokenIdsToFill) {
        actualTokenIdsToFill = new uint256[][](intents.length);

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

            uint128 amountToFill = uint128(tokenIdsToFill[i].length);

            // Ensure non-partially-fillable intents are fully filled
            if (!intent.isPartiallyFillable && amountToFill < amountAvailable) {
                revert IntentIsNotPartiallyFillable();
            }

            // Compute the actual amount to fill
            uint128 actualAmountToFill = amountToFill > amountAvailable
                ? amountAvailable
                : amountToFill;
            if (actualAmountToFill == 0) {
                revert InvalidFillAmount();
            }

            // Update the storage
            intentStatus[intentHash].amountFilled += actualAmountToFill;

            actualTokenIdsToFill[i] = new uint256[](actualAmountToFill);
            unchecked {
                for (uint256 j; j < actualAmountToFill; j++) {
                    actualTokenIdsToFill[i][j] = tokenIdsToFill[i][j];
                }
            }

            if (intent.side == Side.SELL) {
                // When side = SELL:
                // amount = amountIn
                // endAmount = endAmountOut
                // startAmount = startAmountOut
                // expectedAmount = expectedAmountOut

                unchecked {
                    for (uint256 j; j < actualAmountToFill; j++) {
                        // Transfer outputs to maker
                        _transferERC721(
                            intent.maker,
                            msg.sender,
                            intent.tokenIn,
                            tokenIdsToFill[i][j]
                        );
                    }
                }
            } else {
                // When side = BUY:
                // amount = amountOut
                // endAmount = endAmountIn
                // startAmount = startAmountIn
                // expectedAmount = expectedAmountIn

                uint128 endAmount = (intent.endAmount * actualAmountToFill) /
                    intent.amount;
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
                        intent.surplusBps > 0 && executeAmount < expectedAmount
                    ) {
                        amount +=
                            ((expectedAmount - executeAmount) *
                                intent.surplusBps) /
                            10000;
                    }

                    // Transfer fees
                    if (amount > 0) {
                        _transferNativeOrERC20(
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
                    _transferNativeOrERC20(
                        intent.maker,
                        msg.sender,
                        intent.tokenIn,
                        executeAmount
                    );
                }

                emit IntentSolved(
                    intentHash,
                    intent.side,
                    address(intent.tokenIn),
                    address(intent.tokenOut),
                    intent.maker,
                    msg.sender,
                    executeAmount,
                    actualTokenIdsToFill[i]
                );
            }

            unchecked {
                ++i;
            }
        }
    }

    function _postProcess(
        Intent[] calldata intents,
        uint256[][] memory tokenIdsToFill,
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

                uint128 amountToFill = uint128(tokenIdsToFill[i].length);

                uint128 endAmount = (intent.endAmount * amountToFill) /
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
                        _transferNativeOrERC20(
                            msg.sender,
                            intent.source,
                            intent.tokenOut,
                            amount
                        );

                        executeAmount -= amount;
                    }
                }

                // Transfer outputs to maker
                if (executeAmount > 0) {
                    _transferNativeOrERC20(
                        msg.sender,
                        intent.maker,
                        intent.tokenOut,
                        executeAmount
                    );
                }

                emit IntentSolved(
                    intentHash,
                    intent.side,
                    address(intent.tokenIn),
                    address(intent.tokenOut),
                    intent.maker,
                    msg.sender,
                    executeAmount,
                    tokenIdsToFill[i]
                );
            } else {
                // When side = BUY:
                // amount = amountOut
                // endAmount = endAmountIn
                // startAmount = startAmountIn
                // expectedAmount = expectedAmountIn

                unchecked {
                    uint256 tokenIdsLength = tokenIdsToFill[i].length;
                    for (uint256 j; j < tokenIdsLength; j++) {
                        // Transfer outputs to maker
                        _transferERC721(
                            msg.sender,
                            intent.maker,
                            intent.tokenOut,
                            tokenIdsToFill[i][j]
                        );
                    }
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
        uint256[][] memory tokenIdsToFill = solution.fillTokenIds;
        uint128[] memory amountsToExecute = solution.executeAmounts;

        // Pre-process
        uint256[][] memory actualTokenIdsToFill = _preProcess(
            intents,
            tokenIdsToFill,
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
            actualTokenIdsToFill,
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
     * @param token Token to transfer (native tokens are represented by the zero address)
     * @param amount Amonut to transfer
     */
    function _transferNativeOrERC20(
        address from,
        address to,
        address token,
        uint256 amount
    ) internal {
        bool success;
        if (address(token) == address(0)) {
            (success, ) = to.call{value: amount}("");
        } else {
            success = IERC20(token).transferFrom(from, to, amount);
        }

        if (!success) {
            revert UnsuccessfulCall();
        }
    }

    /**
     * @dev Helper method for transferring ERC721 tokens
     *
     * @param from Transfer from this address
     * @param to Transfer to this address
     * @param token Token to transfer
     * @param tokenId Token id to transfer
     */
    function _transferERC721(
        address from,
        address to,
        address token,
        uint256 tokenId
    ) internal {
        IERC721(token).transferFrom(from, to, tokenId);
    }

    // --- Overridden methods ---

    function _lookupBulkOrderTypehash(
        uint256 treeHeight
    ) internal pure override returns (bytes32 typeHash) {
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
}
