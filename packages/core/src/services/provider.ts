import { TransformerConstructor, Transformer } from "@/types/transformer";
import {
  LLMProvider,
  RegisterProviderRequest,
  ModelRoute,
  RequestRouteInfo,
  ConfigProvider,
} from "../types/llm";
import { ConfigService } from "./config"; 
import { TransformerService } from "./transformer";

export class ProviderService {
  private providers: Map<string, LLMProvider> = new Map();
  private modelRoutes: Map<string, ModelRoute> = new Map();

  constructor(private readonly configService: ConfigService, private readonly transformerService: TransformerService, private readonly logger: any) {
    this.initializeCustomProviders();
  }

  private initializeCustomProviders() {
    const providersConfig =
      this.configService.get<ConfigProvider[]>("providers");
    if (providersConfig && Array.isArray(providersConfig)) {
      this.initializeFromProvidersArray(providersConfig);
      return;
    }
  }

  private initializeFromProvidersArray(providersConfig: ConfigProvider[]) {
    providersConfig.forEach((providerConfig: ConfigProvider) => {
      try {
        if (
          !providerConfig.name ||
          !providerConfig.api_base_url ||
          !providerConfig.api_key
        ) {
          return;
        }

        this.registerProvider({
          name: providerConfig.name,
          baseUrl: providerConfig.api_base_url,
          apiKey: providerConfig.api_key,
          models: providerConfig.models || [],
          transformer: providerConfig.transformer as any,
        });

        this.logger.info(`${providerConfig.name} provider registered`);
      } catch (error) {
        this.logger.error(`${providerConfig.name} provider registered error: ${error}`);
      }
    });
  }

  // Resolve a raw transformer spec (strings / [name, options] arrays, as
  // received from config.json or the HTTP /providers body) into live
  // Transformer instances. Single resolution path — registerProvider and
  // initializeFromProvidersArray both feed raw specs through this, so HTTP-
  // registered providers get the same transformer wiring as config ones.
  private resolveTransformer(
    raw: ConfigProvider["transformer"]
  ): LLMProvider["transformer"] {
    const resolved: LLMProvider["transformer"] = {};

    for (const key of Object.keys(raw)) {
      // The 'use' key holds the array directly; model-scoped keys hold
      // { use: array }. Same shape distinction as the original inline logic.
      const spec = key === "use" ? raw.use : raw[key]?.use;
      if (!Array.isArray(spec)) continue;

      const instances = spec
        .map((entry) => {
          // [name, options] → new Constructor(options)
          if (Array.isArray(entry) && typeof entry[0] === "string") {
            const Constructor = this.transformerService.getTransformer(entry[0]);
            if (Constructor) {
              return new (Constructor as TransformerConstructor)(entry[1]);
            }
            return undefined;
          }
          // bare name string → instance (constructor) or registered object
          if (typeof entry === "string") {
            const found = this.transformerService.getTransformer(entry);
            if (typeof found === "function") {
              return new (found as TransformerConstructor)();
            }
            return found;
          }
          return undefined;
        })
        .filter((t) => typeof t !== "undefined");

      if (key === "use") {
        resolved.use = instances as Transformer[];
      } else {
        resolved[key] = { use: instances as Transformer[] };
      }
    }

    return resolved;
  }

  registerProvider(request: RegisterProviderRequest): LLMProvider {
    const provider: LLMProvider = {
      ...request,
      // Resolve transformer spec into instances; without this, providers
      // registered via HTTP /providers keep raw strings and their
      // transformers silently no-op at request time.
      transformer: request.transformer
        ? this.resolveTransformer(request.transformer as any)
        : undefined,
    };

    this.providers.set(provider.name, provider);

    request.models.forEach((model) => {
      const fullModel = `${provider.name},${model}`;
      const route: ModelRoute = {
        provider: provider.name,
        model,
        fullModel,
      };
      this.modelRoutes.set(fullModel, route);
      if (!this.modelRoutes.has(model)) {
        this.modelRoutes.set(model, route);
      }
    });

    return provider;
  }

  getProviders(): LLMProvider[] {
    return Array.from(this.providers.values());
  }

  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  updateProvider(
    id: string,
    updates: Partial<LLMProvider>
  ): LLMProvider | null {
    const provider = this.providers.get(id);
    if (!provider) {
      return null;
    }

    const updatedProvider = {
      ...provider,
      ...updates,
      // Re-resolve if a raw transformer spec is supplied via HTTP PUT, so
      // updates don't regress resolved instances back into raw strings.
      transformer: updates.transformer
        ? this.resolveTransformer(updates.transformer as any)
        : provider.transformer,
      updatedAt: new Date(),
    };

    this.providers.set(id, updatedProvider);

    if (updates.models) {
      provider.models.forEach((model) => {
        const fullModel = `${provider.name},${model}`;
        this.modelRoutes.delete(fullModel);
        this.modelRoutes.delete(model);
      });

      updates.models.forEach((model) => {
        const fullModel = `${provider.name},${model}`;
        const route: ModelRoute = {
          provider: provider.name,
          model,
          fullModel,
        };
        this.modelRoutes.set(fullModel, route);
        if (!this.modelRoutes.has(model)) {
          this.modelRoutes.set(model, route);
        }
      });
    }

    return updatedProvider;
  }

  deleteProvider(id: string): boolean {
    const provider = this.providers.get(id);
    if (!provider) {
      return false;
    }

    provider.models.forEach((model) => {
      const fullModel = `${provider.name},${model}`;
      this.modelRoutes.delete(fullModel);
      this.modelRoutes.delete(model);
    });

    this.providers.delete(id);
    return true;
  }

  toggleProvider(name: string, enabled: boolean): boolean {
    const provider = this.providers.get(name);
    if (!provider) {
      return false;
    }
    return true;
  }

  resolveModelRoute(modelName: string): RequestRouteInfo | null {
    const route = this.modelRoutes.get(modelName);
    if (!route) {
      return null;
    }

    const provider = this.providers.get(route.provider);
    if (!provider) {
      return null;
    }

    return {
      provider,
      originalModel: modelName,
      targetModel: route.model,
    };
  }

  getAvailableModelNames(): string[] {
    const modelNames: string[] = [];
    this.providers.forEach((provider) => {
      provider.models.forEach((model) => {
        modelNames.push(model);
        modelNames.push(`${provider.name},${model}`);
      });
    });
    return modelNames;
  }

  getModelRoutes(): ModelRoute[] {
    return Array.from(this.modelRoutes.values());
  }

  private parseTransformerConfig(transformerConfig: any): any {
    if (!transformerConfig) return {};

    if (Array.isArray(transformerConfig)) {
      return transformerConfig.reduce((acc, item) => {
        if (Array.isArray(item)) {
          const [name, config = {}] = item;
          acc[name] = config;
        } else {
          acc[item] = {};
        }
        return acc;
      }, {});
    }

    return transformerConfig;
  }

  async getAvailableModels(): Promise<{
    object: string;
    data: Array<{
      id: string;
      object: string;
      owned_by: string;
      provider: string;
    }>;
  }> {
    const models: Array<{
      id: string;
      object: string;
      owned_by: string;
      provider: string;
    }> = [];

    this.providers.forEach((provider) => {
      provider.models.forEach((model) => {
        models.push({
          id: model,
          object: "model",
          owned_by: provider.name,
          provider: provider.name,
        });

        models.push({
          id: `${provider.name},${model}`,
          object: "model",
          owned_by: provider.name,
          provider: provider.name,
        });
      });
    });

    return {
      object: "list",
      data: models,
    };
  }
}
