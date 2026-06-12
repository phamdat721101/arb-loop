import { ethers } from 'ethers';
import abi from './abis/AgentSkillVault.json';

export function getSkillVaultContract(address: string, signerOrProvider: ethers.Signer | ethers.Provider) {
  return new ethers.Contract(address, abi, signerOrProvider);
}
