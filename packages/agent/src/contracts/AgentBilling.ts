import { ethers } from 'ethers';
import abi from './abis/AgentBilling.json';

export function getAgentBillingContract(address: string, signerOrProvider: ethers.Signer | ethers.Provider) {
  return new ethers.Contract(address, abi, signerOrProvider);
}
