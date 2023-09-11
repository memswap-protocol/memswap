// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EIP712} from "../common/EIP712.sol";
import {PermitExecutor} from "../common/PermitExecutor.sol";
import {SignatureVerification} from "../common/SignatureVerification.sol";

import {ISolution} from "./interfaces/ISolution.sol";

contract MemswapERC20 is
    ReentrancyGuard,
    PermitExecutor,
    SignatureVerification
{
    // --- Structs and enums ---

    struct Intent {
        // When isBuy = true:
        // amount = buy amount
        // endAmount = sell end amount
        // startAmountBps = sell start amount bps
        // expectedAmountBps = sell expected amount bps

        // When isBuy = false:
        // amount = sell amount
        // endAmount = buy end amount
        // startAmountBps = buy start amount bps
        // expectedAmountBps = buy expected amount bps

        // Exact output (isBuy = true) or exact input (isBuy = false)
        bool isBuy;
        address buyToken;
        address sellToken;
        address maker;
        // The address allowed to solve or authorize others to solve
        address solver;
        address source;
        uint16 feeBps;
        uint16 surplusBps;
        uint32 startTime;
        uint32 endTime;
        bool isPartiallyFillable;
        bool isSmartOrder;
        uint128 amount;
        uint128 endAmount;
        uint16 startAmountBps;
        uint16 expectedAmountBps;
        bytes signature;
    }

    struct IntentStatus {
        bool isPrevalidated;
        bool isCancelled;
        uint128 amountFilled;
    }

    struct Authorization {
        // When isBuy = true:
        // fillAmountToCheck = buy amount to fill
        // executeAmountToCheck = maximum sell amount pulled from user

        // When isBuy = false:
        // fillAmountToCheck = sell amount to fill
        // executeAmountToCheck = minimum buy amount pushed to user

        uint128 fillAmountToCheck;
        uint128 executeAmountToCheck;
        uint32 blockDeadline;
    }

    struct AuthorizationWithSignature {
        Authorization authorization;
        bytes signature;
    }

    struct Solution {
        // When isBuy = true:
        // fillAmounts = buy amounts to fill
        // executeAmounts = sell amounts to pull from user

        // When isBuy = false:
        // fillAmounts = sell amounts to fill
        // executeAmounts = buy amounts to push to user

        bytes data;
        uint128[] fillAmounts;
        uint128[] executeAmounts;
    }

    // --- Events ---

    event IntentCancelled(bytes32 indexed intentHash);
    event IntentPrevalidated(bytes32 indexed intentHash);
    event IntentSolved(
        bytes32 indexed intentHash,
        bool isBuy,
        address buyToken,
        address sellToken,
        address maker,
        address solver,
        uint128 buyAmount,
        uint128 sellAmount
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
    mapping(bytes32 => bytes32) public intentPrivateData;
    mapping(bytes32 => IntentStatus) public intentStatus;
    mapping(bytes32 => Authorization) public authorization;

    // --- Constructor ---

    constructor() EIP712("MemswapERC20", "1.0") {
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
                "bool isBuy,",
                "address buyToken,",
                "address sellToken,",
                "address maker,",
                "address solver,",
                "address source,",
                "uint16 feeBps,",
                "uint16 surplusBps,",
                "uint32 startTime,",
                "uint32 endTime,",
                "uint256 nonce,",
                "bool isPartiallyFillable,",
                "bool isSmartOrder,",
                "uint128 amount,",
                "uint128 endAmount,",
                "uint16 startAmountBps,",
                "uint16 expectedAmountBps",
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

                if (intent.solver != msg.sender) {
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
                if (intent.isSmartOrder) {
                    revert IntentCannotBePrevalidated();
                }

                bytes32 intentHash = getIntentHash(intent);

                _prevalidateIntent(
                    intentHash,
                    intent.maker,
                    intent.isSmartOrder,
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
    function incrementNonce() external {
        unchecked {
            uint256 newNonce = nonce[msg.sender] + 1;
            nonce[msg.sender] = newNonce;
            emit NonceIncremented(msg.sender, newNonce);
        }
    }

    /**
     * @notice Reveal intents by making available data assumed to not be publicly
     *         available (maker + signature prefix). This method should be called
     *         right before the solution transaction, ideally bundled, so that no
     *         details are revealed sooner than it should be.
     *
     * @param intents Intents to reveal
     */
    function reveal(Intent[] memory intents) external {
        unchecked {
            uint256 intentsLength = intents.length;
            for (uint256 i; i < intentsLength; i++) {
                Intent memory intent = intents[i];

                // Ensure the intent is valid
                bytes32 intentHash = getIntentHash(intent);
                _verifySignature(intentHash, intent.maker, intent.signature);

                // Extract the private data (intent + signature prefix)
                address maker = intent.maker;
                bytes12 signaturePrefix = bytes12(intent.signature);

                // Override the maker with the zero address to get the correct partial intent hash
                intent.maker = address(0);

                // Store the private data (intent + signature prefix)
                bytes32 partialIntentHash = getIntentHash(intent);
                intentPrivateData[partialIntentHash] = bytes32(
                    abi.encodePacked(maker, signaturePrefix)
                );
            }
        }
    }

    /**
     * @notice Solve intents
     *
     * @param intents Intents to solve
     * @param solution Solution
     * @param permits Permits to execute prior to the solution
     */
    function solve(
        Intent[] memory intents,
        Solution calldata solution,
        PermitExecutor.Permit[] calldata permits
    ) external payable nonReentrant executePermits(permits) {
        uint128[] memory amountsToCheck;

        // Check
        unchecked {
            uint256 intentsLength = intents.length;
            amountsToCheck = new uint128[](intentsLength);
            for (uint256 i; i < intentsLength; i++) {
                Intent memory intent = intents[i];
                _includePrivateData(intent);

                // The intent must be open or tied to the current solver
                if (
                    intent.solver != address(0) && intent.solver != msg.sender
                ) {
                    revert Unauthorized();
                }

                amountsToCheck[i] = intent.isBuy ? type(uint128).max : 0;
            }
        }

        // Solve
        _solve(intents, solution, amountsToCheck);
    }

    /**
     * @notice Solve intents with authorization (compared to the regular `solve`,
     *         this method allows solving intents of a solver as long as there is
     *         a valid authorization in-place for the current solver). The checks
     *         for authorization will be done via a storage slot check.
     *
     * @param intents Intents to solve
     * @param solution Solution
     * @param permits Permits to execute prior to the solution
     */
    function solveWithOnChainAuthorizationCheck(
        Intent[] memory intents,
        Solution calldata solution,
        PermitExecutor.Permit[] calldata permits
    ) external payable nonReentrant executePermits(permits) {
        uint128[] memory amountsToCheck;

        // Check
        unchecked {
            uint256 intentsLength = intents.length;
            amountsToCheck = new uint128[](intentsLength);
            for (uint256 i; i < intentsLength; i++) {
                Intent memory intent = intents[i];
                _includePrivateData(intent);

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
     *         this method allows solving intents of a solver as long as there is
     *         a valid authorization in-place for the current solver). The checks
     *         for authorization will be done via a signature.
     *
     * @param intents Intents to solve
     * @param solution Solution for the intent
     * @param auths Authorizations
     * @param permits Permits to execute prior to the solution
     */
    function solveWithSignatureAuthorizationCheck(
        Intent[] memory intents,
        Solution calldata solution,
        AuthorizationWithSignature[] calldata auths,
        PermitExecutor.Permit[] calldata permits
    ) external payable nonReentrant executePermits(permits) {
        uint128[] memory amountsToCheck;

        // Check
        unchecked {
            uint256 intentsLength = intents.length;
            amountsToCheck = new uint128[](intentsLength);
            for (uint256 i; i < intentsLength; i++) {
                Intent memory intent = intents[i];
                _includePrivateData(intent);

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
                    intent.solver,
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
                    intent.isBuy,
                    intent.buyToken,
                    intent.sellToken,
                    intent.maker,
                    intent.solver,
                    intent.source,
                    intent.feeBps,
                    intent.surplusBps,
                    intent.startTime,
                    intent.endTime,
                    nonce[intent.maker]
                ),
                abi.encode(
                    intent.isPartiallyFillable,
                    intent.isSmartOrder,
                    intent.amount,
                    intent.endAmount,
                    intent.startAmountBps,
                    intent.expectedAmountBps
                )
            )
        );
    }

    // Internal methods

    function _preProcess(
        Intent[] memory intents,
        uint128[] memory amountsToFill,
        uint128[] memory amountsToExecute,
        uint128[] memory amountsToCheck
    ) internal returns (uint128[] memory actualAmountsToFill) {
        actualAmountsToFill = new uint128[](intents.length);

        uint256 intentsLength = intents.length;
        for (uint256 i; i < intentsLength; ) {
            Intent memory intent = intents[i];
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
                    intent.isSmartOrder,
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
            if (actualAmountToFill == 0) {
                revert InvalidFillAmount();
            }

            // Update the storage
            intentStatus[intentHash].amountFilled += actualAmountToFill;

            actualAmountsToFill[i] = actualAmountToFill;

            if (intent.isBuy) {
                // When isBuy = true:
                // amount = buy amount
                // endAmount = sell end amount
                // startAmountBps = sell start amount bps
                // expectedAmountBps = sell expected amount bps

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
                            intent.sellToken,
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
                        intent.sellToken,
                        executeAmount
                    );
                }

                emit IntentSolved(
                    intentHash,
                    intent.isBuy,
                    intent.buyToken,
                    intent.sellToken,
                    intent.maker,
                    msg.sender,
                    actualAmountToFill,
                    executeAmount
                );
            } else {
                // When isBuy = false:
                // amount = sell amount
                // endAmount = buy end amount
                // startAmountBps = buy start amount bps
                // expectedAmountBps = buy expected amount bps

                // Transfer inputs to solver
                _transferNativeOrERC20(
                    intent.maker,
                    msg.sender,
                    intent.sellToken,
                    actualAmountToFill
                );
            }

            unchecked {
                ++i;
            }
        }
    }

    function _postProcess(
        Intent[] memory intents,
        uint128[] memory amountsToFill,
        uint128[] memory amountsToExecute,
        uint128[] memory amountsToCheck
    ) internal {
        uint256 intentsLength = intents.length;
        for (uint256 i; i < intentsLength; ) {
            Intent memory intent = intents[i];
            bytes32 intentHash = getIntentHash(intent);

            if (intent.isBuy) {
                // When isBuy = true:
                // amount = buy amount
                // endAmount = sell end amount
                // startAmountBps = sell start amount bps
                // expectedAmountBps = sell expected amount bps

                // Transfer outputs to maker
                _transferNativeOrERC20(
                    msg.sender,
                    intent.maker,
                    intent.buyToken,
                    amountsToFill[i]
                );
            } else {
                // When isBuy = false:
                // amount = sell amount
                // endAmount = buy end amount
                // startAmountBps = buy start amount bps
                // expectedAmountBps = buy expected amount bps

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
                        _transferNativeOrERC20(
                            msg.sender,
                            intent.source,
                            intent.buyToken,
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
                        intent.buyToken,
                        executeAmount
                    );
                }

                emit IntentSolved(
                    intentHash,
                    intent.isBuy,
                    intent.buyToken,
                    intent.sellToken,
                    intent.maker,
                    msg.sender,
                    executeAmount,
                    amountsToFill[i]
                );
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
        Intent[] memory intents,
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
        if (solution.data.length > 0) {
            ISolution(msg.sender).callback(
                intents,
                actualAmountsToFill,
                amountsToExecute,
                solution.data
            );
        }

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
     * @dev Pre-validate an intent by checking its signature
     *
     * @param intentHash EIP712 intent struct hash to verify
     * @param maker The maker of the intent
     * @param isSmartOrder Whether the intent is a smart order
     * @param signature The signature of the intent
     */
    function _prevalidateIntent(
        bytes32 intentHash,
        address maker,
        bool isSmartOrder,
        bytes memory signature
    ) internal {
        _verifySignature(intentHash, maker, signature);

        // Mark the intent as validated if allowed
        if (!isSmartOrder) {
            intentStatus[intentHash].isPrevalidated = true;
        }
    }

    /**
     * @dev Make any private data available for an intent
     *
     * @param intent Intent to make private data available for
     */
    function _includePrivateData(Intent memory intent) internal view {
        if (intent.maker == address(0)) {
            bytes32 intentHash = getIntentHash(intent);
            bytes32 privateData = intentPrivateData[intentHash];

            // For byte conversions, right bits are stripped (we use `bytes20(...)`)
            address revealedMaker = address(uint160(bytes20(privateData)));
            // For numeric conversions, left bits are stripped (we use `uint96(uint256(...))`)
            bytes12 revealedSignaturePrefix = bytes12(
                uint96(uint256(privateData))
            );

            // Override the maker
            intent.maker = revealedMaker;

            // Override the signature prefix
            bytes memory signature = intent.signature;
            assembly {
                mstore(
                    add(signature, 0x20),
                    or(
                        and(
                            mload(add(signature, 0x20)),
                            not(shl(160, 0xFFFFFFFFFFFFFFFFFFFFFFFF))
                        ),
                        revealedSignaturePrefix
                    )
                )
            }
        }
    }

    /**
     * @dev Helper method for transferring native and ERC20 tokens
     *
     * @param from Transfer from this address
     * @param to Transfer to this address
     * @param token Token to transfer (native tokens are represented by the zero address)
     * @param amount Amount to transfer
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
            // First, attempt to transfer directly
            try IERC20(token).transferFrom(from, to, amount) {
                success = true;
            } catch {
                // Secondly, attempt to transfer via permit2
                _permit2TransferFrom(from, to, uint160(amount), token);
                success = true;
            }
        }

        if (!success) {
            revert UnsuccessfulCall();
        }
    }

    // --- Overridden methods ---

    function _lookupBulkOrderTypehash(
        uint256 treeHeight
    ) internal pure override returns (bytes32 typeHash) {
        // kecca256("BatchIntent(Intent[2]...[2] tree)Intent(bool isBuy,address buyToken,address sellToken,address maker,address solver,address source,uint16 feeBps,uint16 surplusBps,uint32 startTime,uint32 endTime,uint256 nonce,bool isPartiallyFillable,bool isSmartOrder,uint128 amount,uint128 endAmount,uint16 startAmountBps,uint16 expectedAmountBps)")
        if (treeHeight == 1) {
            typeHash = 0x58d4087338a63742cea24efad814b65144758ee6edb9148c8f61ad0562c1329e;
        } else if (treeHeight == 2) {
            typeHash = 0x0878f598f63158b6b1466e231ae5736031cb6e962a3fd653bda920befa82a41f;
        } else if (treeHeight == 3) {
            typeHash = 0xf5abbef93a89a2459ef1253be2616f2b763753642ec411443f680d159689fd0a;
        } else if (treeHeight == 4) {
            typeHash = 0xe01b70bf04fd440cf9eeda8da244c05c8ba9923cd8a6c40abde6ca04ca6b146b;
        } else if (treeHeight == 5) {
            typeHash = 0xdde38fb5958e2413be9f3ea9eb5b363db19a383ba6f4be75e6d4d3b921ebad2d;
        } else if (treeHeight == 6) {
            typeHash = 0x041e26fd18116b69ee745f27fb646a42d6c3ddf1068121de5c06fa741ed757a8;
        } else if (treeHeight == 7) {
            typeHash = 0xc2a5fb33c1692c75d8c01bd597d8f34237076fcb987104c5d4f4758d95275ca2;
        } else if (treeHeight == 8) {
            typeHash = 0xda7951bbe464e4a840ca92a63adf783259535c0c4b06d782c86efafafffff9e2;
        } else {
            revert MerkleTreeTooLarge();
        }
    }
}
