interface ChatBubbleProps {
  role: 'user' | 'assistant';
  children: React.ReactNode;
  /** Show the FHE-verified attestation badge — defaults to true on assistant messages. */
  attestation?: boolean;
}

export function ChatBubble({ role, children, attestation = role === 'assistant' }: ChatBubbleProps) {
  const isUser = role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-xl px-4 py-3 text-sm leading-relaxed ${
          isUser
            ? 'rounded-tr-sm bg-surface-container-high text-on-surface'
            : 'rounded-tl-sm border border-outline-variant/30 bg-surface text-on-surface'
        }`}
      >
        {!isUser && attestation && (
          <span className="mb-2 inline-flex items-center gap-1 rounded-full border border-secondary/30 bg-secondary/10 px-2 py-0.5 font-mono text-[10px] text-secondary">
            <span className="material-symbols-outlined text-[12px]">shield</span>
            FHE Verified
          </span>
        )}
        <div className="whitespace-pre-wrap">{children}</div>
      </div>
    </div>
  );
}
