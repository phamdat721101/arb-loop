import { ethers } from 'ethers';
import abi from './abis/AIMemoryStore.json';

export function getMemoryStoreContract(address: string, signerOrProvider: ethers.Signer | ethers.Provider) {
  return new ethers.Contract(address, abi, signerOrProvider);
}
