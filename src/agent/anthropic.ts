import Anthropic from '@anthropic-ai/sdk';
import { DecisionAgent, PhotoAgentError, portableSchema, type AgentStatus, type DecisionAgentOptions,
  type ModelRequest, type ModelResponse, type ModelTransport } from './core.ts';
import { encodePreview } from './encode.ts';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
/** Models that accept server-side refusal fallback in its "default" form on the Claude API. */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export interface AnthropicOptions {
  model?: string;
  /** Omitted for models without effort support (Haiku). Defaults to high: photo judgment is quality-sensitive. */
  effort?: Effort;
  /**
   * Re-run a safety-classifier decline on Anthropic's recommended model. On for the live demo;
   * the evaluation turns it off so every scored decision comes from the model under test.
   */
  refusalFallback?: boolean;
  timeoutMs?: number;
  /** Injected for tests; otherwise the SDK resolves credentials (ANTHROPIC_API_KEY or an `ant auth login` profile). */
  client?: Anthropic;
}

export class AnthropicTransport implements ModelTransport {
  readonly provider = 'anthropic';
  readonly capabilities = { maxImages: 3, dataLeavesDevice: true };
  readonly model: string;
  private readonly effort: Effort | undefined;
  private readonly fallback: boolean;
  private readonly maxImageEdge: number;
  private readonly timeoutMs: number;
  private client: Anthropic | undefined;

  constructor(options: AnthropicOptions = {}) {
    this.model = options.model?.trim() || DEFAULT_ANTHROPIC_MODEL;
    const haiku = this.model.startsWith('claude-haiku');
    this.effort = haiku ? undefined : options.effort ?? 'high';
    this.fallback = (options.refusalFallback ?? true) && FALLBACK_MODELS.has(this.model);
    this.maxImageEdge = haiku ? 1568 : 2576;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.client = options.client;
  }

  private api(): Anthropic {
    this.client ??= new Anthropic({ timeout: this.timeoutMs, maxRetries: 2 });
    return this.client;
  }

  async status(): Promise<AgentStatus> {
    const result = { available: false, model: this.model, provider: this.provider };
    try {
      await this.api().models.retrieve(this.model);
      return { ...result, available: true };
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) return { ...result, message: 'The Claude API rejected the credentials. Set ANTHROPIC_API_KEY or run ant auth login.' };
      if (error instanceof Anthropic.NotFoundError) return { ...result, message: `Model ${this.model} is not available to this account.` };
      if (error instanceof Anthropic.APIError && error.status !== undefined) return { ...result, message: `The Claude API returned HTTP ${error.status}.` };
      return { ...result, message: 'The Claude API is unreachable or no credentials are configured. Set ANTHROPIC_API_KEY or run ant auth login.' };
    }
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const images = await Promise.all(request.images.map(path => encodePreview(path, this.maxImageEdge)));
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.api().beta.messages.create({
        model: this.model,
        max_tokens: 16_000,
        messages: [{ role: 'user', content: [
          ...images.map(data => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data } })),
          { type: 'text' as const, text: request.prompt },
        ] }],
        output_config: {
          format: { type: 'json_schema', schema: portableSchema(request.schema) as Record<string, unknown> },
          ...(this.effort ? { effort: this.effort } : {}),
        },
        ...(this.fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      }, { signal: request.signal });
    } catch (error) {
      if (error instanceof Anthropic.APIUserAbortError || request.signal?.aborted) throw new PhotoAgentError('ABORTED', 'The photo decision was cancelled.');
      if (error instanceof Anthropic.APIConnectionTimeoutError) throw new PhotoAgentError('TIMEOUT', 'The photo decision exceeded its time limit.');
      if (error instanceof Anthropic.AuthenticationError) throw new PhotoAgentError('PROVIDER_AUTH', 'The Claude API rejected the credentials.');
      if (error instanceof Anthropic.APIError) throw new PhotoAgentError('PROVIDER_FAILED', `The Claude API returned ${error.status ?? 'an error'}: ${error.message}`);
      throw new PhotoAgentError('PROVIDER_FAILED', 'The Claude API could not be reached.');
    }
    if (response.stop_reason === 'refusal') throw new PhotoAgentError('PROVIDER_REFUSED', 'The model declined to make a photo decision.');
    if (response.stop_reason === 'max_tokens') throw new PhotoAgentError('OUTPUT_LIMIT', 'The model reply was cut off at its token limit.');
    const text = response.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
    if (!text) throw new PhotoAgentError('PROVIDER_FAILED', 'The Claude API returned no text.');
    return { text, usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, servedModel: response.model } };
  }
}

export class AnthropicPhotoAgent extends DecisionAgent {
  constructor(options: AnthropicOptions & DecisionAgentOptions = {}) {
    super(new AnthropicTransport(options), options);
  }
}
