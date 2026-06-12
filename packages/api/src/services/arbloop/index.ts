/**
 * services/arbloop/index.ts — DI factory for arb-loop runtime dependencies.
 *
 * Single source of truth for "give me the storage + encryption + attestation
 * clients for this process". Caller depends on the interfaces (`IEigenDaClient`,
 * `IArweaveClient`, `ILitEncryption`) — never on the concrete classes.
 *
 * v0.1: RUNTIME_STORAGE_MODE=mock returns Postgres-backed mock clients.
 * v0.2: RUNTIME_STORAGE_MODE=real wires real EigenDA + Irys + Lit Datil SDKs.
 *
 * SOLID:
 *   - SRP: composition only. No business logic.
 *   - DIP: callers receive interfaces, not classes.
 *   - LSP: mock + real impls obey the same contract.
 */

import type { IEigenDaClient, IArweaveClient, ILitEncryption } from '@fhe-ai-context/sdk';
import { MockEigenDaClient, MockArweaveClient } from './storage';
import { MockLitEncryption } from './litEncryption';
import { EasAttestation, type EasAttestationConfig } from './easAttestation';
import { InferenceFanout, loadInferenceConfigFromEnv } from './inferenceFanout';
import type { IInferenceFanout } from './loopExecutionEngine';

export interface ArbLoopRuntime {
  eigenDa: IEigenDaClient;
  arweave: IArweaveClient;
  lit: ILitEncryption;
  eas: EasAttestation;
  inference: IInferenceFanout;
  storageMode: 'mock' | 'real';
}

export function createArbLoopRuntime(): ArbLoopRuntime {
  const mode = (process.env.RUNTIME_STORAGE_MODE ?? 'mock').toLowerCase() as 'mock' | 'real';

  if (mode === 'real') {
    // v0.2 — wire real EigenDA + Irys + Lit Datil here. For now, fail loudly.
    throw new Error('arbloop:runtime:real_storage_not_implemented_v0_1');
  }

  const litMaster = process.env.ARBLOOP_LIT_MOCK_MASTER_SECRET;
  if (!litMaster) {
    throw new Error('arbloop:runtime:ARBLOOP_LIT_MOCK_MASTER_SECRET_required');
  }

  const easCfg: EasAttestationConfig = {
    rpcUrl: process.env.ARBITRUM_SEPOLIA_RPC ?? process.env.RPC_URL_ARBITRUM_SEPOLIA ?? '',
    privateKey: process.env.RELAYER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY ?? '',
    easContractAddress: process.env.ARBLOOP_EAS_CONTRACT_ADDRESS ?? '',
    iterSchemaUid: process.env.ARBLOOP_ITER_SCHEMA_UID ?? '',
    l5SchemaUid: process.env.ARBLOOP_L5_SCHEMA_UID ?? '',
  };
  if (!easCfg.rpcUrl || !easCfg.privateKey || !easCfg.easContractAddress) {
    throw new Error('arbloop:runtime:eas_env_incomplete');
  }

  return {
    eigenDa: new MockEigenDaClient(),
    arweave: new MockArweaveClient(),
    lit: new MockLitEncryption(litMaster),
    eas: new EasAttestation(easCfg),
    inference: new InferenceFanout(loadInferenceConfigFromEnv()),
    storageMode: 'mock',
  };
}

// Re-export concrete classes for tests/scripts that need direct access.
export { MockEigenDaClient, MockArweaveClient } from './storage';
export { MockLitEncryption } from './litEncryption';
export { EasAttestation } from './easAttestation';
export { InferenceFanout, loadInferenceConfigFromEnv } from './inferenceFanout';
export type { EasAttestationConfig } from './easAttestation';
