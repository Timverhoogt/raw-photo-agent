import { AnthropicTransport, type Effort } from './anthropic.ts';
import { CodexTransport } from './codex-cli.ts';
import { DecisionAgent, PhotoAgentError, type DecisionAgentOptions, type ModelTransport } from './core.ts';
import { OpenAICompatibleTransport, type StructuredOutputMode } from './openai-compatible.ts';

export const PROVIDERS = ['codex-cli', 'openai-compatible', 'anthropic'] as const;
export type ProviderName = typeof PROVIDERS[number];
type Env = Record<string, string | undefined>;

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], name: string): T | undefined {
  if (value === undefined || value === '') return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new PhotoAgentError('INVALID_INPUT', `${name} must be one of: ${allowed.join(', ')}.`);
  return value as T;
}
function optionalInteger(value: string | undefined, name: string, min: number, max: number): number | undefined {
  if (value === undefined || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new PhotoAgentError('INVALID_INPUT', `${name} must be an integer from ${min} to ${max}.`);
  return number;
}

export interface TransportOverrides { provider?: string; model?: string; refusalFallback?: boolean }

/** Chooses a provider from RPA_* variables; `codex-cli` stays the default so existing setups are unchanged. */
export function createTransport(env: Env = process.env, overrides: TransportOverrides = {}): ModelTransport {
  const provider = oneOf(overrides.provider ?? env.RPA_PROVIDER, PROVIDERS, 'RPA_PROVIDER') ?? 'codex-cli';
  const model = overrides.model ?? env.RPA_MODEL;
  const timeoutMs = optionalInteger(env.RPA_TIMEOUT_MS, 'RPA_TIMEOUT_MS', 5_000, 900_000);
  if (provider === 'codex-cli') return new CodexTransport({ model, timeoutMs, binary: env.RPA_CODEX_BIN });
  if (provider === 'anthropic') {
    return new AnthropicTransport({ model, timeoutMs, refusalFallback: overrides.refusalFallback,
      effort: oneOf<Effort>(env.RPA_EFFORT, ['low', 'medium', 'high', 'xhigh', 'max'], 'RPA_EFFORT') });
  }
  return new OpenAICompatibleTransport({
    baseUrl: env.RPA_BASE_URL ?? 'http://127.0.0.1:11434/v1', model: model ?? '', apiKey: env.RPA_API_KEY, timeoutMs,
    structuredOutput: oneOf<StructuredOutputMode>(env.RPA_STRUCTURED_OUTPUT, ['json_schema', 'json_object', 'none'], 'RPA_STRUCTURED_OUTPUT'),
    maxImageEdge: optionalInteger(env.RPA_MAX_IMAGE_EDGE, 'RPA_MAX_IMAGE_EDGE', 512, 8192),
  });
}

export function createPhotoAgent(env: Env = process.env, options: DecisionAgentOptions & TransportOverrides = {}): DecisionAgent {
  return new DecisionAgent(createTransport(env, options), {
    onAttempt: options.onAttempt,
    repairAttempts: options.repairAttempts ?? optionalInteger(env.RPA_REPAIR_ATTEMPTS, 'RPA_REPAIR_ATTEMPTS', 0, 2),
  });
}
