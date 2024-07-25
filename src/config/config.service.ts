import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import dotenv from 'dotenv';
import { getConfigValidator } from './config.schema';
import { GlobalConfig, ChainConfig, AMBConfig, MonitorGlobalConfig, ListenerGlobalConfig, UnderwriterGlobalConfig, ExpirerGlobalConfig, WalletGlobalConfig, MonitorConfig, ListenerConfig, UnderwriterConfig, WalletConfig, ExpirerConfig, TokensConfig, EndpointConfig, VaultTemplateConfig, RelayDeliveryCosts } from './config.types';
import { loadPrivateKeyLoader } from './privateKeyLoaders/privateKeyLoader';
import { JsonRpcProvider } from 'ethers';

@Injectable()
export class ConfigService {
    private readonly rawConfig: Record<string, any>;

    readonly nodeEnv: string;

    readonly globalConfig: GlobalConfig;
    readonly chainsConfig: Map<string, ChainConfig>;
    readonly ambsConfig: Map<string, AMBConfig>;
    readonly endpointsConfig: Map<string, EndpointConfig[]>;

    readonly isReady: Promise<void>;

    constructor() {
        this.nodeEnv = this.loadNodeEnv();

        this.loadEnvFile();
        this.rawConfig = this.loadConfigFile();

        this.globalConfig = this.loadGlobalConfig();
        this.chainsConfig = this.loadChainsConfig();
        this.ambsConfig = this.loadAMBsConfig();

        const ambNames = Array.from(this.ambsConfig.keys());
        const chainIds = Array.from(this.chainsConfig.keys());
        this.endpointsConfig = this.loadEndpointsConfig(chainIds, ambNames);

        this.isReady = this.initialize();
    }


    // NOTE: The OnModuleInit hook is not being used as it does not guarantee the order in which it
    // is executed across services (i.e. there is no guarantee that the config service will be the
    // first to initialize). The `isReady` promise must be awaited on the underwriter initialization.
    private async initialize(): Promise<void> {
        await this.validateChainIds(this.chainsConfig);
    }

    private loadNodeEnv(): string {
        const nodeEnv = process.env['NODE_ENV'];

        if (nodeEnv == undefined) {
            throw new Error(
                'Unable to load the underwriter configuration, `NODE_ENV` environment variable is not set.',
            );
        }

        return nodeEnv;
    }

    private loadEnvFile(): void {
        dotenv.config();
    }

    private loadConfigFile(): Record<string, any> {
        const configFileName = `config.${this.nodeEnv}.yaml`;

        let rawConfig;
        try {
            rawConfig = readFileSync(configFileName, 'utf-8');
        } catch (error: any) {
            throw new Error(
                'Unable to load the underwriter configuration file ${configFileName}. Cause: ' +
                error.message,
            );
        }

        const config = yaml.load(rawConfig) as Record<string, any>;

        this.validateConfig(config);
        return config;
    }

    private validateConfig(config: any): void {
        const validator = getConfigValidator();
        const isConfigValid = validator(config);

        if (!isConfigValid) {
            const error = validator.errors;
            console.error('Config validation failed:', error);
            throw new Error(
                'Config validation failed.'
            );
        }
    }

    private async loadPrivateKey(rawPrivateKeyConfig: any): Promise<string> {
        if (typeof rawPrivateKeyConfig === "string") {
            //NOTE: Using 'console.warn' as the logger is not available at this point.  //TODO use logger
            console.warn('WARNING: the privateKey has been loaded from the configuration file. Consider storing the privateKey using an alternative safer method.')
            return rawPrivateKeyConfig;
        }

        const privateKeyLoader = loadPrivateKeyLoader(
            rawPrivateKeyConfig?.['loader'] ?? null,
            rawPrivateKeyConfig ?? {},
        );

        return privateKeyLoader.load();
    }

    private loadGlobalConfig(): GlobalConfig {
        const rawGlobalConfig = this.rawConfig['global'];

        if (process.env['UNDERWRITER_PORT'] == undefined) {
            throw new Error(
                "Invalid configuration: environment variable 'UNDERWRITER_PORT' missing",
            );
        }

        return {
            port: parseInt(process.env['UNDERWRITER_PORT']),
            privateKey: this.loadPrivateKey(rawGlobalConfig.privateKey),
            logLevel: rawGlobalConfig.logLevel,
            monitor: this.formatMonitorGlobalConfig(rawGlobalConfig.monitor),
            listener: this.formatListenerGlobalConfig(rawGlobalConfig.listener),
            underwriter: this.formatUnderwriterGlobalConfig(rawGlobalConfig.underwriter),
            expirer: this.formatExpirerGlobalConfig(rawGlobalConfig.expirer),
            wallet: this.formatWalletGlobalConfig(rawGlobalConfig.wallet),
        };
    }

