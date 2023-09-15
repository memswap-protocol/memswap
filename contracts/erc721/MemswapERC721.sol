// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {EIP712} from "../common/EIP712.sol";
import {PermitExecutor} from "../common/PermitExecutor.sol";
import {SignatureVerification} from "../common/SignatureVerification.sol";

import {ISolutionERC721} from "./interfaces/ISolutionERC721.sol";

contract MemswapERC721 is
    Ownable,
    PermitExecutor,
    ReentrancyGuard,
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
        bool isIncentivized;
        bool isCriteriaOrder;
        uint256 tokenIdOrCriteria;
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

    struct TokenDetails {
        uint256 tokenId;
        bytes32[] criteriaProof;
    }

    struct Solution {
        // When isBuy = true:
        // fillTokenDetails = tokens to push to user

        // When isBuy = false:
        // fillTokenDetails = tokens to pull from user

        bytes data;
        TokenDetails[] fillTokenDetails;
    }

    // --- Events ---

    event IncentivizationParametersUpdated();
    event IntentCancelled(bytes32 indexed intentHash);
    event IntentPrevalidated(bytes32 indexed intentHash);
    event IntentSolved(
        bytes32 indexed intentHash,
        bool isBuy,
        address buyToken,
        address sellToken,
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
    error InvalidCriteriaProof();
    error InvalidFillAmount();
    error InvalidPriorityFee();
    error InvalidSolution();
    error InvalidStartAndEndTimes();
    error InvalidTip();
    error InvalidTokenId();
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

    // Relevant for incentivized intents
    uint16 public defaultSlippage;
    uint16 public multiplier;
    uint64 public requiredPriorityFee;
    uint64 public minTip;
    uint64 public maxTip;

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
                "bool isIncentivized,",
                "bool isCriteriaOrder,",
                "uint256 tokenIdOrCriteria,",
                "uint128 amount,",
                "uint128 endAmount,",
                "uint16 startAmountBps,",
                "uint16 expectedAmountBps",
                ")"
            )
        );

        defaultSlippage = 50;
        multiplier = 4;
        requiredPriorityFee = 1 gwei;
        minTip = 0.05 gwei * 500000;
        maxTip = 1.5 gwei * 500000;
    }

    // Fallback

    receive() external payable {}

    // Owner methods

    function updateIncentivizationParameters(
        uint16 newDefaultSlippage,
        uint16 newMultiplier,
        uint64 newRequiredPriorityFee,
        uint64 newMinTip,
        uint64 newMaxTip
    ) external onlyOwner {
        defaultSlippage = newDefaultSlippage;
        multiplier = newMultiplier;
        requiredPriorityFee = newRequiredPriorityFee;
        minTip = newMinTip;
        maxTip = newMaxTip;

        emit IncentivizationParametersUpdated();
    }

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
        _checkAuthorization(auth, uint128(solution.fillTokenDetails.length));

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
     * @param authSignature Authorization signature
     * @param permits Permits to execute prior to the solution
     */
    function solveWithSignatureAuthorizationCheck(
        Intent memory intent,
        Solution calldata solution,
        Authorization calldata auth,
        bytes calldata authSignature,
        PermitExecutor.Permit[] calldata permits
    ) external payable nonReentrant executePermits(permits) {
        // Make any private data available
        _includePrivateData(intent);

        // Check authorization
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
            authSignature.length,
            authSignature
        );
        _checkAuthorization(auth, uint128(solution.fillTokenDetails.length));

        // Solve
        _solve(intent, solution, auth.executeAmountToCheck);
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
                    intent.isIncentivized,
                    intent.isCriteriaOrder,
                    intent.tokenIdOrCriteria,
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
        Intent memory intent,
        TokenDetails[] memory tokenDetailsToFill
    ) internal returns (TokenDetails[] memory actualTokenDetailsToFill) {
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

        uint128 amountToFill = uint128(tokenDetailsToFill.length);

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

        actualTokenDetailsToFill = new TokenDetails[](actualAmountToFill);
        unchecked {
            for (uint256 i; i < actualAmountToFill; i++) {
                actualTokenDetailsToFill[i] = tokenDetailsToFill[i];
            }
        }

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

            // Ensure the maker doesn't own any of the tokens that are being filled with
            unchecked {
                for (uint256 i; i < actualAmountToFill; i++) {
                    TokenDetails memory details = tokenDetailsToFill[i];
                    try
                        IERC721(intent.buyToken).ownerOf(details.tokenId)
                    returns (address owner) {
                        if (owner == intent.maker) {
                            revert InvalidSolution();
                        }
                    } catch {
                        // Skip errors (to support not-yet-minted tokens)
                    }
                }
            }
        } else {
            // When isBuy = false:
            // amount = sell amount
            // endAmount = buy end amount
            // startAmountBps = buy start amount bps
            // expectedAmountBps = buy expected amount bps

            unchecked {
                for (uint256 i; i < actualAmountToFill; i++) {
                    TokenDetails memory details = tokenDetailsToFill[i];

                    if (intent.isCriteriaOrder) {
                        if (intent.tokenIdOrCriteria != 0) {
                            _verifyCriteriaProof(
                                details.tokenId,
                                intent.tokenIdOrCriteria,
                                details.criteriaProof
                            );
                        }
                    } else {
                        if (intent.tokenIdOrCriteria != details.tokenId) {
                            revert InvalidTokenId();
                        }
                    }

                    // Transfer inputs to solver
                    _transferERC721(
                        intent.maker,
                        msg.sender,
                        intent.sellToken,
                        details.tokenId
                    );
                }
            }
        }
    }

    function _postProcess(
        Intent memory intent,
        TokenDetails[] memory tokenDetailsToFill,
        uint128 amountToCheck,
        uint128 makerBuyBalanceDiff,
        uint128 makerSellBalanceDiff,
        uint128 sourceBalanceDiff
    ) internal returns (uint256 requiredTip) {
        bytes32 intentHash = getIntentHash(intent);

        uint128 amountToFill = uint128(tokenDetailsToFill.length);
        if (intent.isBuy) {
            // When isBuy = true:
            // amount = buy amount
            // endAmount = sell end amount
            // startAmountBps = sell start amount bps
            // expectedAmountBps = sell expected amount bps

            uint128 endAmount = (intent.endAmount * amountToFill) /
                intent.amount;
            uint128 startAmount = endAmount -
                (endAmount * intent.startAmountBps) /
                10000;
            uint128 expectedAmount = endAmount -
                (endAmount * intent.expectedAmountBps) /
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

            // Ensure the maker owns all tokens that are being filled with
            uint256[] memory filledTokenIds = new uint256[](amountToFill);
            unchecked {
                for (uint256 i; i < amountToFill; i++) {
                    TokenDetails memory details = tokenDetailsToFill[i];

                    if (intent.isCriteriaOrder) {
                        if (intent.tokenIdOrCriteria != 0) {
                            _verifyCriteriaProof(
                                details.tokenId,
                                intent.tokenIdOrCriteria,
                                details.criteriaProof
                            );
                        }
                    } else {
                        if (intent.tokenIdOrCriteria != details.tokenId) {
                            revert InvalidTokenId();
                        }
                    }

                    if (
                        IERC721(intent.buyToken).ownerOf(details.tokenId) !=
                        intent.maker
                    ) {
                        revert InvalidSolution();
                    }

                    filledTokenIds[i] = details.tokenId;
                }
            }

            if (intent.isIncentivized) {
                uint256 priorityFee = tx.gasprice - block.basefee;
                if (priorityFee != requiredPriorityFee) {
                    revert InvalidPriorityFee();
                }

                uint16 slippage = intent.expectedAmountBps;
                if (slippage == 0) {
                    slippage = defaultSlippage;
                }

                uint128 slippageUnit = (slippage * expectedAmount) / 10000;
                uint128 minValue = expectedAmount - slippageUnit * multiplier;
                uint128 maxValue = expectedAmount + slippageUnit;

                if (executeAmount >= maxValue) {
                    requiredTip = minTip;
                } else if (executeAmount <= minValue) {
                    requiredTip = maxTip;
                } else {
                    requiredTip =
                        maxTip -
                        ((executeAmount - minValue) * (maxTip - minTip)) /
                        (maxValue - minValue);
                }

                uint256 balance = address(this).balance;
                if (balance < requiredTip) {
                    revert InvalidTip();
                } else {
                    block.coinbase.transfer(requiredTip);
                }

                uint256 leftover = address(this).balance;
                if (leftover > 0) {
                    ISolutionERC721(msg.sender).refund{
                        value: address(this).balance
                    }();
                }
            }

            emit IntentSolved(
                intentHash,
                intent.isBuy,
                intent.buyToken,
                intent.sellToken,
                intent.maker,
                msg.sender,
                executeAmount,
                filledTokenIds
            );
        } else {
            // When isBuy = false:
            // amount = sell amount
            // endAmount = buy end amount
            // startAmountBps = buy start amount bps
            // expectedAmountBps = buy expected amount bps

            uint128 endAmount = (intent.endAmount * amountToFill) /
                intent.amount;
            uint128 startAmount = endAmount +
                (endAmount * intent.startAmountBps) /
                10000;
            uint128 expectedAmount = endAmount +
                (endAmount * intent.expectedAmountBps) /
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

            uint256[] memory filledTokenIds = new uint256[](amountToFill);
            unchecked {
                for (uint256 i; i < amountToFill; i++) {
                    TokenDetails memory details = tokenDetailsToFill[i];
                    filledTokenIds[i] = details.tokenId;
                }
            }

            if (intent.isIncentivized) {
                uint256 priorityFee = tx.gasprice - block.basefee;
                if (priorityFee != requiredPriorityFee) {
                    revert InvalidPriorityFee();
                }

                uint16 slippage = intent.expectedAmountBps;
                if (slippage == 0) {
                    slippage = defaultSlippage;
                }

                uint128 slippageUnit = (slippage * expectedAmount) / 10000;
                uint128 minValue = expectedAmount - slippageUnit;
                uint128 maxValue = expectedAmount + slippageUnit * multiplier;

                if (executeAmount >= maxValue) {
                    requiredTip = minTip;
                } else if (executeAmount <= minValue) {
                    requiredTip = maxTip;
                } else {
                    requiredTip =
                        minTip +
                        ((executeAmount - minValue) * (maxTip - minTip)) /
                        (maxValue - minValue);
                }

                uint256 balance = address(this).balance;
                if (balance < requiredTip) {
                    revert InvalidTip();
                } else {
                    block.coinbase.transfer(requiredTip);
                }

                uint256 leftover = address(this).balance;
                if (leftover > 0) {
                    ISolutionERC721(msg.sender).refund{
                        value: address(this).balance
                    }();
                }
            }

            emit IntentSolved(
                intentHash,
                intent.isBuy,
                intent.buyToken,
                intent.sellToken,
                intent.maker,
                msg.sender,
                executeAmount,
                filledTokenIds
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
        uint256 coinbaseBalanceBefore = block.coinbase.balance;

        // Determine the token for which the amount is variable
        // - isBuy = true -> sellToken (exact output, variable input)
        // - isBuy = false -> buyToken (exact input, variable output)
        address relevantToken = intent.isBuy
            ? intent.sellToken
            : intent.buyToken;

        // Fetch the balances before the solution execution
        uint128 makerBuyBalanceBefore = _getBalanceNativeOrERC20OrERC721(
            intent.buyToken,
            intent.maker
        );
        uint128 makerSellBalanceBefore = _getBalanceNativeOrERC20OrERC721(
            intent.sellToken,
            intent.maker
        );
        uint128 sourceBalanceBefore = _getBalanceNativeOrERC20OrERC721(
            relevantToken,
            intent.source
        );

        // Pre-process
        TokenDetails[] memory actualTokenDetailsToFill = _preProcess(
            intent,
            solution.fillTokenDetails
        );

        // Solve
        ISolutionERC721(msg.sender).callback(
            intent,
            actualTokenDetailsToFill,
            solution.data
        );

        // Fetch the balances after the solution execution
        uint128 makerBuyBalanceAfter = _getBalanceNativeOrERC20OrERC721(
            intent.buyToken,
            intent.maker
        );
        uint128 makerSellBalanceAfter = _getBalanceNativeOrERC20OrERC721(
            intent.sellToken,
            intent.maker
        );
        uint128 sourceBalanceAfter = _getBalanceNativeOrERC20OrERC721(
            relevantToken,
            intent.source
        );

        // Post-process
        uint256 requiredTip = _postProcess(
            intent,
            actualTokenDetailsToFill,
            amountToCheck,
            makerBuyBalanceAfter - makerBuyBalanceBefore,
            makerSellBalanceBefore - makerSellBalanceAfter,
            sourceBalanceAfter - sourceBalanceBefore
        );

        uint256 coinbaseBalanceAfter = block.coinbase.balance;
        if (
            intent.isIncentivized &&
            coinbaseBalanceAfter - coinbaseBalanceBefore != requiredTip
        ) {
            revert InvalidTip();
        }
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
        bytes memory signature
    ) internal {
        _verifySignature(intentHash, maker, signature);

        // Mark the intent as validated if allowed
        if (!hasDynamicSignature) {
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
     * @dev Helper method to get the balance of native or ERC20/ERC721 tokens
     *
     * @param token Token to get the balance for (native tokens are represented by the zero address)
     * @param owner Wallet to get the balance of
     *
     * @return balance The amount of `token` owned by `owner`
     */
    function _getBalanceNativeOrERC20OrERC721(
        address token,
        address owner
    ) internal view returns (uint128 balance) {
        if (token == address(0)) {
            balance = uint128(owner.balance);
        } else {
            // Same interface for ERC20 and ERC721
            balance = uint128(IERC20(token).balanceOf(owner));
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

    /**
     * @dev Verify a merkle proof
     *      Taken from: https://github.com/ProjectOpenSea/seaport/blob/dfce06d02413636f324f73352b54a4497d63c310/contracts/lib/CriteriaResolution.sol#L243-L247
     *
     * @param leaf Leaf to verify
     * @param root Merkle root
     * @param criteriaProof Merkle proof for the inclusion of `leaf` in `root`
     */
    function _verifyCriteriaProof(
        uint256 leaf,
        uint256 root,
        bytes32[] memory criteriaProof
    ) internal pure {
        bool isValid;

        assembly {
            // Store the leaf at the beginning of scratch space
            mstore(0, leaf)

            // Derive the hash of the leaf to use as the initial proof element
            let computedHash := keccak256(0, 0x20)
            // Get memory start location of the first element in proof array
            let data := add(criteriaProof, 0x20)

            for {
                // Left shift by 5 is equivalent to multiplying by 0x20
                let end := add(data, shl(5, mload(criteriaProof)))
            } lt(data, end) {
                // Increment by one word at a time
                data := add(data, 0x20)
            } {
                // Get the proof element
                let loadedData := mload(data)

                // Sort proof elements and place them in scratch space
                let scratch := shl(5, gt(computedHash, loadedData))
                mstore(scratch, computedHash)
                mstore(xor(scratch, 0x20), loadedData)

                // Derive the updated hash
                computedHash := keccak256(0, 0x40)
            }

            isValid := eq(computedHash, root)
        }

        if (!isValid) {
            revert InvalidCriteriaProof();
        }
    }

    // --- Overridden methods ---

    function _lookupBulkOrderTypehash(
        uint256 treeHeight
    ) internal pure override returns (bytes32 typeHash) {
        // keccak256("BatchIntent(Intent[2]...[2] tree)Intent(bool isBuy,address buyToken,address sellToken,address maker,address solver,address source,uint16 feeBps,uint16 surplusBps,uint32 startTime,uint32 endTime,uint256 nonce,bool isPartiallyFillable,bool isSmartOrder,bool isIncentivized,bool isCriteriaOrder,uint256 tokenIdOrCriteria,uint128 amount,uint128 endAmount,uint16 startAmountBps,uint16 expectedAmountBps)")
        if (treeHeight == 1) {
            typeHash = 0xe2f9470ce56204b03b7f6a5da488bc405af34f9420fea7d23b9caa0e9f13b34b;
        } else if (treeHeight == 2) {
            typeHash = 0x38f007c7b676c4e3c06780a2eb36358363d4dbba803a413335dac32c672faf5c;
        } else if (treeHeight == 3) {
            typeHash = 0xaebed864141699427ffecf19db72b18a6519621259be5ad00bc0cd844551e7fb;
        } else if (treeHeight == 4) {
            typeHash = 0xb4f25ef2f5b34b8c0b2db30279b8b106d127c64b562153796fd3b9b826e08094;
        } else if (treeHeight == 5) {
            typeHash = 0xed14a836400793f5936eecd4130e39ee9d8d69c4815012477a72d0d8ccacb560;
        } else if (treeHeight == 6) {
            typeHash = 0xd51da1ce6fb4cad122d966c4939bfbe48df609c2321c0aa5ad45f30d93c5bce4;
        } else if (treeHeight == 7) {
            typeHash = 0x7f233ad630dc1877c45a371e9b3c2e9b0bf2d2a42d50f3ce4f6f548f50a4ce7b;
        } else if (treeHeight == 8) {
            typeHash = 0x075e03a4af0aeb0971b0a23187d89b336494d815e4007aed2a282b2ff023dea8;
        } else {
            revert MerkleTreeTooLarge();
        }
    }
}
