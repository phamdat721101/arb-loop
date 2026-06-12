// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

contract SubscriptionController {
    struct EncSub {
        euint8  tier;
        euint64 expiry;
        ebool   active;
    }

    address public owner;
    mapping(address => EncSub) private subs;

    event Subscribed(address indexed user, uint8 tier);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function subscribe(address user, uint8 tier, uint64 expiry) external onlyOwner {
        EncSub storage s = subs[user];
        s.tier   = FHE.asEuint8(tier);
        s.expiry = FHE.asEuint64(expiry);
        s.active = FHE.asEbool(true);

        FHE.allow(s.tier, user);
        FHE.allow(s.expiry, user);
        FHE.allow(s.active, user);

        emit Subscribed(user, tier);
    }

    function checkAccess(address user) external view returns (ebool) {
        return subs[user].active;
    }

    function getTier(address user) external view returns (euint8) {
        return subs[user].tier;
    }
}
