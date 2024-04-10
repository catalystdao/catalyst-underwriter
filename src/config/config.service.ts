import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import dotenv from 'dotenv';
import { getConfigValidator } from './config-schemas';
import { GlobalConfig, ChainConfig, AMBConfig, MonitorGlobalConfig, ListenerGlobalConfig, UnderwriterGlobalConfig, ExpirerGlobalConfig, WalletGlobalConfig, MonitorConfig, ListenerConfig, UnderwriterConfig, WalletConfig, ExpirerConfig, TokensConfig, EndpointConfig, VaultTemplateConfig } from './config.types';


@Injectable()
export class ConfigService {
    private readonly rawConfig: Record<string, any>;

    readonly nodeEnv: string;

    readonly globalConfig: GlobalConfig;
    readonly chainsConfig: Map<string, ChainConfig>;
    readonly ambsConfig: Map<string, AMBConfig>;
    readonly endpointsConfig: Map<string, EndpointConfig[]>;

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
    }

    private loadNodeEnv(): string {
        const nodeEnv = process.env.NODE_ENV;

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
        } catch (error) {
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

    private loadGlobalConfig(): GlobalConfig {
        const rawGlobalConfig = this.rawConfig.global;

        if (process.env.UNDERWRITER_PORT == undefined) {
            throw new Error(
                "Invalid configuration: environment variable 'UNDERWRITER_PORT' missing",
            );
        }

        return {
            port: parseInt(process.env.UNDERWRITER_PORT),
            privateKey: rawGlobalConfig.privateKey,
            logLevel: rawGlobalConfig.logLevel,
            blockDelay: rawGlobalConfig.blockDelay,
            monitor: this.formatMonitorGlobalConfig(rawGlobalConfig.monitor),
            listener: this.formatListenerGlobalConfig(rawGlobalConfig.listener),
            underwriter: this.formatUnderwriterGlobalConfig(rawGlobalConfig.underwriter),
            expirer: this.formatExpirerGlobalConfig(rawGlobalConfig.expirer),
            wallet: this.formatWalletGlobalConfig(rawGlobalConfig.wallet),
        };
    }

    private loadChainsConfig(): Map<string, ChainConfig> {
        const chainConfig = new Map<string, ChainConfig>();

        for (const rawChainConfig of this.rawConfig.chains) {
            chainConfig.set(rawChainConfig.chainId.toString(), {
                chainId: rawChainConfig.chainId.toString(),
                name: rawChainConfig.name,
                rpc: rawChainConfig.rpc,
                blockDelay: rawChainConfig.blockDelay,
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

        for (const rawAMBConfig of this.rawConfig.ambs) {

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

        for (const rawEndpointConfig of this.rawConfig.endpoints) {

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
            });
            endpointConfig.set(chainId, currentEndpoints);
        }

        return endpointConfig;
    }

    getAMBConfig<T = unknown>(amb: string, key: string, chainId?: string): T {
    // Find if there is a chain-specific override for the AMB property.
        if (chainId != undefined) {
            const chainOverride = this.rawConfig.chains.find(
                (rawChainConfig: any) => rawChainConfig.chainId == chainId,
            )?.[amb]?.[key];

            if (chainOverride != undefined) return chainOverride;
        }

        // If there is no chain-specific override, return the default value for the property.
        return this.ambsConfig.get(amb)?.globalProperties[key];
    }


    // Formatting helpers
    // ********************************************************************************************

    private formatMonitorGlobalConfig(rawConfig: any): MonitorGlobalConfig {
        return {...rawConfig} as MonitorGlobalConfig;
    }

    private formatListenerGlobalConfig(rawConfig: any): ListenerGlobalConfig {
        return {...rawConfig} as ListenerGlobalConfig;
    }

    private formatUnderwriterGlobalConfig(rawConfig: any): UnderwriterGlobalConfig {
        const config = {...rawConfig};
        if (config.minRelayDeadlineDuration != undefined) {
            config.minRelayDeadlineDuration = BigInt(config.minRelayDeadlineDuration);
        }
        if (config.maxUnderwriteAllowed != undefined) {
            config.maxUnderwriteAllowed = BigInt(config.maxUnderwriteAllowed);
        }
        if (config.minUnderwriteReward != undefined) {
            config.minUnderwriteReward = BigInt(config.minUnderwriteReward);
        }
        if (config.lowTokenBalanceWarning != undefined) {
            config.lowTokenBalanceWarning = BigInt(config.lowTokenBalanceWarning);
        }
        return config as UnderwriterGlobalConfig;
    }

    private formatExpirerGlobalConfig(rawConfig: any): ExpirerGlobalConfig {
        return {...rawConfig} as ExpirerGlobalConfig;
    }

    private formatWalletGlobalConfig(rawConfig: any): WalletGlobalConfig {
        const config = {...rawConfig};
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

            const tokenConfig = {...rawTokenConfig};
            if (tokenConfig.allowanceBuffer != undefined) {
                tokenConfig.allowanceBuffer = BigInt(tokenConfig.allowanceBuffer);
            }
            if (tokenConfig.maxUnderwriteAllowed != undefined) {
                tokenConfig.maxUnderwriteAllowed = BigInt(tokenConfig.maxUnderwriteAllowed);
            }
            if (tokenConfig.minUnderwriteReward != undefined) {
                tokenConfig.minUnderwriteReward = BigInt(tokenConfig.minUnderwriteReward);
            }
            if (tokenConfig.lowTokenBalanceWarning != undefined) {
                tokenConfig.lowTokenBalanceWarning = BigInt(tokenConfig.lowTokenBalanceWarning);
            }

            config[rawTokenConfig.address.toLowerCase()] = tokenConfig;
        }

        return config;
    }
}
