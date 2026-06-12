import { hashMemory } from '@fhe-ai-context/sdk';
import { writeEncryptedMemory } from '../fhe/writeMemory';

export async function handleResponse(
  userAddress: string,
  userMessage: string,
  aiResponse: string,
): Promise<void> {
  const conversation = `User: ${userMessage}\nAssistant: ${aiResponse}`;
  const memHash = hashMemory(conversation);
  await writeEncryptedMemory(userAddress, memHash);
}
