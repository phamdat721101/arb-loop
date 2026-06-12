'use client';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { usePrivy } from '@privy-io/react-auth';
import { usePrivyEvmAddress, usePrivyEvmWallet } from '@/hooks/useActiveWallet';
import { BrowserProvider, Contract, parseUnits } from 'ethers';
import { useChat } from '@/hooks/useChat';
import { usePermit } from '@/hooks/usePermit';
import { useEncryptedBalance } from '@/hooks/useEncryptedBalance';
import { useFherc20Pay } from '@/hooks/useFherc20Pay';
import { PermitManager } from '@/components/PermitManager';
import { ChatBubble } from '@/components/ChatBubble';
import { getAgent, type Agent } from '@/lib/agents';
import { BASE_SEPOLIA_CHAIN_ID } from '@/lib/networks';

// USDC ERC-20 transfer on Base Sepolia (network in x402 challenge).
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ERC20_ABI = ['function transfer(address to, uint256 value) returns (bool)'];

// File-attach support — text-like files inline their content as task context;
// binary files inline only metadata so the agent can acknowledge + ask for
// a text export. Detection is conservative: MIME-type prefix or extension.
const TEXTY_EXT = /\.(txt|md|markdown|json|ya?ml|xml|csv|tsv|js|ts|tsx|jsx|py|rb|go|java|c|cpp|h|hpp|sh|sql|toml|ini|env|log|html|css|svg|sol|move|rs)$/i;
function isLikelyText(f: File): boolean {
  return f.type.startsWith('text/')
    || /^application\/(json|xml|yaml|x-yaml|toml|x-toml|javascript|typescript|sql)/.test(f.type)
    || TEXTY_EXT.test(f.name);
}
async function readAttachedAsContext(file: File): Promise<string> {
  const header = `\n\n--- Attached file: ${file.name} (${file.size} bytes, ${file.type || 'unknown'}) ---\n`;
  if (!isLikelyText(file)) {
    return `${header}[binary content not decoded; ask the user for a text export if needed]\n--- End attached file ---`;
  }
  const text = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
  // Cap inlined text to keep prompts under the model's context budget.
  const MAX = 60_000;
  const body = text.length > MAX ? `${text.slice(0, MAX)}\n[…truncated ${text.length - MAX} chars]` : text;
  return `${header}${body}\n--- End attached file ---`;
}

