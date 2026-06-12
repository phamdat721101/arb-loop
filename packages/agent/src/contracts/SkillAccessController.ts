import { ethers } from 'ethers';
import abi from './abis/SkillAccessController.json';

export function getSkillAccessControllerContract(address: string, signerOrProvider: ethers.Signer | ethers.Provider) {
  return new ethers.Contract(address, abi, signerOrProvider);
}
