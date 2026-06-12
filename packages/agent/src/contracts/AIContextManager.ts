import { ethers } from 'ethers';
import abi from './abis/AIContextManager.json';

export function getContextManagerContract(address: string, signerOrProvider: ethers.Signer | ethers.Provider) {
  return new ethers.Contract(address, abi, signerOrProvider);
}
