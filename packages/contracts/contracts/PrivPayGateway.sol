// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "./interfaces/IEncryptedPaymentToken.sol";

contract PrivPayGateway {
    IEncryptedPaymentToken public paymentToken;
    uint256 public invoiceCount;
    uint256 public escrowCount;
    uint256 public subscriptionCount;

    // --- Encrypted Structs ---

    struct EncryptedInvoice {
        euint64  amount;
        eaddress recipient;
        ebool    isPaid;
        uint256  expiry;
        address  creator;
    }

    struct EncryptedEscrow {
        bytes32 invoiceId;
        ebool   released;
        ebool   refunded;
        address payer;
    }

    struct EncryptedSubscription {
        euint64  amount;
        eaddress recipient;
        uint256  interval;
        uint256  lastCharged;
        ebool    active;
        address  subscriber;
    }

    // --- Handle Structs (for external view) ---

    struct InvoiceHandles {
        bytes32 amount;
        bytes32 recipient;
        bytes32 isPaid;
        uint256 expiry;
        address creator;
    }

    struct EscrowHandles {
        bytes32 invoiceId;
        bytes32 released;
        bytes32 refunded;
        address payer;
    }

    struct SubscriptionHandles {
        bytes32 amount;
        bytes32 recipient;
        uint256 interval;
        uint256 lastCharged;
        bytes32 active;
        address subscriber;
    }

    mapping(bytes32 => EncryptedInvoice) private invoices;
    mapping(bytes32 => EncryptedEscrow) private escrows;
    mapping(bytes32 => EncryptedSubscription) private subscriptions;

    // Events emit only IDs + timestamps, never amounts or addresses
    event InvoiceCreated(bytes32 indexed invoiceId, uint256 timestamp);
    event InvoicePaid(bytes32 indexed invoiceId, uint256 timestamp);
    event EscrowCreated(bytes32 indexed escrowId, uint256 timestamp);
    event EscrowReleased(bytes32 indexed escrowId, uint256 timestamp);
    event EscrowRefunded(bytes32 indexed escrowId, uint256 timestamp);
    event SubscriptionCreated(bytes32 indexed subId, uint256 timestamp);
    event SubscriptionCharged(bytes32 indexed subId, uint256 timestamp);
    event SubscriptionCancelled(bytes32 indexed subId, uint256 timestamp);

    constructor(address _paymentToken) {
        paymentToken = IEncryptedPaymentToken(_paymentToken);
    }

    // ==================== INVOICES ====================

    function createInvoice(
        bytes calldata inAmount,
        bytes calldata inRecipient,
        uint256 expiry
    ) external returns (bytes32 invoiceId) {
        invoiceId = keccak256(abi.encodePacked(++invoiceCount, msg.sender, block.timestamp));
        EncryptedInvoice storage inv = invoices[invoiceId];
        inv.amount    = FHE.asEuint64(inAmount);     FHE.allow(inv.amount,    msg.sender);
        inv.recipient = FHE.asEaddress(inRecipient);  FHE.allow(inv.recipient, msg.sender);
        inv.isPaid    = FHE.asEbool(false);
        inv.expiry    = expiry;
        inv.creator   = msg.sender;
        emit InvoiceCreated(invoiceId, block.timestamp);
    }

    function payInvoice(bytes32 invoiceId, bytes calldata inPayment) external {
        EncryptedInvoice storage inv = invoices[invoiceId];
        require(inv.creator != address(0), "invoice not found");
        require(inv.expiry == 0 || block.timestamp <= inv.expiry, "expired");

        // Transfer tokens from payer to invoice creator
        // Payer must have approved this gateway contract first
        paymentToken.encryptedTransferFrom(msg.sender, inv.creator, inPayment);

        inv.isPaid = FHE.asEbool(true);
        FHE.allow(inv.isPaid, msg.sender);
        FHE.allow(inv.isPaid, inv.creator);
        emit InvoicePaid(invoiceId, block.timestamp);
    }

    function getInvoiceHandles(bytes32 id) external view returns (InvoiceHandles memory h) {
        EncryptedInvoice storage inv = invoices[id];
        h.amount    = euint64.unwrap(inv.amount);
        h.recipient = eaddress.unwrap(inv.recipient);
        h.isPaid    = ebool.unwrap(inv.isPaid);
        h.expiry    = inv.expiry;
        h.creator   = inv.creator;
    }

    // ==================== ESCROW ====================

    function createEscrow(
        bytes32 invoiceId,
        bytes calldata inPayment
    ) external returns (bytes32 escrowId) {
        require(invoices[invoiceId].creator != address(0), "invoice not found");
        escrowId = keccak256(abi.encodePacked(++escrowCount, invoiceId, msg.sender));

        // Hold tokens in this contract
        paymentToken.encryptedTransferFrom(msg.sender, address(this), inPayment);

        EncryptedEscrow storage esc = escrows[escrowId];
        esc.invoiceId = invoiceId;
        esc.payer     = msg.sender;
        esc.released  = FHE.asEbool(false);
        esc.refunded  = FHE.asEbool(false);
        emit EscrowCreated(escrowId, block.timestamp);
    }

    function releaseEscrow(bytes32 escrowId) external {
        EncryptedEscrow storage esc = escrows[escrowId];
        address recipient = invoices[esc.invoiceId].creator;
        require(msg.sender == recipient, "not recipient");

        esc.released = FHE.asEbool(true);
        FHE.allow(esc.released, msg.sender);
        FHE.allow(esc.released, esc.payer);
        emit EscrowReleased(escrowId, block.timestamp);
    }

    function refundEscrow(bytes32 escrowId) external {
        EncryptedEscrow storage esc = escrows[escrowId];
        require(msg.sender == esc.payer, "not payer");

        esc.refunded = FHE.asEbool(true);
        FHE.allow(esc.refunded, msg.sender);
        emit EscrowRefunded(escrowId, block.timestamp);
    }

    function getEscrowHandles(bytes32 id) external view returns (EscrowHandles memory h) {
        EncryptedEscrow storage esc = escrows[id];
        h.invoiceId = esc.invoiceId;
        h.released  = ebool.unwrap(esc.released);
        h.refunded  = ebool.unwrap(esc.refunded);
        h.payer     = esc.payer;
    }

    // ==================== SUBSCRIPTIONS ====================

    function createSubscription(
        bytes calldata inAmount,
        bytes calldata inRecipient,
        uint256 intervalSec
    ) external returns (bytes32 subId) {
        subId = keccak256(abi.encodePacked(++subscriptionCount, msg.sender, block.timestamp));
        EncryptedSubscription storage sub = subscriptions[subId];
        sub.amount     = FHE.asEuint64(inAmount);     FHE.allow(sub.amount,    msg.sender);
        sub.recipient  = FHE.asEaddress(inRecipient);  FHE.allow(sub.recipient, msg.sender);
        sub.interval   = intervalSec;
        sub.lastCharged = block.timestamp;
        sub.active     = FHE.asEbool(true);            FHE.allow(sub.active,    msg.sender);
        sub.subscriber = msg.sender;
        emit SubscriptionCreated(subId, block.timestamp);
    }

    function chargeSubscription(bytes32 subId, bytes calldata inAmount) external {
        EncryptedSubscription storage sub = subscriptions[subId];
        require(block.timestamp >= sub.lastCharged + sub.interval, "too early");

        // Subscriber must have approved this gateway; caller charges
        paymentToken.encryptedTransferFrom(sub.subscriber, msg.sender, inAmount);
        sub.lastCharged = block.timestamp;
        emit SubscriptionCharged(subId, block.timestamp);
    }

    function cancelSubscription(bytes32 subId) external {
        EncryptedSubscription storage sub = subscriptions[subId];
        require(msg.sender == sub.subscriber, "not subscriber");
        sub.active = FHE.asEbool(false);
        FHE.allow(sub.active, msg.sender);
        emit SubscriptionCancelled(subId, block.timestamp);
    }

    function getSubscriptionHandles(bytes32 id) external view returns (SubscriptionHandles memory h) {
        EncryptedSubscription storage sub = subscriptions[id];
        h.amount      = euint64.unwrap(sub.amount);
        h.recipient   = eaddress.unwrap(sub.recipient);
        h.interval    = sub.interval;
        h.lastCharged = sub.lastCharged;
        h.active      = ebool.unwrap(sub.active);
        h.subscriber  = sub.subscriber;
    }
}
