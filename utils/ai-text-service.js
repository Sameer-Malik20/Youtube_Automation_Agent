const OpenAI = require('openai');
const { Logger } = require('./logger');

const GEMINI_MODELS = [
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash-lite',
];
const GEMINI_DEFAULT_MODEL = GEMINI_MODELS[0];

const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.6',
    models: ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    envKey: 'OPENAI_API_KEY',
  },
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-5.6-sol',
    models: ['openai/gpt-5.6-sol', 'anthropic/claude-fable-5', 'google/gemini-3.7-flash', 'moonshotai/kimi-k3', 'z-ai/glm-5.3'],
    envKey: 'OPENROUTER_API_KEY',
  },
  kimi: {
    name: 'Kimi (Moonshot AI)',
    baseURL: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k3',
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
    envKey: 'MOONSHOT_API_KEY',
  },
  mimo: {
    name: 'MiMo (Xiaomi)',
    baseURL: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5-pro',
    models: ['mimo-v2.5-pro', 'mimo-v2.5'],
    envKey: 'MIMO_API_KEY',
  },
  glm: {
    name: 'GLM (Zhipu AI)',
    baseURL: 'https://api.z.ai/api/paas/v4/',
    defaultModel: 'glm-5.3',
    models: ['glm-5.3', 'glm-5.2', 'glm-5.1'],
    envKey: 'GLM_API_KEY',
  },
};

class AITextService {
  constructor(credentials = {}) {
    this.logger = new Logger('AITextService');
    this.client = null;
    this.gemini = null;
    this.model = null;
    this.geminiModel = null;
    this.providerName = null;

    this._init(credentials);
  }

  _init(credentials) {
    if (credentials && typeof credentials === 'object' && 'credentials' in credentials) {
      this.logger.warn('AITextService received wrapped CredentialManager object; must be unwrapped');
      return;
    }

    const provider = credentials.aiProvider?.provider;
    const apiKey = credentials.aiProvider?.apiKey;
    const model = credentials.aiProvider?.model;

    if (provider && PROVIDERS[provider] && apiKey) {
      this._initOpenAICompatible(PROVIDERS[provider], apiKey, model);
    } else {
      for (const [, preset] of Object.entries(PROVIDERS)) {
        const key = process.env[preset.envKey];
        if (key) {
          this._initOpenAICompatible(preset, key);
          break;
        }
      }
    }

    const geminiKey = credentials.gemini?.apiKey || process.env.GEMINI_API_KEY;
    if (geminiKey) {
      this._initGemini(geminiKey, credentials.gemini?.model || process.env.GEMINI_MODEL);
    }

    if (!this.client && !this.gemini) {
      this.logger.warn('No AI text provider configured — text generation unavailable');
    }
  }

  _initOpenAICompatible(preset, apiKey, model) {
    const baseURL = process.env.OPENAI_BASE_URL || preset.baseURL;
    this.client = new OpenAI({ apiKey, baseURL });
    this.model = model || process.env.OPENAI_MODEL || preset.defaultModel;
    this.providerName = preset.name;
    this.logger.info(`${preset.name} initialized at ${baseURL} (model: ${this.model})`);
  }

  _initGemini(apiKey, model) {
    try {
      const { GoogleGenAI } = require('@google/genai');
      this.gemini = new GoogleGenAI({ apiKey });
      this.geminiModel = model || process.env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL;
      if (!this.providerName) {
        this.providerName = 'Google Gemini';
        this.model = this.geminiModel;
      }
      this.logger.info(`Gemini initialized (model: ${this.geminiModel})`);
    } catch (error) {
      this.logger.error('Failed to initialize Gemini:', error.message);
    }
  }

  async _generateWithGemini(prompt, options = {}) {
    const candidateModels = Array.from(new Set([
      options.model,
      this.geminiModel,
      GEMINI_DEFAULT_MODEL,
      'gemini-3.5-flash',
      'gemini-3.6-flash'
    ].filter(Boolean)));

    const maxTokens = options.maxTokens || 2048;
    const temperature = options.temperature ?? 0.7;

    let lastError = null;
    for (const model of candidateModels) {
      try {
        const config = { maxOutputTokens: maxTokens };
        if (!/^gemini-3\.(?:[5-9]|\d{2,})-/.test(model)) config.temperature = temperature;
        const response = await this.gemini.models.generateContent({
          model,
          contents: prompt,
          config,
        });
        const text = response && response.text;
        if (typeof text === 'string' && text.trim()) {
          return text;
        }
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('Google Gemini returned an empty response. Check the API key and model quota.');
  }

  async generateText(prompt, options = {}) {
    const model = options.model || this.model;
    const maxTokens = options.maxTokens || 2048;
    const temperature = options.temperature ?? 0.7;

    if (this.client) {
      const params = {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
      };

      let response = null;
      try {
        response = await this.client.chat.completions.create({
          ...params,
          max_completion_tokens: maxTokens,
        });
      } catch (error) {
        let failureError = error;
        if (
          error &&
          error.status === 400 &&
          /max(_completion)?_tokens/i.test(error.message || '')
        ) {
          try {
            response = await this.client.chat.completions.create({
              ...params,
              max_tokens: maxTokens,
            });
          } catch (retryErr) {
            failureError = retryErr;
          }
        }

        if (!response) {
          if (this.gemini) {
            this.logger.warn(`Primary provider (${this.providerName}) error: ${failureError.message}. Failing over to Gemini...`);
            return await this._generateWithGemini(prompt, options);
          }
          throw failureError;
        }
      }

      return this._extractContent(response);
    }

    if (this.gemini) {
      return await this._generateWithGemini(prompt, options);
    }

    throw new Error('No AI text provider configured');
  }

  _extractContent(response) {
    const content =
      response &&
      response.choices &&
      response.choices[0] &&
      response.choices[0].message
        ? response.choices[0].message.content
        : null;

    if (typeof content !== 'string' || !content.trim()) {
      // A null/empty body used to surface as cryptic "Unexpected end of JSON input"
      // in the agents' JSON parsers. Report the real cause instead.
      throw new Error(
        `${this.providerName} returned an empty response. Check the API key and model quota.`
      );
    }
    return content;
  }

  isAvailable() {
    return !!(this.client || this.gemini);
  }
}

module.exports = { AITextService, PROVIDERS, GEMINI_MODELS, GEMINI_DEFAULT_MODEL };
