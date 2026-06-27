// Render pi message/tool content into the readable strings that populate a span's
// input/output panels in Traceroot. pi content is `string | (TextContent | toolCall
// | image)[]`; tool results are `{ content: TextContent[] }`. We flatten text blocks
// and summarize tool-call/image blocks rather than dumping raw JSON.
import { safeJsonTruncate, safeSlice } from './json.ts';

// Default character budgets for each input/output surface.
export const IO_LIMITS = {
  llmInput: 8192,
  llmOutput: 4096,
  turnInput: 4096,
  turnOutput: 4096,
  toolArgs: 2048,
  toolResult: 4096,
} as const;

interface ContentBlock {
  type?: string;
  text?: string;
  toolName?: string;
  name?: string;
  args?: unknown;
  input?: unknown;
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? safeSlice(value, maxChars) + '…' : value;
}

// content: string | (TextContent | toolCall | image)[] -> readable string.
export function renderMessageContent(content: unknown, maxChars: number): string {
  if (content == null) return '';
  if (typeof content === 'string') return truncate(content, maxChars);
  if (!Array.isArray(content)) return safeJsonTruncate(content, maxChars);

  const parts: string[] = [];
  for (const block of content as ContentBlock[]) {
    if (block == null) continue;
    if (typeof block === 'string') {
      parts.push(block);
    } else if (typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'toolCall') {
      const name = block.toolName ?? block.name ?? 'tool';
      parts.push(`[tool_call: ${name} ${safeJsonTruncate(block.args ?? block.input, 600)}]`);
    } else if (block.type) {
      parts.push(`[${block.type}]`);
    }
  }
  return truncate(parts.join('\n'), maxChars);
}

// AgentToolResult ({ content: TextContent[] }) | string | unknown -> readable string.
export function renderToolResult(result: unknown, maxChars: number): string {
  if (result == null) return '';
  if (typeof result === 'string') return truncate(result, maxChars);
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) return renderMessageContent(content, maxChars);
  return safeJsonTruncate(result, maxChars);
}

// The last assistant message's text from an agent_end messages[] array.
export function lastAssistantText(messages: unknown, maxChars: number): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown } | null;
    if (m && m.role === 'assistant') return renderMessageContent(m.content, maxChars);
  }
  return '';
}
