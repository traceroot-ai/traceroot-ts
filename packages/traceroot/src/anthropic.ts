import {
  context,
  trace,
  TraceFlags,
  type Context,
  type Span,
  type SpanContext,
  type SpanOptions,
  type TracerProvider,
} from '@opentelemetry/api';
import type {
  Instrumentation,
  InstrumentationModuleDefinition,
} from '@opentelemetry/instrumentation';

const fallbackParents = new WeakMap<SpanContext, Context>();

function fallbackProvider(provider: TracerProvider): TracerProvider {
  return {
    getTracer(name, version, options) {
      const tracer = provider.getTracer(name, version, options);
      return new Proxy(tracer, {
        get(target, key) {
          if (key === 'startSpan') {
            return (spanName: string, opts?: SpanOptions, parent = context.active()) => {
              const span = target.startSpan(spanName, opts, parent);
              const spanContext = span.spanContext();
              if (span.isRecording() && spanContext.traceFlags & TraceFlags.SAMPLED) return span;
              fallbackParents.set(spanContext, parent);
              return new Proxy(span, {
                get(delegate, property) {
                  if (property === 'spanContext') return () => spanContext;
                  const value = Reflect.get(delegate, property, delegate);
                  return typeof value === 'function' ? value.bind(delegate) : value;
                },
              });
            };
          }
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}

type Method = (this: unknown, ...args: unknown[]) => unknown;
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

function wrapFallback(moduleRef: unknown): void {
  for (const prototype of messagePrototypes(moduleRef)) {
    if (wrapped.has(prototype)) continue;
    const originals = new Map<string, { original: Method; replacement: Method }>();
    for (const name of ['create', 'countTokens']) {
      const original = prototype[name];
      if (typeof original !== 'function') continue;
      const replacement: Method = function (...args) {
        const active = trace.getActiveSpan();
        const activeContext = active?.spanContext();
        const parent = activeContext && fallbackParents.get(activeContext);
        const options = args[1] as { __span?: { span?: Span } } | undefined;
        const callContext = options?.__span?.span?.spanContext();
        if (
          !parent ||
          (options?.__span &&
            (callContext?.traceId !== activeContext?.traceId ||
              callContext?.spanId !== activeContext?.spanId))
        ) {
          return original.apply(this, args);
        }
        // Upstream 1.0.1 treats a sampled-out OI span as a usage owner. Let native
        // tracing decide under the caller's context, preserving caller-owned spans.
        const callArgs = [...args];
        if (options?.__span) {
          const nativeOptions = { ...options };
          delete nativeOptions.__span;
          callArgs[1] = nativeOptions;
        }
        return context.with(parent, () => original.apply(this, callArgs));
      };
      originals.set(name, { original, replacement });
      prototype[name] = replacement;
    }
    wrapped.set(prototype, originals);
  }
}

function unwrapFallback(moduleRef: unknown): void {
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

export function withAnthropicFallback(Base: Constructor): Constructor {
  const modules = new WeakMap<object, Set<unknown>>();
  return class extends Base {
    constructor() {
      super({ tracerProvider: fallbackProvider(trace.getTracerProvider()) });
    }

    private remember(moduleRef: unknown): void {
      if (!modules.has(this)) modules.set(this, new Set());
      modules.get(this)?.add(moduleRef);
    }

    setTracerProvider(provider: TracerProvider): void {
      super.setTracerProvider(fallbackProvider(provider));
    }

    init(): ReturnType<AnthropicInstrumentor['init']> {
      const definitions = super.init();
      for (const definition of Array.isArray(definitions) ? definitions : [definitions]) {
        const patch = definition.patch;
        const unpatch = definition.unpatch;
        definition.patch = (module, version) => {
          wrapFallback(module);
          this.remember(module);
          return patch?.(module, version) ?? module;
        };
        definition.unpatch = (module, version) => {
          unpatch?.(module, version);
          unwrapFallback(module);
          modules.get(this)?.delete(module);
        };
      }
      return definitions;
    }

    manuallyInstrument(moduleRef: unknown): void {
      wrapFallback(moduleRef);
      this.remember(moduleRef);
      super.manuallyInstrument(moduleRef);
    }

    disable(): void {
      super.disable();
      for (const module of modules.get(this) ?? []) unwrapFallback(module);
      modules.delete(this);
    }
  };
}
