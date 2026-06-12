import { createCofheConfig, createCofheClient } from '@cofhe/sdk/web';
import { arbSepolia } from '@cofhe/sdk/chains';

let _client: ReturnType<typeof createCofheClient> | null = null;

export function getCofheClient() {
  if (_client) return _client;
  const config = createCofheConfig({
    supportedChains: [arbSepolia],
  });
  _client = createCofheClient(config);
  return _client;
}

export function resetCofheClient() {
  _client = null;
}