export default function ChatAgentPage() {
  const params = useParams<{ agentId: string }>();
  const agentId = params?.agentId;
  const { authenticated, ready, user, login } = usePrivy();
  const evmWallet = usePrivyEvmWallet();
  const userAddress = usePrivyEvmAddress();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<'learn' | 'store'>('learn');
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    permitState,
    reason,
    authorize,
    revoke,
    forceUnauthorized,
    loading: permitLoading,
    error: permitError,
  } = usePermit(userAddress);
  const { messages, sendMessage, loading, error, needsPayment, clearPayment, freeRemaining } = useChat(
    userAddress,
    forceUnauthorized,
  );

  // T6/PRD-C: 3-state private-payment UX (preview → activate → debit).
  // Hook returns 'unknown' when FEATURE_FHE_PAY=false on the server (404),
  // which leaves the page rendering today's UX byte-identical.
  const balance = useEncryptedBalance(
    userAddress,
    agentId,
    agent?.ownerAddress as `0x${string}` | undefined,
  );
  const fherc20 = useFherc20Pay();
  // Optimistic update: when the inference response carries a new value, use it
  // for the badge until the next refresh().
  const liveFreeLeft = freeRemaining ?? balance.freeLeft;

  const isPermitted = !!permitState.serializedPermit;
  const isOwner =
    !!agent && !!userAddress && agent.ownerAddress.toLowerCase() === userAddress.toLowerCase();

  useEffect(() => {
    if (agentId) getAgent(agentId).then(setAgent);
  }, [agentId]);

  async function handleSend() {
    if ((!input.trim() && !attachedFile) || loading || !agentId) return;
    let m = input.trim();
    if (attachedFile) {
      try {
        m = `${m || `Process the attached file: ${attachedFile.name}`}${await readAttachedAsContext(attachedFile)}`;
      } catch (e) {
        // File read failed — drop the attachment and send the message alone.
        m = m || `Could not read ${attachedFile.name}.`;
      }
    }
    setInput('');
    setAttachedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    await sendMessage(m, agentId, isOwner ? mode : 'learn');
  }

  /**
   * payAndAsk — settle 0.01 USDC to the brain owner on Base Sepolia, then
   * retry the inference call with x-payment-tx so the API records a paid
   * brain_access_requests row. Owner sees the row on /earnings and grants.
   */
  async function payAndAsk() {
    if (!needsPayment?.payTo || !evmWallet || !userAddress) return;
    setPaying(true);
    setPayError(null);
    try {
      await evmWallet.switchChain(BASE_SEPOLIA_CHAIN_ID);
      const provider = await evmWallet.getEthereumProvider();
      const signer = await new BrowserProvider(provider).getSigner();
      const usdc = new Contract(USDC_BASE_SEPOLIA, ERC20_ABI, signer);
      const tx = await usdc.transfer(needsPayment.payTo, parseUnits(needsPayment.amountUsdc ?? '0.01', 6));
      await tx.wait();
      // Hand the tx hash to the API on the next inference call.
      const lastQuestion = messages.filter((m) => m.role === 'user').slice(-1)[0]?.content;
      if (lastQuestion && agentId) {
        await fetch(`${(await import('@/lib/contracts')).AGENT_BACKEND_URL}/v2/access/requests?buyer=${userAddress}`)
          .catch(() => {}); // warm cache
        clearPayment();
        // Re-send last user message — useChat will retry with the receipt.
        await sendMessageWithReceipt(lastQuestion, agentId, tx.hash);
      } else {
        clearPayment();
      }
    } catch (e: any) {
      setPayError(e?.shortMessage || e?.message || 'Payment failed');
    } finally {
      setPaying(false);
    }
  }

  /** One-shot retry that includes x-payment-tx so the API logs the receipt. */
  async function sendMessageWithReceipt(question: string, brainId: string, txHash: string) {
    const { AGENT_BACKEND_URL } = await import('@/lib/contracts');
    await fetch(`${AGENT_BACKEND_URL}/v2/inference`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-wallet-address': userAddress!,
        'x-payment-tx': txHash,
      },
      body: JSON.stringify({ chunks: ['(awaiting access)'], question, brainId: Number(brainId) }),
    }).catch(() => {});
  }

  if (!ready) return null;

  if (!authenticated) {
    return (
      <div className="space-y-4 py-20 text-center">
        <h1 className="font-headline text-2xl font-bold">Connect to chat</h1>
        <p className="text-on-surface-variant">You need a wallet to hire an agent.</p>
        <button
          onClick={login}
          className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-3 font-medium text-on-primary"
        >
          Connect wallet
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col gap-4">
      {/* Header strip */}
      <div className="flex items-center justify-between gap-3 rounded-xl border border-outline-variant/30 bg-surface px-4 py-3">
        <div className="flex items-center gap-3">
          <Link
            href={`/agent/${agentId}`}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors hover:bg-primary/20"
            aria-label="Back to agent profile"
          >
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          </Link>
          <div className="min-w-0">
            <div className="truncate font-headline text-sm font-semibold">
              {agent?.title ?? `Agent #${agentId}`}
            </div>
            <div className="font-mono text-[11px] text-on-surface-variant">
              {/* T6/PRD-C: 3-state badge. Falls back to today's label when
                  FEATURE_FHE_PAY=off (mode === 'unknown'). */}
              {balance.mode === 'preview' && (
                <span>🎁 {liveFreeLeft} free question{liveFreeLeft === 1 ? '' : 's'} left</span>
              )}
              {balance.mode === 'needs-activation' && '🔒 Activate to keep asking'}
              {balance.mode === 'active' && balance.balanceUsdc !== null && (
                <span>🔒 ${balance.balanceUsdc.toFixed(2)} left</span>
              )}
              {balance.mode === 'active' && balance.balanceUsdc === null && '🔒 Encrypted balance'}
              {balance.mode === 'unknown' && '🔒 Encrypted via Fhenix CoFHE'}
            </div>
          </div>
        </div>
        {isOwner && (
          <div className="flex rounded-full border border-outline-variant/30 bg-surface-container-high p-1">
            {(['learn', 'store'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-full px-3 py-1 font-mono text-[11px] uppercase transition-colors ${
                  mode === m ? 'bg-primary text-on-primary' : 'text-on-surface-variant'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Permit UI is owner-only. Non-owners chat freely; the API surfaces
          402 (paywall) for unpublished brains and 403 (permit) only when the
          owner-decrypt path is hit. forceUnauthorized flips this reactively
          on a real 403. */}
      {isOwner && !isPermitted && userAddress && (
        <PermitManager
          permitState={permitState}
          authorize={authorize}
          revoke={revoke}
          loading={permitLoading}
          error={permitError}
          reason={reason}
        />
      )}

      {/* Messages */}
      <div className="flex-1 space-y-4 overflow-y-auto rounded-xl border border-outline-variant/30 bg-surface-container-low p-4">
        {needsPayment && (
          <div className="rounded-lg border border-tertiary/30 bg-tertiary/10 p-4 text-sm text-tertiary">
            <div className="font-medium">Activate to ask this brain</div>
            <div className="mt-1 text-xs text-on-surface-variant">
              Pay <span className="font-mono">${needsPayment.amountUsdc ?? '0.01'} USDC</span> to{' '}
              <span className="font-mono">
                {needsPayment.payTo?.slice(0, 8)}…{needsPayment.payTo?.slice(-4)}
              </span>{' '}
              on Base Sepolia. The owner will then grant on-chain access.
            </div>
            {payError && <div className="mt-2 text-error">{payError}</div>}
            <button
              type="button"
              onClick={payAndAsk}
              disabled={paying}
              className="mt-3 rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-on-primary hover:bg-primary/90 disabled:opacity-50"
            >
              {paying ? 'Paying…' : `Pay $${needsPayment.amountUsdc ?? '0.01'} USDC`}
            </button>
          </div>
        )}
        {error && !needsPayment && (
          <div className="rounded-lg border border-error/30 bg-error/10 p-3 text-sm text-error">
            {error}
          </div>
        )}
        {messages.length === 0 && !(isOwner && !isPermitted) && !loading && (
          <div className="py-12 text-center text-sm text-on-surface-variant">
            Start by asking the agent something.
          </div>
        )}
        {messages.map((m, i) => (
          <ChatBubble key={i} role={m.role}>
            {m.content}
          </ChatBubble>
        ))}
        {loading && (
          <ChatBubble role="assistant" attestation={false}>
            <span className="animate-pulse text-on-surface-variant">Thinking…</span>
          </ChatBubble>
        )}
      </div>

      {/* Composer */}
      <div className="rounded-xl border border-outline-variant/30 bg-surface p-3">
        {attachedFile && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-secondary/30 bg-secondary/5 px-3 py-2 text-xs">
            <span className="material-symbols-outlined text-[14px] text-secondary">attach_file</span>
            <span className="truncate font-mono">{attachedFile.name}</span>
            <span className="font-mono text-[10px] text-on-surface-variant">
              {(attachedFile.size / 1024).toFixed(1)} kB
            </span>
            <button
              type="button"
              onClick={() => {
                setAttachedFile(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
              className="ml-auto rounded-full p-1 text-on-surface-variant hover:bg-surface-container hover:text-error"
              aria-label="Remove attachment"
            >
              <span className="material-symbols-outlined text-[14px]">close</span>
            </button>
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            onChange={(e) => setAttachedFile(e.target.files?.[0] ?? null)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={(isOwner && !isPermitted) || loading}
            className="rounded-full p-2.5 text-on-surface-variant transition-colors hover:bg-surface-container-low hover:text-primary disabled:opacity-50"
            aria-label="Attach file for task context"
            title="Attach a file for task context (any type)"
          >
            <span className="material-symbols-outlined text-[18px]">attach_file</span>
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder={
              isOwner && !isPermitted
                ? 'Authorize FHE permit to chat your encrypted brain'
                : attachedFile
                  ? `Describe what to do with ${attachedFile.name}…`
                  : `Ask a question or describe a task — attach a file for context`
            }
            disabled={(isOwner && !isPermitted) || loading}
            className="flex-1 rounded-full bg-surface-container-low px-4 py-2 text-sm text-on-surface placeholder:text-on-surface-variant focus:outline-none disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={(!input.trim() && !attachedFile) || loading || (isOwner && !isPermitted)}
            className="rounded-full bg-primary p-2.5 text-on-primary transition-colors hover:bg-primary/90 disabled:opacity-50"
            aria-label="Send"
          >
            <span className="material-symbols-outlined text-[18px]">send</span>
          </button>
        </div>
        {/* T6/PRD-C: one-tap Activate when free quota is exhausted.
            Reuses useFherc20Pay → silent sign with Privy embedded wallet. */}
        {balance.mode === 'needs-activation' && agent?.ownerAddress && (
          <button
            type="button"
            onClick={async () => {
              try {
                await fherc20.pay('5', agent.ownerAddress as `0x${string}`);
                await balance.refresh();
              } catch { /* error surfaced via fherc20.error */ }
            }}
            disabled={fherc20.pending}
            className="mt-3 w-full rounded-full bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:bg-primary/90 disabled:opacity-50"
          >
            {fherc20.pending ? 'Encrypting…' : '🔒 Activate ($5 → encrypted balance)'}
          </button>
        )}
        {fherc20.error && balance.mode === 'needs-activation' && (
          <div className="mt-2 text-xs text-error">{fherc20.error}</div>
        )}
        {/* Top-up nudge: appears when balance drops below $0.50. */}
        {balance.mode === 'active' && balance.balanceUsdc !== null && balance.balanceUsdc < 0.5 && agent?.ownerAddress && (
          <button
            type="button"
            onClick={async () => {
              try {
                await fherc20.pay('5', agent.ownerAddress as `0x${string}`);
                await balance.refresh();
              } catch { /* no-op */ }
            }}
            disabled={fherc20.pending}
            className="mt-3 w-full rounded-full border border-tertiary/40 bg-tertiary/10 px-4 py-2 text-xs text-tertiary hover:bg-tertiary/20 disabled:opacity-50"
          >
            {fherc20.pending ? 'Encrypting…' : 'Top up another $5?'}
          </button>
        )}
      </div>
    </div>
  );
}
