import { SpanManager } from './span-manager.js';
import type { SpanOp } from './types.js';

export function applySpanOps(manager: SpanManager, ops: readonly SpanOp[]): void {
  for (const op of ops) {
    switch (op.kind) {
      case 'OpenRunSpan':
        manager.openRun({
          agentId: op.agentId,
          modelId: op.modelId,
          runtime: op.runtime,
        });
        break;
      case 'SetRunAttrs':
        manager.setRunAttrs(op.attrs);
        break;
      case 'OpenToolSpan':
        manager.openTool(op.callId, op.toolType);
        break;
      case 'EnrichToolSpan':
        manager.enrichTool(op.callId, op.attrs);
        break;
      case 'CloseToolSpan':
        manager.closeTool(op.callId, op.status);
        break;
      case 'AddSpanEvent':
        manager.addEvent(op.target, op.callId, op.name, op.attrs);
        break;
      case 'CloseRunSpan':
        manager.closeRun(op.terminalStatus);
        break;
    }
  }
}
