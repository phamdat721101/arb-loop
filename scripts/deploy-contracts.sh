#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Installing dependencies..."
npm install

echo "==> Compiling contracts..."
npm run contracts:compile

echo "==> Deploying to Arbitrum Sepolia..."
npm run contracts:deploy:sepolia

DEPLOY_FILE="$ROOT/packages/contracts/deployments/arbitrum-sepolia.json"
echo ""
echo "==> Deployed addresses:"
cat "$DEPLOY_FILE"
echo ""
echo "Update these in:"
echo "  packages/agent/.env          (CONTEXT_MANAGER_ADDRESS, MEMORY_STORE_ADDRESS, AGENT_REGISTRY_ADDRESS)"
echo "  packages/frontend/.env.local (NEXT_PUBLIC_CONTEXT_MANAGER_ADDRESS, NEXT_PUBLIC_MEMORY_STORE_ADDRESS, NEXT_PUBLIC_AGENT_REGISTRY_ADDRESS)"
