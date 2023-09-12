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
        // expectedAmount = sell expected amount
        // startAmountBps = sell start amount bps
        // endAmountBps = sell end amount bps

        // When isBuy = false:
        // amount = sell amount
        // expectedAmount = buy expected amount
        // startAmountBps = buy start amount bps
        // endAmountBps = buy end amount bps

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
        uint128 expectedAmount;
        uint16 startAmountBps;
        uint16 endAmountBps;
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
        // fillAmount = buy amount to fill

        // When isBuy = false:
        // fillAmount = sell amount to fill

        bytes data;
        uint128 fillAmount;
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
                "uint128 expectedAmount,",
                "uint16 startAmountBps,",
                "uint16 endAmountBps",
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
     * @notice Solve intent
     *
     * @param intent Intent to solve
     * @param solution Solution
     * @param permits Permits to execute prior to the solution
     */
    function solve(
        Intent memory intent,
        Solution calldata solution,
        PermitExecutor.Permit[] calldata permits
    ) external payable nonReentrant executePermits(permits) {
        // Make any private data available
        _includePrivateData(intent);

        // Check authorization
        if (intent.solver != address(0) && intent.solver != msg.sender) {
            revert Unauthorized();
        }

        // Solve
        _solve(intent, solution, intent.isBuy ? type(uint128).max : 0);
    }

    /**
     * @notice Solve intent with authorization. Compared to the regular `solve`,
     *         this method allows solving intents of a different solver, as long
     *         as there's a valid authorization in-place for the current caller.
     *         The authorization will be checked via a storage slot.
     *
     * @param intent Intent to solve
     * @param solution Solution
     * @param permits Permits to execute prior to the solution
     */
    function solveWithOnChainAuthorizationCheck(
        Intent memory intent,
        Solution calldata solution,
        PermitExecutor.Permit[] calldata permits
    ) external payable nonReentrant executePermits(permits) {
        // Make any private data available
        _includePrivateData(intent);

        // Check authorization
        bytes32 intentHash = getIntentHash(intent);
        bytes32 authId = keccak256(abi.encodePacked(intentHash, msg.sender));
        Authorization memory auth = authorization[authId];
        _checkAuthorization(auth, solution.fillAmount);

        // Solve
        _solve(intent, solution, auth.executeAmountToCheck);
    }

    /**
     * @notice Solve intent with authorization. Compared to the regular `solve`,
     *         this method allows solving intents of a different solver, as long
     *         as there's a valid authorization in-place for the current caller.
     *         The authorization will be checked via a signature.
     *
     * @param intent Intent to solve
     * @param solution Solution for the intent
     * @param auth Authorization
     * @param permits Permits to execute prior to the solution
     */
    function solveWithSignatureAuthorizationCheck(
        Intent memory intent,
        Solution calldata solution,
        AuthorizationWithSignature calldata auth,
        PermitExecutor.Permit[] calldata permits
    ) external payable nonReentrant executePermits(permits) {
        // Make any private data available
        _includePrivateData(intent);

        // Check authorization
        bytes32 intentHash = getIntentHash(intent);
        bytes32 authorizationHash = getAuthorizationHash(
            intentHash,
            msg.sender,
            auth.authorization
        );
        bytes32 digest = _getEIP712Hash(authorizationHash);
        _assertValidSignature(
            intent.solver,
            digest,
            digest,
            auth.signature.length,
            auth.signature
        );
        _checkAuthorization(auth.authorization, solution.fillAmount);

        // Solve
        _solve(intent, solution, auth.authorization.executeAmountToCheck);
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
                    intent.expectedAmount,
                    intent.startAmountBps,
                    intent.endAmountBps
                )
            )
        );
    }

    // Internal methods

    function _preProcess(
        Intent memory intent,
        uint128 amountToFill
    ) internal returns (uint128 actualAmountToFill) {
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

        // Verify cancellation status and signature

        IntentStatus memory status = intentStatus[intentHash];

        if (status.isCancelled) {
            revert IntentIsCancelled();
        }

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
        if (!intent.isPartiallyFillable && amountToFill < amountAvailable) {
            revert IntentIsNotPartiallyFillable();
        }

        // Compute the actual amount to fill
        actualAmountToFill = amountToFill > amountAvailable
            ? amountAvailable
            : amountToFill;
        if (actualAmountToFill == 0) {
            revert InvalidFillAmount();
        }

        // Update the storage
        intentStatus[intentHash].amountFilled += actualAmountToFill;

        if (intent.isBuy) {
            // When isBuy = true:
            // amount = buy amount
            // expectedAmount = sell expected amount
            // startAmountBps = sell start amount bps
            // endAmountBps = sell end amount bps

            uint128 expectedAmount = (intent.expectedAmount *
                actualAmountToFill) / intent.amount;
            uint128 startAmount = expectedAmount -
                (expectedAmount * intent.startAmountBps) /
                10000;
            uint128 endAmount = expectedAmount +
                (expectedAmount * intent.endAmountBps) /
                10000;

            //                                                      (now() - startTime)
            // maxAmount = startAmount + (endAmount - startAmount) ---------------------
            //                                                     (endTime - startTime)

            uint128 maxAmount = startAmount +
                ((endAmount - startAmount) *
                    (uint32(block.timestamp) - intent.startTime)) /
                (intent.endTime - intent.startTime);

            // Transfer inputs to solver
            _transferNativeOrERC20(
                intent.maker,
                msg.sender,
                intent.sellToken,
                maxAmount
            );
        } else {
            // When isBuy = false:
            // amount = sell amount
            // expectedAmount = buy expected amount
            // startAmountBps = buy start amount bps
            // endAmountBps = buy end amount bps

            // Transfer inputs to solver
            _transferNativeOrERC20(
                intent.maker,
                msg.sender,
                intent.sellToken,
                actualAmountToFill
            );
        }
    }

    function _postProcess(
        Intent memory intent,
        uint128 amountToFill,
        uint128 amountToCheck,
        uint128 makerBuyBalanceDiff,
        uint128 makerSellBalanceDiff,
        uint128 sourceBalanceDiff
    ) internal {
        bytes32 intentHash = getIntentHash(intent);

        if (intent.isBuy) {
            // When isBuy = true:
            // amount = buy amount
            // expectedAmount = sell expected amount
            // startAmountBps = sell start amount bps
            // endAmountBps = sell end amount bps

            uint128 expectedAmount = (intent.expectedAmount * amountToFill) /
                intent.amount;
            uint128 startAmount = expectedAmount -
                (expectedAmount * intent.startAmountBps) /
                10000;
            uint128 endAmount = expectedAmount +
                (expectedAmount * intent.endAmountBps) /
                10000;

            //                                                      (now() - startTime)
            // maxAmount = startAmount + (endAmount - startAmount) ---------------------
            //                                                     (endTime - startTime)

            uint128 maxAmount = startAmount +
                ((endAmount - startAmount) *
                    (uint32(block.timestamp) - intent.startTime)) /
                (intent.endTime - intent.startTime);

            uint128 executeAmount = makerSellBalanceDiff;

            // The amount to execute should be lower than the maximum allowed amount
            if (executeAmount > maxAmount) {
                revert InvalidSolution();
            }

            // The amount to execute should be lower than the check amount
            if (executeAmount > amountToCheck) {
                revert AmountCheckFailed();
            }

            // Compute total fees
            uint128 sourceFees;
            if (intent.source != address(0)) {
                // Fee
                if (intent.feeBps > 0) {
                    sourceFees += (executeAmount * intent.feeBps) / 10000;
                }

                // Surplus fee
                if (intent.surplusBps > 0 && executeAmount < expectedAmount) {
                    sourceFees +=
                        ((expectedAmount - executeAmount) * intent.surplusBps) /
                        10000;
                }
            }

            // Ensure the correct amount of fees were paid
            if (sourceBalanceDiff < sourceFees) {
                revert InvalidSolution();
            }

            // Ensure the maker got the correct amount of tokens
            if (makerBuyBalanceDiff < amountToFill) {
                revert InvalidSolution();
            }

            emit IntentSolved(
                intentHash,
                intent.isBuy,
                intent.buyToken,
                intent.sellToken,
                intent.maker,
                msg.sender,
                amountToFill,
                executeAmount
            );
        } else {
            // When isBuy = false:
            // amount = sell amount
            // expectedAmount = buy expected amount
            // startAmountBps = buy start amount bps
            // endAmountBps = buy end amount bps

            uint128 expectedAmount = (intent.expectedAmount * amountToFill) /
                intent.amount;
            uint128 startAmount = expectedAmount +
                (expectedAmount * intent.startAmountBps) /
                10000;
            uint128 endAmount = expectedAmount -
                (expectedAmount * intent.endAmountBps) /
                10000;

            //                                                      (now() - startTime)
            // minAmount = startAmount - (startAmount - endAmount) ---------------------
            //                                                     (endTime - startTime)

            uint128 minAmount = startAmount -
                ((startAmount - endAmount) *
                    (uint32(block.timestamp) - intent.startTime)) /
                (intent.endTime - intent.startTime);

            uint128 executeAmount = makerBuyBalanceDiff + sourceBalanceDiff;

            // The amount to execute should be greater than the minimum amount
            if (executeAmount < minAmount) {
                revert InvalidSolution();
            }

            // The amount to execute should be greater than the check amount
            if (executeAmount < amountToCheck) {
                revert AmountCheckFailed();
            }

            // Compute total fees
            uint128 sourceFees;
            if (intent.source != address(0)) {
                // Fee
                if (intent.feeBps > 0) {
                    sourceFees += (executeAmount * intent.feeBps) / 10000;
                }

                // Surplus fee
                if (intent.surplusBps > 0 && executeAmount > expectedAmount) {
                    sourceFees +=
                        ((executeAmount - expectedAmount) * intent.surplusBps) /
                        10000;
                }
            }

            // Ensure the correct amount of fees were paid
            if (sourceBalanceDiff < sourceFees) {
                revert InvalidSolution();
            }

            // Ensure the maker spent the correct amount of tokens
            if (makerSellBalanceDiff < amountToFill) {
                revert InvalidSolution();
            }

            emit IntentSolved(
                intentHash,
                intent.isBuy,
                intent.buyToken,
                intent.sellToken,
                intent.maker,
                msg.sender,
                executeAmount,
                amountToFill
            );
        }
    }

    /**
     * @dev Solve intent
     *
     * @param intent Intent to solve
     * @param solution Solution for the intent
     * @param amountToCheck The amount to check the solution against
     */
    function _solve(
        Intent memory intent,
        Solution calldata solution,
        uint128 amountToCheck
    ) internal {
        // Determine the token for which the amount is variable
        // - isBuy = true -> sellToken (exact output, variable input)
        // - isBuy = false -> buyToken (exact input, variable output)
        address relevantToken = intent.isBuy
            ? intent.sellToken
            : intent.buyToken;

        // Fetch the balances before the solution execution
        uint128 makerBuyBalanceBefore = _getBalanceNativeOrERC20(
            intent.buyToken,
            intent.maker
        );
        uint128 makerSellBalanceBefore = _getBalanceNativeOrERC20(
            intent.sellToken,
            intent.maker
        );
        uint128 sourceBalanceBefore = _getBalanceNativeOrERC20(
            relevantToken,
            intent.source
        );

        // Pre-process
        uint128 actualAmountToFill = _preProcess(intent, solution.fillAmount);

        // Solve
        ISolution(msg.sender).callback(
            intent,
            actualAmountToFill,
            solution.data
        );

        // Fetch the balances after the solution execution
        uint128 makerBuyBalanceAfter = _getBalanceNativeOrERC20(
            intent.buyToken,
            intent.maker
        );
        uint128 makerSellBalanceAfter = _getBalanceNativeOrERC20(
            intent.sellToken,
            intent.maker
        );
        uint128 sourceBalanceAfter = _getBalanceNativeOrERC20(
            relevantToken,
            intent.source
        );

        // Post-process
        _postProcess(
            intent,
            actualAmountToFill,
            amountToCheck,
            makerBuyBalanceAfter - makerBuyBalanceBefore,
            makerSellBalanceBefore - makerSellBalanceAfter,
            sourceBalanceAfter - sourceBalanceBefore
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
                            not(shl(160, 0xffffffffffffffffffffffff))
                        ),
                        revealedSignaturePrefix
                    )
                )
            }
        }
    }

    /**
     * @dev Helper method to get the balance of native or ERC20 tokens
     *
     * @param token Token to get the balance for (native tokens are represented by the zero address)
     * @param owner Wallet to get the balance of
     *
     * @return balance The amount of `token` owned by `owner`
     */
    function _getBalanceNativeOrERC20(
        address token,
        address owner
    ) internal view returns (uint128 balance) {
        if (token == address(0)) {
            balance = uint128(owner.balance);
        } else {
            balance = uint128(IERC20(token).balanceOf(owner));
        }
    }

    /**
     * @dev Helper method for transferring native or ERC20 tokens
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
        if (token == address(0)) {
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
        // keccak256("BatchIntent(Intent[2]...[2] tree)Intent(bool isBuy,address buyToken,address sellToken,address maker,address solver,address source,uint16 feeBps,uint16 surplusBps,uint32 startTime,uint32 endTime,uint256 nonce,bool isPartiallyFillable,bool isSmartOrder,uint128 amount,uint128 expectedAmount,uint16 startAmountBps,uint16 endAmountBps)")
        if (treeHeight == 1) {
            typeHash = 0xa33b5aa75ac40bed1a728b680179e705f830a835644c92cbc29ce05420f42594;
        } else if (treeHeight == 2) {
            typeHash = 0x0075abe3175cb1ea558c9142bd1d99eb8aa4aae73a7e97c2ece615c6e9428524;
        } else if (treeHeight == 3) {
            typeHash = 0x6cebd3402fce1409c074e71d680be61d413e50802bda3251cfb2740610669172;
        } else if (treeHeight == 4) {
            typeHash = 0x805e8f474da3c3868fc84008d838d8c1896d3941f3e29ddd3ce55a77a0a94916;
        } else if (treeHeight == 5) {
            typeHash = 0x8a38fbe0d44eadc66a8f5373f0ac1fb83ae6f3a4cb3b8223fdb736f0e26bb7df;
        } else if (treeHeight == 6) {
            typeHash = 0x587b480581f5ebf33e563c251172806602e85de65d7a657876c9bf38057bcbc2;
        } else if (treeHeight == 7) {
            typeHash = 0x057eb3e6b469a4d44583af2478316f5fccae2d7f9d1f747c5ee13533b0552bf0;
        } else if (treeHeight == 8) {
            typeHash = 0x1264dbb058cef4de3f73e7662aac86323c0209aba4c8d4b5553378de201c663c;
        } else {
            revert MerkleTreeTooLarge();
        }
    }
}
