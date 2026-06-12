// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "./interfaces/ISkillRegistry.sol";
import "./interfaces/IEncryptedPaymentToken.sol";

contract AgentSkillVault {
    struct SkillLicense {
        eaddress agentOwner;
        euint64  purchasePrice;
        ebool    isValid;
        uint256  purchasedAt;
        uint256  expiresAt;
    }

    struct LicenseHandles {
        bytes32 agentOwner;
        bytes32 purchasePrice;
        bytes32 isValid;
        uint256 purchasedAt;
        uint256 expiresAt;
    }

    ISkillRegistry public registry;
    uint16 public feeBps = 300; // 3%
    address public owner;
    IEncryptedPaymentToken public paymentToken;

    mapping(bytes32 => SkillLicense) private licenses;
    mapping(uint256 => uint256) public licenseSaleCount;

    event LicenseIssued(bytes32 indexed licenseId, uint256 indexed skillIndex, uint256 issuedAt);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address _registry) {
        registry = ISkillRegistry(_registry);
        owner = msg.sender;
    }

    function setPaymentToken(address _token) external onlyOwner {
        paymentToken = IEncryptedPaymentToken(_token);
    }

    function purchaseSkill(
        uint256 publicSkillIndex,
        bytes calldata inPaymentAmount,
        bytes calldata inAgentOwner,
        uint256 licenseDurationSeconds
    ) external returns (bytes32 licenseId) {
        euint64 encPayment = FHE.asEuint64(inPaymentAmount);

        // Verify payment >= price using encrypted comparison
        bytes32 priceHandle = registry.getEncryptedPrice(publicSkillIndex);
        euint64 encPrice = euint64.wrap(priceHandle);
        ebool sufficient = FHE.gte(encPayment, encPrice);
        // Branchless guard: zero payment if insufficient (select pattern)
        euint64 validPayment = FHE.select(sufficient, encPayment, FHE.asEuint64(0));

        // Transfer tokens from buyer to vault (buyer must approve vault first)
        if (address(paymentToken) != address(0)) {
            paymentToken.encryptedTransferFrom(msg.sender, address(this), inPaymentAmount);
        }

        // Generate license ID
        licenseId = keccak256(abi.encodePacked(publicSkillIndex, msg.sender, block.timestamp));

        // Store encrypted license
        SkillLicense storage lic = licenses[licenseId];
        lic.agentOwner    = FHE.asEaddress(inAgentOwner);   FHE.allow(lic.agentOwner,    msg.sender);
        lic.purchasePrice = validPayment;                     FHE.allow(lic.purchasePrice, msg.sender);
        lic.isValid       = FHE.asEbool(true);               FHE.allow(lic.isValid,       msg.sender);
        lic.purchasedAt   = block.timestamp;
        lic.expiresAt     = licenseDurationSeconds > 0
            ? block.timestamp + licenseDurationSeconds
            : 0;

        licenseSaleCount[publicSkillIndex]++;
        registry.incrementActiveUsers(publicSkillIndex);

        emit LicenseIssued(licenseId, publicSkillIndex, block.timestamp);
    }

    function getLicenseHandles(bytes32 licenseId) external view returns (LicenseHandles memory h) {
        SkillLicense storage lic = licenses[licenseId];
        h.agentOwner    = eaddress.unwrap(lic.agentOwner);
        h.purchasePrice = euint64.unwrap(lic.purchasePrice);
        h.isValid       = ebool.unwrap(lic.isValid);
        h.purchasedAt   = lic.purchasedAt;
        h.expiresAt     = lic.expiresAt;
    }

    /// @notice Owner withdraws collected fees
    function withdrawFees(address to, bytes calldata inAmount) external onlyOwner {
        require(address(paymentToken) != address(0), "no token set");
        paymentToken.encryptedTransferFrom(address(this), to, inAmount);
    }
}