    private loadChainsConfig(): Map<string, ChainConfig> {
        const chainConfig = new Map<string, ChainConfig>();

        for (const rawChainConfig of this.rawConfig['chains']) {
            const chainId = rawChainConfig.chainId.toString();
            chainConfig.set(chainId, {
                chainId,
                name: rawChainConfig.name,
                rpc: rawChainConfig.rpc,
                resolver: rawChainConfig.resolver ?? null,
                tokens: this.formatTokensConfig(rawChainConfig.tokens),
                monitor: this.formatMonitorConfig(rawChainConfig.monitor),
                listener: this.formatListenerConfig(rawChainConfig.listener),
                underwriter: this.formatUnderwriterConfig(rawChainConfig.underwriter),
                expirer: this.formatExpirerConfig(rawChainConfig.expirer),
                wallet: this.formatWalletConfig(rawChainConfig.wallet)
            });
        }

        return chainConfig;
    }

    private loadAMBsConfig(): Map<string, AMBConfig> {
        const ambConfig = new Map<string, AMBConfig>();

        for (const rawAMBConfig of this.rawConfig['ambs']) {

            const ambName = rawAMBConfig.name;

            if (rawAMBConfig.enabled == false) {
                continue;
            }

            const globalProperties = rawAMBConfig;

            if (ambConfig.has(ambName)) {
                throw new Error(`Provided 'ambs' configuration is invalid: amb is specified multiple times. ('${ambName}')`);
            }

            ambConfig.set(ambName, {
                name: ambName,
                relayPrioritisation: rawAMBConfig.relayPrioritisation != false,
                globalProperties,
            });
        }

        return ambConfig;
    }

    private loadEndpointsConfig(chainIds: string[], ambNames: string[]): Map<string, EndpointConfig[]> {
        const endpointConfig: Map<string, EndpointConfig[]> = new Map();

        for (const rawEndpointConfig of this.rawConfig['endpoints']) {

            const chainId = rawEndpointConfig.chainId.toString();

            if (!chainIds.includes(chainId)) {
                throw new Error(
                    `Invalid endpoint configuration: invalid 'chainId' value (chain configuration does not exist for ${chainId}).`,
                );
            }

            if (!ambNames.includes(rawEndpointConfig.amb)) {
                throw new Error(
                    `Invalid endpoint configuration: invalid 'amb' value (${rawEndpointConfig.amb}).`,
                );
            }


            const factoryAddress = rawEndpointConfig.factoryAddress.toLowerCase();
            const interfaceAddress = rawEndpointConfig.interfaceAddress.toLowerCase();
            const incentivesAddress = rawEndpointConfig.incentivesAddress.toLowerCase();

            const channelsOnDestination: Record<string, string> = {};
            for (const [channelChainId, channelId] of Object.entries(rawEndpointConfig.channelsOnDestination)) {
                channelsOnDestination[channelChainId] = (channelId as string).toLowerCase();
            }

            const vaultTemplates: VaultTemplateConfig[] = [];
            for (const rawVaultTemplateConfig of rawEndpointConfig.vaultTemplates) {
                vaultTemplates.push({
                    name: rawVaultTemplateConfig.name,
                    address: rawVaultTemplateConfig.address.toLowerCase()
                });
            }

            let relayDeliveryCosts: RelayDeliveryCosts | undefined;
            if (rawEndpointConfig.relayDeliveryCosts != undefined) {
                relayDeliveryCosts = {
                    gasUsage: BigInt(rawEndpointConfig.relayDeliveryCosts.gasUsage),
                    gasObserved: rawEndpointConfig.relayDeliveryCosts.gasObserved != undefined
                        ? BigInt(rawEndpointConfig.relayDeliveryCosts.gasObserved)
                        : undefined,
                    fee: rawEndpointConfig.relayDeliveryCosts.fee != undefined
                        ? BigInt(rawEndpointConfig.relayDeliveryCosts.fee)
                        : undefined,
                    value: rawEndpointConfig.relayDeliveryCosts.value != undefined
                        ? BigInt(rawEndpointConfig.relayDeliveryCosts.value)
                        : undefined
                };
            }


            const currentEndpoints = endpointConfig.get(chainId) ?? [];

            const conflictingEndpointExists = currentEndpoints.some((endpoint) => {
                return endpoint.interfaceAddress == interfaceAddress;
            });
            if (conflictingEndpointExists) {
                throw new Error(
                    `Invalid endpoint configuration: interface defined multiple times on the same chain (interface: ${interfaceAddress}, chain: ${chainId}).`,
                );
            }

            currentEndpoints.push({
                name: rawEndpointConfig.name,
                amb: rawEndpointConfig.amb,
                chainId,
                factoryAddress,
                interfaceAddress,
                incentivesAddress,
                channelsOnDestination,
                vaultTemplates,
                relayDeliveryCosts,
            });
            endpointConfig.set(chainId, currentEndpoints);
        }

        return endpointConfig;
    }

