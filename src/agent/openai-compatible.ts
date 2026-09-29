import { DecisionAgent, PhotoAgentError, portableSchema, type AgentStatus, type DecisionAgentOptions,
  type ModelRequest, type ModelResponse, type ModelTransport } from './core.ts';
import { encodePreview, extractJson, isLoopbackUrl } from './encode.ts';

/**
 * json_schema: constrained output (OpenAI, recent Ollama, vLLM, LM Studio).
 * json_object: any JSON object; the schema is described in the prompt.
 * none: plain text; the schema is described in the prompt and a code fence is tolerated.
 */
export type StructuredOutputMode = 'json_schema' | 'json_object' | 'none';

export interface OpenAICompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  structuredOutput?: StructuredOutputMode;
  /** Long-edge pixel limit for attached previews. */
  maxImageEdge?: number;
  timeoutMs?: number;
  retries?: number;
  fetch?: typeof fetch;
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));

/** One adapter for OpenAI's Chat Completions shape: OpenAI, OpenRouter, Ollama, LM Studio, vLLM, llama.cpp. */
export class OpenAICompatibleTransport implements ModelTransport {
  readonly provider = 'openai-compatible';
  readonly model: string;
  readonly capabilities: { maxImages: number; dataLeavesDevice: boolean };
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly mode: StructuredOutputMode;
  private readonly maxImageEdge: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetch: typeof fetch;

  constructor(options: OpenAICompatibleOptions) {
    if (!options.model?.trim()) throw new PhotoAgentError('INVALID_INPUT', 'RPA_MODEL is required for the openai-compatible provider.');
    let url: URL;
    try { url = new URL(options.baseUrl); } catch { throw new PhotoAgentError('INVALID_INPUT', 'RPA_BASE_URL must be an absolute http(s) URL.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new PhotoAgentError('INVALID_INPUT', 'RPA_BASE_URL must be an absolute http(s) URL.');
    if (url.protocol === 'http:' && !isLoopbackUrl(options.baseUrl)) {
      throw new PhotoAgentError('INVALID_INPUT', 'Use https for a remote model endpoint; plain http is accepted only on this computer.');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.apiKey = options.apiKey || undefined;
    this.mode = options.structuredOutput ?? 'json_schema';
    this.maxImageEdge = options.maxImageEdge ?? 2048;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.retries = options.retries ?? 2;
    this.fetch = options.fetch ?? fetch;
    this.capabilities = { maxImages: 3, dataLeavesDevice: !isLoopbackUrl(this.baseUrl) };
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) };
  }

  async status(): Promise<AgentStatus> {
    const result = { available: false, model: this.model, provider: this.provider };
    try {
      const response = await this.fetch(`${this.baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(5_000) });
      if (response.status === 401 || response.status === 403) return { ...result, message: 'The model endpoint rejected the API key (RPA_API_KEY).' };
      if (!response.ok) return { ...result, message: `The model endpoint returned HTTP ${response.status}.` };
      const body = await response.json() as { data?: Array<{ id?: unknown }> };
      if (Array.isArray(body.data) && body.data.length && !body.data.some(entry => entry.id === this.model)) {
        return { ...result, message: `The endpoint does not list model ${this.model}.` };
      }
      return { ...result, available: true };
    } catch {
      return { ...result, message: `The model endpoint at ${this.baseUrl} is unreachable.` };
    }
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const images = await Promise.all(request.images.map(path => encodePreview(path, this.maxImageEdge)));
    const prompt = this.mode === 'json_schema' ? request.prompt
      : `${request.prompt}\nRespond with only one JSON object that matches this JSON Schema:\n${JSON.stringify(request.schema)}\n`;
    const body = {
      model: this.model,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        ...images.map(data => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } })),
      ] }],
      ...(this.mode === 'json_schema'
        ? { response_format: { type: 'json_schema', json_schema: { name: 'photo_decision', strict: true, schema: portableSchema(request.schema) } } }
        : this.mode === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
    };
    for (let attempt = 0; ; attempt++) {
      const signals = [AbortSignal.timeout(this.timeoutMs), ...(request.signal ? [request.signal] : [])];
      let response: Response;
      try {
        response = await this.fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: AbortSignal.any(signals),
        });
      } catch (error) {
        if (request.signal?.aborted) throw new PhotoAgentError('ABORTED', 'The photo decision was cancelled.');
        if (attempt < this.retries) { await pause(1_000 * 2 ** attempt); continue; }
        throw new PhotoAgentError((error as Error).name === 'TimeoutError' ? 'TIMEOUT' : 'PROVIDER_FAILED', 'The model endpoint could not be reached.');
      }
      if (RETRYABLE.has(response.status) && attempt < this.retries) {
        const after = Number(response.headers.get('retry-after'));
        await pause(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1_000 : 1_000 * 2 ** attempt);
        continue;
      }
      if (!response.ok) throw new PhotoAgentError('PROVIDER_FAILED', `The model endpoint returned HTTP ${response.status}.`);
      const data = await response.json() as {
        model?: string;
        choices?: Array<{ finish_reason?: string; message?: { content?: unknown; refusal?: unknown } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = data.choices?.[0];
      if (choice?.message?.refusal) throw new PhotoAgentError('PROVIDER_REFUSED', 'The model declined to make a photo decision.');
      if (choice?.finish_reason === 'length') throw new PhotoAgentError('OUTPUT_LIMIT', 'The model reply was cut off at its token limit.');
      if (typeof choice?.message?.content !== 'string') throw new PhotoAgentError('PROVIDER_FAILED', 'The model endpoint returned no text.');
      return {
        text: extractJson(choice.message.content),
        usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens, servedModel: data.model },
      };
    }
  }
}

export class OpenAICompatiblePhotoAgent extends DecisionAgent {
  constructor(options: OpenAICompatibleOptions & DecisionAgentOptions) {
    super(new OpenAICompatibleTransport(options), options);
  }
}
