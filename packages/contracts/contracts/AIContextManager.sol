// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "./interfaces/IAIContextManager.sol";

contract AIContextManager is IAIContextManager {
    struct EncryptedContext {
        euint128 sessionKey;
        euint64  userId;
        euint32  contextVersion;
        euint8   sentimentScore;
        euint8   trustLevel;
        euint8   memoryTier;
        ebool    isActive;
        ebool    isVerified;
        eaddress authorizedAgent;
    }

    mapping(address => EncryptedContext) private userContexts;

    event ContextWritten(address indexed user);
    event MemoryTierUpgraded(address indexed user);

    function writeContext(
        InEuint128 memory inSessionKey,
        InEuint64  memory inUserId,
        InEuint8   memory inSentimentScore,
        InEuint8   memory inTrustLevel,
        InEbool    memory inIsVerified,
        InEaddress memory inAuthorizedAgent
    ) external override {
        EncryptedContext storage ctx = userContexts[msg.sender];

        ctx.sessionKey       = FHE.asEuint128(inSessionKey);      FHE.allowThis(ctx.sessionKey);      FHE.allow(ctx.sessionKey,      msg.sender);
        ctx.userId           = FHE.asEuint64(inUserId);           FHE.allowThis(ctx.userId);           FHE.allow(ctx.userId,           msg.sender);
        ctx.sentimentScore   = FHE.asEuint8(inSentimentScore);    FHE.allowThis(ctx.sentimentScore);   FHE.allow(ctx.sentimentScore,   msg.sender);
        ctx.trustLevel       = FHE.asEuint8(inTrustLevel);        FHE.allowThis(ctx.trustLevel);       FHE.allow(ctx.trustLevel,       msg.sender);
        ctx.isVerified       = FHE.asEbool(inIsVerified);         FHE.allowThis(ctx.isVerified);       FHE.allow(ctx.isVerified,       msg.sender);
        ctx.authorizedAgent  = FHE.asEaddress(inAuthorizedAgent); FHE.allowThis(ctx.authorizedAgent);  FHE.allow(ctx.authorizedAgent,  msg.sender);
        ctx.isActive         = FHE.asEbool(true);                 FHE.allowThis(ctx.isActive);         FHE.allow(ctx.isActive,         msg.sender);
        ctx.contextVersion   = FHE.add(ctx.contextVersion, FHE.asEuint32(1)); FHE.allowThis(ctx.contextVersion);

        emit ContextWritten(msg.sender);
    }

    function getContextHandles(address user) external view override returns (ContextHandles memory handles) {
        EncryptedContext storage ctx = userContexts[user];
        handles.sessionKey      = euint128.unwrap(ctx.sessionKey);
        handles.userId          = euint64.unwrap(ctx.userId);
        handles.contextVersion  = euint32.unwrap(ctx.contextVersion);
        handles.sentimentScore  = euint8.unwrap(ctx.sentimentScore);
        handles.trustLevel      = euint8.unwrap(ctx.trustLevel);
        handles.memoryTier      = euint8.unwrap(ctx.memoryTier);
        handles.isActive        = ebool.unwrap(ctx.isActive);
        handles.isVerified      = ebool.unwrap(ctx.isVerified);
        handles.authorizedAgent = eaddress.unwrap(ctx.authorizedAgent);
    }

    // Upgrades memoryTier from short(0) to medium(1) if trustLevel > 1, using FHE.select — no branch leak
    function conditionalUpgrade(address user) external override {
        EncryptedContext storage ctx = userContexts[user];
        ebool shouldUpgrade = FHE.gt(ctx.trustLevel, FHE.asEuint8(1));
        euint8 upgraded = FHE.select(shouldUpgrade, FHE.asEuint8(1), ctx.memoryTier);
        ctx.memoryTier = upgraded;
        FHE.allow(ctx.memoryTier, user);
        emit MemoryTierUpgraded(user);
    }
}
