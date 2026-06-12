// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

contract EncryptedPricer {
    /// @notice Verify encrypted payment >= encrypted price
    function verifyPayment(euint64 encPayment, euint64 encPrice) external returns (ebool) {
        return FHE.gte(encPayment, encPrice);
    }

    /// @notice Compute platform fee on encrypted amount. feePercentBps is public (e.g. 300 = 3%)
    function computeFee(euint64 encAmount, uint16 feePercentBps) external returns (euint64 encFee, euint64 encNet) {
        euint64 feeMul = FHE.asEuint64(uint64(feePercentBps));
        euint64 base   = FHE.asEuint64(10000);
        encFee = FHE.div(FHE.mul(encAmount, feeMul), base);
        encNet = FHE.sub(encAmount, encFee);
    }

    /// @notice Dynamic pricing: 1.2x if activeUsers > threshold
    function getDynamicPrice(euint64 encBase, euint32 encUsers, euint32 encThreshold) external returns (euint64) {
        ebool   highDemand = FHE.gt(encUsers, encThreshold);
        euint64 surge      = FHE.div(FHE.mul(encBase, FHE.asEuint64(12)), FHE.asEuint64(10));
        return FHE.select(highDemand, surge, encBase);
    }
}
