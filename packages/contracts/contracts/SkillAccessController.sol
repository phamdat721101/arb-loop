// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

contract SkillAccessController {
    struct AgentPermit {
        eaddress authorizedAgent;
        ebool    canExecute;
        euint32  remainingUses;
        uint256  grantedAt;
    }

    mapping(bytes32 => AgentPermit) private agentPermits;

    event PermissionGranted(bytes32 indexed licenseId, uint256 grantedAt);

    function grantAgentPermission(
        bytes32 licenseId,
        bytes calldata inAgentAddress,
        bytes calldata inMaxUses
    ) external {
        AgentPermit storage p = agentPermits[licenseId];
        p.authorizedAgent = FHE.asEaddress(inAgentAddress); FHE.allow(p.authorizedAgent, msg.sender);
        p.canExecute      = FHE.asEbool(true);              FHE.allow(p.canExecute,      msg.sender);
        p.remainingUses   = FHE.asEuint32(inMaxUses);       FHE.allow(p.remainingUses,   msg.sender);
        p.grantedAt       = block.timestamp;

        emit PermissionGranted(licenseId, block.timestamp);
    }

    function verifyAndConsumePermission(
        bytes32 licenseId,
        bytes calldata inCallingAgent
    ) external returns (ebool) {
        AgentPermit storage p = agentPermits[licenseId];

        eaddress caller    = FHE.asEaddress(inCallingAgent);
        ebool isAuthorized = FHE.eq(p.authorizedAgent, caller);
        ebool hasUses      = FHE.gt(p.remainingUses, FHE.asEuint32(0));
        ebool canProceed   = FHE.and(isAuthorized, hasUses);

        // Decrement only if authorized: subtract 1 if canProceed, else 0
        euint32 one  = FHE.asEuint32(1);
        euint32 zero = FHE.asEuint32(0);
        euint32 dec  = FHE.select(canProceed, one, zero);
        p.remainingUses = FHE.sub(p.remainingUses, dec);

        return canProceed;
    }
}
