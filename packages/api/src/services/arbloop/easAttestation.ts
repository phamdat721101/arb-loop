/**
 * easAttestation.ts — Real EAS (Ethereum Attestation Service) client.
 *
 * Uses ethers v6 + a minimal IEAS ABI to mint + verify attestations on
 * Arbitrum Sepolia. EAS is the only storage primitive that ships REAL in
 * v0.1 (mock storage clients above; real EAS here).
 *
 * SOLID:
 *   - SRP: attestation mint + verify only. No HKDF, no encryption.
 *   - DIP: signer + EAS contract address injected via constructor.
 *   - OCP: adding a schema = one entry in `schemas` map.
 */

import { Contract, Interface, Wallet, JsonRpcProvider, AbiCoder, ZeroAddress, ZeroHash } from 'ethers';
import type { IterationReceiptDataArb, L5ReflectionDataArb } from '@fhe-ai-context/sdk';

export type EasSchemaName = 'iter' | 'l5_reflection';

const EAS_ABI = [
  'function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data)) external payable returns (bytes32)',
  'function getAttestation(bytes32 uid) external view returns (tuple(bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data))',
];

const ITER_ABI_TYPES = [
  'address', // jobAddress
  'uint256', // iterN
  'bytes32', // eigenInputKzg
  'bytes32', // eigenOutputKzg
  'address', // phalaSigningAddress
  'bytes32', // phalaAttestationHash
  'uint256', // amountPaidMicroUsdc
  'address', // pullSplitAddress
];

const L5_ABI_TYPES = [
  'address', // agentContract
  'address', // jobAddress
  'bytes32', // arweaveTxId (32 bytes; we pad/truncate the 43-char string to 32 bytes via keccak)
  'uint64',  // reflectiveAtMs
];

export interface EasAttestationConfig {
  rpcUrl: string;
  privateKey: string;
  easContractAddress: string;
  iterSchemaUid: string;
  l5SchemaUid: string;
}

export class EasAttestation {
  private readonly provider: JsonRpcProvider;
  private readonly signer: Wallet;
  private readonly eas: Contract;
  private readonly iface = new Interface(EAS_ABI);
  private readonly schemaUids: Record<EasSchemaName, string>;

  constructor(cfg: EasAttestationConfig) {
    this.provider = new JsonRpcProvider(cfg.rpcUrl);
    this.signer = new Wallet(cfg.privateKey, this.provider);
    this.eas = new Contract(cfg.easContractAddress, EAS_ABI, this.signer);
    this.schemaUids = { iter: cfg.iterSchemaUid, l5_reflection: cfg.l5SchemaUid };
  }

  /**
   * Mint an attestation for an iteration receipt. Returns the EAS UID.
   */
  async attestIteration(data: IterationReceiptDataArb): Promise<string> {
    const encoded = AbiCoder.defaultAbiCoder().encode(ITER_ABI_TYPES, [
      data.jobAddress,
      data.iterN,
      data.eigenInputKzg,
      data.eigenOutputKzg,
      data.phalaSigningAddress,
      data.phalaAttestationHash,
      data.amountPaidMicroUsdc,
      data.pullSplitAddress,
    ]);
    return this.attestRaw('iter', data.jobAddress, encoded);
  }

  /**
   * Mint an attestation for an L5 reflective writeback. Returns the EAS UID.
   * Note: arweaveTxId comes in as a 43-char base64url string; we re-hash to
   * 32 bytes for the schema field (callers preserve the full string in the
   * AgentMemoryNamespace contract pointer).
   */
  async attestL5Reflection(
    data: L5ReflectionDataArb & { arweaveTxIdBytes32: string },
  ): Promise<string> {
    const encoded = AbiCoder.defaultAbiCoder().encode(L5_ABI_TYPES, [
      data.agentContract,
      data.jobAddress,
      data.arweaveTxIdBytes32,
      data.reflectiveAtMs,
    ]);
    return this.attestRaw('l5_reflection', data.jobAddress, encoded);
  }

  async verify(uid: string): Promise<{ uid: string; schema: string; attester: string; data: string } | null> {
    const r = await this.eas.getAttestation(uid);
    if (!r || r.uid === ZeroHash) return null;
    return {
      uid: r.uid,
      schema: r.schema,
      attester: r.attester,
      data: r.data,
    };
  }

  /** Internal: mint with the right schema UID + extract UID from receipt logs. */
  private async attestRaw(
    schemaName: EasSchemaName,
    recipient: string,
    encodedData: string,
  ): Promise<string> {
    const tx = await this.eas.attest({
      schema: this.schemaUids[schemaName],
      data: {
        recipient,
        expirationTime: 0,
        revocable: false,
        refUID: ZeroHash,
        data: encodedData,
        value: 0,
      },
    });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('arbloop:eas:no_receipt');
    // EAS emits a uint256-shaped UID in the return value of attest(); ethers v6
    // exposes this via the contract call's resolved value when called as
    // `staticCall`, but for state-changing tx we parse from logs.
    for (const log of receipt.logs) {
      // EAS Attested event: Attested(address,address,bytes32,bytes32)
      // topic[0] = keccak256("Attested(address,address,bytes32,bytes32)")
      // topic[3] = uid
      if (log.topics.length === 4) {
        const uid = log.topics[3];
        if (uid && uid !== ZeroHash) return uid;
      }
    }
    // Fallback: re-call statically to recover UID (for chains that don't
    // emit the standard Attested event in logs)
    const sim = await this.eas.attest.staticCall({
      schema: this.schemaUids[schemaName],
      data: {
        recipient,
        expirationTime: 0,
        revocable: false,
        refUID: ZeroHash,
        data: encodedData,
        value: 0,
      },
    });
    return sim;
  }

  get signerAddress(): string {
    return this.signer.address;
  }

  get unused(): typeof ZeroAddress {
    return ZeroAddress;
  }
}
