import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import dotenv from 'dotenv';
import { getConfigValidator } from './config-schemas';
import { GlobalConfig, ChainConfig, AMBConfig, PoolConfig, MonitorGlobalConfig, ListenerGlobalConfig, UnderwriterGlobalConfig, ExpirerGlobalConfig, WalletGlobalConfig, MonitorConfig, ListenerConfig, UnderwriterConfig, WalletConfig, ExpirerConfig, TokensConfig } from './config.types';


@Injectable()
export class ConfigService {
    private readonly rawConfig: Record<string, any>;

    readonly nodeEnv: string;

    readonly globalConfig: GlobalConfig;
    readonly chainsConfig: Map<string, ChainConfig>;
    readonly ambsConfig: Map<string, AMBConfig>;
    readonly poolsConfig: Map<string, PoolConfig>;

    constructor() {
        this.nodeEnv = this.loadNodeEnv();

        this.loadEnvFile();
        this.rawConfig = this.loadConfigFile();

        this.globalConfig = this.loadGlobalConfig();
        this.chainsConfig = this.loadChainsConfig();
        this.ambsConfig = this.loadAMBsConfig();

        const ambNames = Array.from(this.ambsConfig.keys());
        this.poolsConfig = this.loadPoolsConfig(ambNames);
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

            //TODO check the defined 'name's are unique.

            ambConfig.set(ambName, {
                name: ambName,
                relayPrioritisation: rawAMBConfig.relayPrioritisation != false,
                globalProperties,
            });
        }

        return ambConfig;
    }

    private loadPoolsConfig(ambNames: string[]): Map<string, PoolConfig> {
        const poolsConfig = new Map<string, PoolConfig>();

        for (const rawPoolsConfig of this.rawConfig.pools) {

            if (!ambNames.includes(rawPoolsConfig.amb)) {
                throw new Error(
                    `Invalid pool configuration for pool '${rawPoolsConfig.id}': 'amb' value invalid.`,
                );
            }

            const vaults = rawPoolsConfig.vaults;
            for (const vault of vaults) {

                // Make sure 'chainId's are always strings
                vault.chainId = vault.chainId.toString();

                //TODO verify the 'chainId's are valid (i.e. they are defined on the 'chains' config)
                //TODO verify the 'channels' mapping is exhaustive
                const transformedChannels: Record<string, string> = {};
                for (const [channelId, chainId] of Object.entries(vault.channels)) {
                    transformedChannels[channelId] = (chainId as number).toString();
                }
                vault.channels = transformedChannels;

                // Make sure all connected vaults have their channel mapped
                // ! TODO make sure all channels are unique and that all channels are mapped 
            }

            poolsConfig.set(rawPoolsConfig.id.toString(), {
                id: rawPoolsConfig.id,
                name: rawPoolsConfig.name,
                amb: rawPoolsConfig.amb,
                vaults
            });
        }

        return poolsConfig;

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
        return config as WalletGlobalConfig;
    }


    private formatMonitorConfig(rawConfig: any): MonitorConfig {
        return this.formatMonitorGlobalConfig(rawConfig);
    }

    private formatListenerConfig(rawConfig: any): ListenerConfig {
        return this.formatListenerGlobalConfig(rawConfig);
    }

    private formatUnderwriterConfig(rawConfig: any): UnderwriterConfig {
        return this.formatUnderwriterGlobalConfig(rawConfig);
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
