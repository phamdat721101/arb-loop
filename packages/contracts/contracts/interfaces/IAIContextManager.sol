// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

interface IAIContextManager {
    struct ContextHandles {
        bytes32 sessionKey;
        bytes32 userId;
        bytes32 contextVersion;
        bytes32 sentimentScore;
        bytes32 trustLevel;
        bytes32 memoryTier;
        bytes32 isActive;
        bytes32 isVerified;
        bytes32 authorizedAgent;
    }

    function writeContext(
        InEuint128 memory inSessionKey,
        InEuint64  memory inUserId,
        InEuint8   memory inSentimentScore,
        InEuint8   memory inTrustLevel,
        InEbool    memory inIsVerified,
        InEaddress memory inAuthorizedAgent
    ) external;

    function getContextHandles(address user) external view returns (ContextHandles memory);

    function conditionalUpgrade(address user) external;
}
