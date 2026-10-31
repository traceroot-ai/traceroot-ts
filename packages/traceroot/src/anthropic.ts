import {
  context,
  createContextKey,
  INVALID_SPAN_CONTEXT,
  trace,
  TraceFlags,
  type Attributes,
  type AttributeValue,
  type Context,
  type Exception,
  type Link,
  type Span,
  type SpanContext,
  type SpanOptions,
  type SpanStatus,
  type TimeInput,
  type Tracer,
  type TracerProvider,
} from '@opentelemetry/api';
import type {
  Instrumentation,
  InstrumentationModuleDefinition,
} from '@opentelemetry/instrumentation';

interface RequestOwner {
  parent: Context;
  span?: Span;
  deferred?: DeferredNativeSpan;
}
const REQUEST_OWNER = createContextKey('traceroot.anthropic.request-owner');

/** A stream helper starts native tracing just before entering instrumented create().
 * Delay that recording decision until OI has made its own sampling decision. Native
 * setup only needs isRecording/setAttribute in this synchronous interval. */
class DeferredNativeSpan implements Span {
  private delegate?: Span;
  private pending: Array<(span: Span) => void> = [];

  constructor(private readonly startNative: () => Span) {}

  resolve(owner: Span): void {
    if (this.delegate) return;
    if (owner.isRecording() && owner.spanContext().traceFlags & TraceFlags.SAMPLED) {
      // Native end/content/usage writes must not end or unmask OI's recording span.
      this.delegate = trace.wrapSpanContext(owner.spanContext());
      this.pending = [];
    } else {
      this.native();
    }
  }

  private native(): Span {
    if (!this.delegate) {
      // This runs after Anthropic's original guardTracing() call returned.
      // Preserve its guarantee that a telemetry failure cannot fail an API call.
      try {
        this.delegate = this.startNative();
        for (const action of this.pending) action(this.delegate);
      } catch {
        try {
          this.delegate?.end();
        } catch {
          /* best-effort telemetry cleanup */
        }
        this.delegate = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
      } finally {
        this.pending = [];
      }
    }
    return this.delegate;
  }

  private apply(action: (span: Span) => void): this {
    if (this.delegate) action(this.delegate);
    else this.pending.push(action);
    return this;
  }

  isRecording(): boolean {
    return this.delegate?.isRecording() ?? true;
  }
  spanContext(): SpanContext {
    return this.native().spanContext();
  }
  end(time?: TimeInput): void {
    this.native().end(time);
  }
  setAttribute(key: string, value: AttributeValue): this {
    return this.apply((span) => span.setAttribute(key, value));
  }
  setAttributes(attrs: Attributes): this {
    return this.apply((span) => span.setAttributes(attrs));
  }
  addEvent(name: string, attrs?: Attributes | TimeInput, time?: TimeInput): this {
    return this.apply((span) => span.addEvent(name, attrs, time));
  }
  setStatus(status: SpanStatus): this {
    return this.apply((span) => span.setStatus(status));
  }
  updateName(name: string): this {
    return this.apply((span) => span.updateName(name));
  }
  recordException(error: Exception, time?: TimeInput): void {
    this.apply((span) => span.recordException(error, time));
  }
  addLink(link: Link): this {
    return this.apply((span) => span.addLink(link));
  }
  addLinks(links: Link[]): this {
    return this.apply((span) => span.addLinks(links));
  }
}

