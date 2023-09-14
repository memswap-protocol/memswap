// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MemswapERC20} from "../MemswapERC20.sol";
import {PermitExecutor} from "../../common/PermitExecutor.sol";

import {ISolutionERC20} from "../interfaces/ISolutionERC20.sol";

interface IMintableERC20 is IERC20 {
    function mint(uint256 amount) external;
}

contract MockSolutionProxyERC20 is ISolutionERC20 {
    address public memswap;
    bool public payBuilderOnRefund;

    event Refunded(uint256 amount);

    constructor(address memswapAddress) {
        memswap = memswapAddress;
    }

    function setPayBuilderOnRefund(bool _payBuilderOnRefund) external {
        payBuilderOnRefund = _payBuilderOnRefund;
    }

    receive() external payable {}

    function solve(
        MemswapERC20.Intent calldata intent,
        MemswapERC20.Solution calldata solution,
        PermitExecutor.Permit[] calldata permits
    ) external payable {
        MemswapERC20(payable(memswap)).solve{value: msg.value}(
            intent,
            solution,
            permits
        );
    }

    function solveWithOnChainAuthorizationCheck(
        MemswapERC20.Intent calldata intent,
        MemswapERC20.Solution calldata solution,
        PermitExecutor.Permit[] calldata permits
    ) external payable {
        MemswapERC20(payable(memswap)).solveWithOnChainAuthorizationCheck{
            value: msg.value
        }(intent, solution, permits);
    }

    function solveWithSignatureAuthorizationCheck(
        MemswapERC20.Intent calldata intent,
        MemswapERC20.Solution calldata solution,
        MemswapERC20.Authorization calldata auth,
        bytes calldata authSignature,
        PermitExecutor.Permit[] calldata permits
    ) external payable {
        MemswapERC20(payable(memswap)).solveWithSignatureAuthorizationCheck{
            value: msg.value
        }(intent, solution, auth, authSignature, permits);
    }

    function refund() external payable {
        if (payBuilderOnRefund) {
            block.coinbase.transfer(msg.value);
        }

        emit Refunded(msg.value);
    }

    function callback(
        MemswapERC20.Intent memory intent,
        uint128 amountToFill,
        bytes memory data
    ) external {
        if (intent.isBuy) {
            // Amount to refund to the maker
            uint128 surplusAmount = abi.decode(data, (uint128));

            uint128 endAmount = (intent.endAmount * amountToFill) /
                intent.amount;
            uint128 startAmount = endAmount -
                (endAmount * intent.startAmountBps) /
                10000;
            uint128 expectedAmount = endAmount -
                (endAmount * intent.expectedAmountBps) /
                10000;

            // Total amount pulled from the maker
            uint128 maxAmount = startAmount +
                ((endAmount - startAmount) *
                    (uint32(block.timestamp) - intent.startTime)) /
                (intent.endTime - intent.startTime);

            // Net amount pulled from the maker (total amount - surplus amount)
            uint128 makerBalanceDiff = maxAmount - surplusAmount;

            // Charge fees
            if (intent.source != address(0)) {
                uint128 feeAmount;

                // Fee
                if (intent.feeBps > 0) {
                    feeAmount += (makerBalanceDiff * intent.feeBps) / 10000;
                }

                // Surplus fee
                if (
                    intent.surplusBps > 0 && makerBalanceDiff < expectedAmount
                ) {
                    feeAmount +=
                        ((expectedAmount - makerBalanceDiff) *
                            intent.surplusBps) /
                        10000;
                }

                if (feeAmount > 0) {
                    IERC20(intent.sellToken).transfer(intent.source, feeAmount);
                }
            }

            // Refund surplus to the maker
            IERC20(intent.sellToken).transfer(intent.maker, surplusAmount);

            // Send payment to the maker
            if (intent.buyToken == address(0)) {
                (bool success, ) = intent.maker.call{value: amountToFill}("");
                if (!success) {
                    revert();
                }
            } else {
                IMintableERC20(intent.buyToken).mint(amountToFill);
                IMintableERC20(intent.buyToken).transfer(
                    intent.maker,
                    amountToFill
                );
            }
        } else {
            // Amount to send on top to the maker
            uint128 surplusAmount = abi.decode(data, (uint128));

            uint128 endAmount = (intent.endAmount * amountToFill) /
                intent.amount;
            uint128 startAmount = endAmount +
                (endAmount * intent.startAmountBps) /
                10000;
            uint128 expectedAmount = endAmount +
                (endAmount * intent.expectedAmountBps) /
                10000;

            // Total amount pushed to the maker
            uint128 minAmount = startAmount -
                ((startAmount - endAmount) *
                    (uint32(block.timestamp) - intent.startTime)) /
                (intent.endTime - intent.startTime);

            // Net amount pushed to the maker (total amount + surplus amount)
            uint128 makerBalanceDiff = minAmount + surplusAmount;

            if (intent.buyToken != address(0)) {
                IMintableERC20(intent.buyToken).mint(makerBalanceDiff);
            }

            // Charge fees
            if (intent.source != address(0)) {
                uint128 feeAmount;

                // Fee
                if (intent.feeBps > 0) {
                    feeAmount += (makerBalanceDiff * intent.feeBps) / 10000;
                }

                // Surplus fee
                if (
                    intent.surplusBps > 0 && makerBalanceDiff > expectedAmount
                ) {
                    feeAmount +=
                        ((makerBalanceDiff - expectedAmount) *
                            intent.surplusBps) /
                        10000;
                }

                if (feeAmount > 0) {
                    if (intent.buyToken == address(0)) {
                        (bool success, ) = intent.source.call{value: feeAmount}(
                            ""
                        );
                        if (!success) {
                            revert();
                        }
                    } else {
                        IERC20(intent.buyToken).transfer(
                            intent.source,
                            feeAmount
                        );
                    }

                    makerBalanceDiff -= feeAmount;
                }
            }

            // Send payment to the maker
            if (intent.buyToken == address(0)) {
                (bool success, ) = intent.maker.call{value: makerBalanceDiff}(
                    ""
                );
                if (!success) {
                    revert();
                }
            } else {
                IMintableERC20(intent.buyToken).transfer(
                    intent.maker,
                    makerBalanceDiff
                );
            }
        }
    }
}
