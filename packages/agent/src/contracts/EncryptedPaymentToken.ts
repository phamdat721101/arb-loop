import { ethers } from 'ethers';
import abi from './abis/EncryptedPaymentToken.json';

export function getPaymentTokenContract(address: string, signerOrProvider: ethers.Signer | ethers.Provider) {
  return new ethers.Contract(address, abi, signerOrProvider);
}
