// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, euint64, euint8, ebool, externalEuint64, externalEuint8, externalEbool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

contract ConfidentialAIContext is ZamaEthereumConfig {
    struct EncryptedContext {
        euint64 sessionKey;
        euint8 trustLevel;
        euint8 sentimentScore;
        euint8 memoryTier;
        ebool isActive;
    }

    mapping(address => EncryptedContext) private userContexts;

    event ContextWritten(address indexed user);
    event AgentAccessGranted(address indexed user, address indexed agent);
    event DecryptionRequested(address indexed user, bytes32 trustLevel, bytes32 sentimentScore, bytes32 memoryTier);

    function writeContext(
        externalEuint64 sessionKey,
        externalEuint8 trustLevel,
        externalEuint8 sentiment,
        bytes calldata inputProof
    ) external {
        EncryptedContext storage ctx = userContexts[msg.sender];

        ctx.sessionKey = FHE.fromExternal(sessionKey, inputProof);
        ctx.trustLevel = FHE.fromExternal(trustLevel, inputProof);
        ctx.sentimentScore = FHE.fromExternal(sentiment, inputProof);
        ctx.memoryTier = FHE.asEuint8(0);
        ctx.isActive = FHE.asEbool(true);

        FHE.allowThis(ctx.sessionKey);
        FHE.allowThis(ctx.trustLevel);
        FHE.allowThis(ctx.sentimentScore);
        FHE.allowThis(ctx.memoryTier);
        FHE.allowThis(ctx.isActive);

        FHE.allow(ctx.sessionKey, msg.sender);
        FHE.allow(ctx.trustLevel, msg.sender);
        FHE.allow(ctx.sentimentScore, msg.sender);
        FHE.allow(ctx.memoryTier, msg.sender);
        FHE.allow(ctx.isActive, msg.sender);

        emit ContextWritten(msg.sender);
    }

    function getContextHandles(address user)
        external
        view
        returns (euint64, euint8, euint8, euint8, ebool)
    {
        EncryptedContext storage ctx = userContexts[user];
        return (ctx.sessionKey, ctx.trustLevel, ctx.sentimentScore, ctx.memoryTier, ctx.isActive);
    }

    function grantAgentAccess(address agent) external {
        EncryptedContext storage ctx = userContexts[msg.sender];
        FHE.allow(ctx.sessionKey, agent);
        FHE.allow(ctx.trustLevel, agent);
        FHE.allow(ctx.sentimentScore, agent);
        FHE.allow(ctx.memoryTier, agent);
        FHE.allow(ctx.isActive, agent);

        emit AgentAccessGranted(msg.sender, agent);
    }

    function conditionalUpgrade() external {
        EncryptedContext storage ctx = userContexts[msg.sender];
        ebool condition = FHE.gt(ctx.trustLevel, FHE.asEuint8(2));
        ctx.memoryTier = FHE.select(condition, FHE.asEuint8(1), ctx.memoryTier);
        FHE.allowThis(ctx.memoryTier);
        FHE.allow(ctx.memoryTier, msg.sender);
    }

    function requestPublicDecrypt() external {
        EncryptedContext storage ctx = userContexts[msg.sender];
        FHE.makePubliclyDecryptable(ctx.trustLevel);
        FHE.makePubliclyDecryptable(ctx.sentimentScore);
        FHE.makePubliclyDecryptable(ctx.memoryTier);

        emit DecryptionRequested(
            msg.sender,
            bytes32(euint8.unwrap(ctx.trustLevel)),
            bytes32(euint8.unwrap(ctx.sentimentScore)),
            bytes32(euint8.unwrap(ctx.memoryTier))
        );
    }
}