function ownershipProvider(provider: TracerProvider): TracerProvider {
  return {
    getTracer(name, version, options) {
      const tracer = provider.getTracer(name, version, options);
      return new Proxy(tracer, {
        get(target, key) {
          if (key === 'startSpan') {
            return (spanName: string, opts?: SpanOptions, parent = context.active()) => {
              const span = target.startSpan(spanName, opts, parent);
              const owner = parent.getValue(REQUEST_OWNER) as RequestOwner | undefined;
              if (owner) {
                owner.span = span;
                owner.deferred?.resolve(span);
              }
              return span;
            };
          }
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}

type Resource = { _client?: object };

/** Proxy only this invocation. Client options, cached clients and other requests
 * remain untouched, including their native tracer/provider and content settings. */
function resourceForRequest(resource: Resource, defer: boolean): Resource {
  const client = resource._client;
  if (!client) return resource;
  const clientProxy = new Proxy(client, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === '_tracer' && value) {
        const tracer = value as Tracer;
        return new Proxy(tracer, {
          get(native, property) {
            if (property === 'startSpan') {
              return (name: string, opts?: SpanOptions, parent = context.active()) => {
                const owner = parent.getValue(REQUEST_OWNER) as RequestOwner | undefined;
                const active = trace.getSpan(parent);
                const owned = owner?.span;
                if (
                  owned?.isRecording() &&
                  owned.spanContext().traceFlags & TraceFlags.SAMPLED &&
                  active?.spanContext().spanId === owned.spanContext().spanId &&
                  active.spanContext().traceId === owned.spanContext().traceId
                ) {
                  return trace.wrapSpanContext(owned.spanContext());
                }
                const start = () => native.startSpan(name, opts, owner?.parent ?? parent);
                return defer ? new DeferredNativeSpan(start) : start();
              };
            }
            const member = Reflect.get(native, property, native);
            return typeof member === 'function' ? member.bind(native) : member;
          },
        });
      }
      // Native clients use private fields. Their methods/getters need the real receiver.
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(resource, {
    get(target, key) {
      return key === '_client' ? clientProxy : Reflect.get(target, key, target);
    },
  });
}

type Method = (this: Resource, ...args: unknown[]) => unknown;
type Prototype = Record<string, Method>;
const wrapped = new WeakMap<object, Map<string, { original: Method; replacement: Method }>>();

function messagePrototypes(moduleRef: unknown): Prototype[] {
  const module = moduleRef as {
    default?: unknown;
    Messages?: { prototype: Prototype };
    Beta?: { Messages?: { prototype: Prototype } };
  };
  const sdk = (module?.default ?? module) as typeof module;
  return [sdk?.Messages?.prototype, sdk?.Beta?.Messages?.prototype].filter(
    (p): p is Prototype => !!p,
  );
}

function wrapMessages(moduleRef: unknown): void {
  for (const prototype of messagePrototypes(moduleRef)) {
    if (wrapped.has(prototype)) continue;
    const originals = new Map<string, { original: Method; replacement: Method }>();
    for (const name of ['create', 'countTokens', 'stream']) {
      const original = prototype[name];
      if (typeof original !== 'function') continue;
      const replacement: Method = function (...args) {
        const options = args[1] as { __span?: { span?: Span } } | undefined;
        const deferred = options?.__span?.span;
        const owner: RequestOwner = {
          parent: context.active(),
          deferred: deferred instanceof DeferredNativeSpan ? deferred : undefined,
        };
        return context.with(context.active().setValue(REQUEST_OWNER, owner), () =>
          original.apply(resourceForRequest(this, name === 'stream'), args),
        );
      };
      originals.set(name, { original, replacement });
      prototype[name] = replacement;
    }
    wrapped.set(prototype, originals);
  }
}

function unwrapMessages(moduleRef: unknown): void {
  for (const prototype of messagePrototypes(moduleRef)) {
    for (const [name, { original, replacement }] of wrapped.get(prototype) ?? []) {
      if (prototype[name] === replacement) prototype[name] = original;
    }
    wrapped.delete(prototype);
  }
}

interface AnthropicInstrumentor extends Instrumentation {
  manuallyInstrument(moduleRef: unknown): void;
  init(): InstrumentationModuleDefinition<unknown> | InstrumentationModuleDefinition<unknown>[];
}
type Constructor = new (options?: { tracerProvider?: TracerProvider }) => AnthropicInstrumentor;

/** Decorate the optional OI instrumentor without importing Anthropic or OI eagerly. */
export function withAnthropicOwnership(Base: Constructor): Constructor {
  return class extends Base {
    constructor() {
      super({ tracerProvider: ownershipProvider(trace.getTracerProvider()) });
    }

    setTracerProvider(provider: TracerProvider): void {
      super.setTracerProvider(ownershipProvider(provider));
    }

    init(): ReturnType<AnthropicInstrumentor['init']> {
      const definitions = super.init();
      for (const definition of Array.isArray(definitions) ? definitions : [definitions]) {
        const patch = definition.patch;
        const unpatch = definition.unpatch;
        definition.patch = (module, version) => {
          const result = patch?.(module, version) ?? module;
          wrapMessages(result);
          return result;
        };
        definition.unpatch = (module, version) => {
          unwrapMessages(module);
          unpatch?.(module, version);
        };
      }
      return definitions;
    }

    manuallyInstrument(moduleRef: unknown): void {
      super.manuallyInstrument(moduleRef);
      wrapMessages(moduleRef);
    }
  };
}
