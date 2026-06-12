let _client: any = null;
let _connected = false;

export async function getCofheClient() {
  if (!_client) {
    const { createCofheConfig, createCofheClient } = require('@cofhe/sdk/node');
    const { arbSepolia } = require('@cofhe/sdk/chains');
    _client = createCofheClient(createCofheConfig({ supportedChains: [arbSepolia] }));
  }
  if (!_connected && process.env.PRIVATE_KEY) {
    const { createPublicClient, createWalletClient, http } = require('viem');
    const { privateKeyToAccount } = require('viem/accounts');
    const { arbitrumSepolia } = require('viem/chains');
    const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
    const rpc = process.env.ARBITRUM_SEPOLIA_RPC || 'https://sepolia-rollup.arbitrum.io/rpc';
    await _client.connect(
      createPublicClient({ chain: arbitrumSepolia, transport: http(rpc) }),
      createWalletClient({ account, chain: arbitrumSepolia, transport: http(rpc) })
    );
    _connected = true;
  }
  return _client;
}
