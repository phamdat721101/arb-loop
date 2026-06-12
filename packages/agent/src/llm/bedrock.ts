const REGION = 'us-east-1';
const MODEL = 'us.anthropic.claude-opus-4-6-v1';
const BEDROCK_URL = `https://bedrock-runtime.${REGION}.amazonaws.com/model/${MODEL}/invoke`;

export async function bedrockChatCompletion(systemPrompt: string, userMessage: string): Promise<string> {
  const res = await fetch(BEDROCK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.BEDROCK_API_KEY}`,
    },
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Bedrock API error ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text ?? '';
}
