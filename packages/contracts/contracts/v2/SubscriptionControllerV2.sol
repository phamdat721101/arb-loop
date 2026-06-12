// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title SubscriptionControllerV2 — encrypted subscription with user self-service
contract SubscriptionControllerV2 {
    struct EncSub {
        euint8 tier;
        euint64 expiry;
        ebool active;
    }

    mapping(address => EncSub) private subs;

    event Subscribed(address indexed user, uint8 tier);

    function subscribe(uint8 tier, uint64 expiry) external {
        EncSub storage s = subs[msg.sender];
        s.tier = FHE.asEuint8(tier);
        s.expiry = FHE.asEuint64(expiry);
        s.active = FHE.asEbool(true);

        FHE.allowSender(s.tier);
        FHE.allowSender(s.expiry);
        FHE.allowSender(s.active);

        emit Subscribed(msg.sender, tier);
    }

    function checkActive(address user) external view returns (ebool) {
        return subs[user].active;
    }

    function getTier(address user) external view returns (euint8) {
        return subs[user].tier;
    }

    function getExpiry(address user) external view returns (euint64) {
        return subs[user].expiry;
    }
}
