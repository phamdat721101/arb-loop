import { ethers } from 'ethers';
import abi from './abis/PrivPayGateway.json';

export function getPrivPayGatewayContract(address: string, signerOrProvider: ethers.Signer | ethers.Provider) {
  return new ethers.Contract(address, abi, signerOrProvider);
}
