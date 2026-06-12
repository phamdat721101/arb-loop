import { ethers } from 'ethers';
import abi from './abis/SkillRegistry.json';

export function getSkillRegistryContract(address: string, signerOrProvider: ethers.Signer | ethers.Provider) {
  return new ethers.Contract(address, abi, signerOrProvider);
}
