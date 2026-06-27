// Guarded attribute setters. OpenTelemetry only accepts primitive attribute
// values (string | number | boolean) or homogeneous arrays of them. These helpers
// drop null/undefined and never pass objects to setAttribute, which would be
// silently dropped (or warned about) by the SDK.
import type { Span } from '@opentelemetry/api';

export type AttrValue = string | number | boolean;

export function setAttr(span: Span, key: string, value: AttrValue | null | undefined): void {
  if (value === null || value === undefined) return;
  span.setAttribute(key, value);
}

// Add a timestamped span event with a guarded primitive attribute bag.
export function addEvent(
  span: Span,
  name: string,
  attrs: Record<string, AttrValue | null | undefined>,
): void {
  const clean: Record<string, AttrValue> = {};
  for (const key of Object.keys(attrs)) {
    const v = attrs[key];
    if (v !== null && v !== undefined) clean[key] = v;
  }
  span.addEvent(name, clean);
}
