import { ethers } from 'ethers';
import abi from './abis/SettlementLedger.json';

export function getSettlementLedgerContract(address: string, signerOrProvider: ethers.Signer | ethers.Provider) {
  return new ethers.Contract(address, abi, signerOrProvider);
}