    getAMBConfig<T = unknown>(amb: string, key: string, chainId?: string): T {
        // Find if there is a chain-specific override for the AMB property.
        if (chainId != undefined) {
            const chainOverride = this.rawConfig['chains'].find(
                (rawChainConfig: any) => rawChainConfig.chainId.toString() == chainId,
            )?.[amb]?.[key];

            if (chainOverride != undefined) return chainOverride;
        }

        // If there is no chain-specific override, return the default value for the property.
        return this.ambsConfig.get(amb)?.globalProperties[key];
    }

    private async validateChainIds(chainsConfig: Map<string, ChainConfig>): Promise<void> {

        const validationPromises = [];
        for (const [chainId, config] of chainsConfig) {
            const provider = new JsonRpcProvider(config.rpc, undefined, { staticNetwork: true });
            const validationPromise = provider.getNetwork().then(
                (network) => {
                    const rpcChainId = network.chainId.toString();
                    if (rpcChainId !== chainId) {
                        throw new Error(`Error validating the chain ID of chain ${chainId}: the RPC chain ID is ${rpcChainId}.`)
                    }
                }
            )
            validationPromises.push(validationPromise);
        }

        await Promise.all(validationPromises);
    }


    // Formatting helpers
    // ********************************************************************************************

    private formatMonitorGlobalConfig(rawConfig: any): MonitorGlobalConfig {
        return { ...rawConfig } as MonitorGlobalConfig;
    }

    private formatListenerGlobalConfig(rawConfig: any): ListenerGlobalConfig {
        return { ...rawConfig } as ListenerGlobalConfig;
    }

    private formatUnderwriterGlobalConfig(rawConfig: any): UnderwriterGlobalConfig {
        const config = { ...rawConfig };
        if (config.minRelayDeadlineDuration != undefined) {
            config.minRelayDeadlineDuration = BigInt(config.minRelayDeadlineDuration);
        }
        if (config.lowTokenBalanceWarning != undefined) {
            config.lowTokenBalanceWarning = BigInt(config.lowTokenBalanceWarning);
        }
        if (config.relayDeliveryCosts != undefined) {
            const costs = config.relayDeliveryCosts;
            costs.gasUsage = BigInt(costs.gasUsage);
            if (costs.gasObserved != undefined) {
                costs.gasObserved = BigInt(costs.gasObserved);
            }
            if (costs.fee != undefined) {
                costs.fee = BigInt(costs.fee);
            }
            if (costs.value != undefined) {
                costs.value = BigInt(costs.value);
            }
        }
        return config as UnderwriterGlobalConfig;
    }

    private formatExpirerGlobalConfig(rawConfig: any): ExpirerGlobalConfig {
        return { ...rawConfig } as ExpirerGlobalConfig;
    }

    private formatWalletGlobalConfig(rawConfig: any): WalletGlobalConfig {
        const config = { ...rawConfig };
        if (config.lowGasBalanceWarning != undefined) {
            config.lowGasBalanceWarning = BigInt(config.lowGasBalanceWarning);
        }
        if (config.maxFeePerGas != undefined) {
            config.maxFeePerGas = BigInt(config.maxFeePerGas);
        }
        if (config.maxAllowedPriorityFeePerGas != undefined) {
            config.maxAllowedPriorityFeePerGas = BigInt(config.maxAllowedPriorityFeePerGas);
        }
        if (config.maxAllowedGasPrice != undefined) {
            config.maxAllowedGasPrice = BigInt(config.maxAllowedGasPrice);
        }
        return config as WalletGlobalConfig;
    }


    private formatMonitorConfig(rawConfig: any): MonitorConfig {
        return this.formatMonitorGlobalConfig(rawConfig);
    }

    private formatListenerConfig(rawConfig: any): ListenerConfig {
        return this.formatListenerGlobalConfig(rawConfig);
    }

    private formatUnderwriterConfig(rawConfig: any): UnderwriterConfig {
        const config = this.formatUnderwriterGlobalConfig(rawConfig) as UnderwriterConfig;
        config.minMaxGasDelivery = BigInt(config.minMaxGasDelivery);
        return config;
    }

    private formatWalletConfig(rawConfig: any): WalletConfig {
        return this.formatWalletGlobalConfig(rawConfig);
    }

    private formatExpirerConfig(rawConfig: any): ExpirerConfig {
        return this.formatExpirerGlobalConfig(rawConfig);
    }

    private formatTokensConfig(rawConfig: any): TokensConfig {
        const config: TokensConfig = {};
        for (const rawTokenConfig of rawConfig) {

            const tokenConfig = { ...rawTokenConfig };
            if (tokenConfig.allowanceBuffer != undefined) {
                tokenConfig.allowanceBuffer = BigInt(tokenConfig.allowanceBuffer);
            }
            if (tokenConfig.lowTokenBalanceWarning != undefined) {
                tokenConfig.lowTokenBalanceWarning = BigInt(tokenConfig.lowTokenBalanceWarning);
            }

            config[rawTokenConfig.address.toLowerCase()] = tokenConfig;
        }

        return config;
    }
}
