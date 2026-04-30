import type { RunStatus } from '@cursor/sdk';
import { ATTR, type MapperContext, type SpanOp, type TerminalStatus } from './types.js';

export function mapStatusListener(status: RunStatus, _ctx: MapperContext): readonly SpanOp[] {
  if (status === 'running') return [];

  const terminal: TerminalStatus = status;
  return [
    {
      kind: 'SetRunAttrs',
      attrs: { [ATTR.TERMINAL_STATUS]: terminal },
    },
    {
      kind: 'CloseRunSpan',
      terminalStatus: terminal,
    },
  ];
}
