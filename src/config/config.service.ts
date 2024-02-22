import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import dotenv from 'dotenv';

export interface GlobalConfig {
  port: number;
  privateKey: string;
  logLevel?: string;
  blockDelay?: number;
  monitor: MonitorGlobalConfig;
  listener: ListenerGlobalConfig;
  underwriter: UnderwriterGlobalConfig;
  expirer: ExpirerGlobalConfig;
  wallet: WalletGlobalConfig;
}

export interface AMBConfig {
  name: string;
  globalProperties: Record<string, any>;
}

export interface ChainConfig {
  chainId: string;
  name: string;
  rpc: string;
  startingBlock?: number;
  blockDelay?: number;
  monitor: MonitorConfig;
  listener: ListenerConfig;
  underwriter: UnderwriterConfig;
  expirer: ExpirerConfig;
  wallet: WalletConfig;
}

export interface MonitorGlobalConfig {
  interval?: number;
}

export interface MonitorConfig extends MonitorGlobalConfig {}

export interface ListenerGlobalConfig {
  processingInterval?: number;
  maxBlocks?: number;
}

export interface ListenerConfig extends ListenerGlobalConfig {}

export interface UnderwriterGlobalConfig {
  retryInterval?: number;
  processingInterval?: number;
  maxTries?: number;
  maxPendingTransactions?: number;
}

export interface UnderwriterConfig extends UnderwriterGlobalConfig {
}

export interface ExpirerGlobalConfig {
  retryInterval?: number;
  processingInterval?: number;
  maxTries?: number;
  maxPendingTransactions?: number;
  expireBlocksMargin?: number;
}

export interface ExpirerConfig extends ExpirerGlobalConfig {
}

export interface WalletGlobalConfig {
  retryInterval?: number;
  processingInterval?: number;
  maxTries?: number;
  maxPendingTransactions?: number;
  confirmations?: number;
  confirmationTimeout?: number;
  maxFeePerGas?: number | string;
  maxAllowedPriorityFeePerGas?: number | string;
  maxPriorityFeeAdjustmentFactor?: number;
  maxAllowedGasPrice?: number | string;
  gasPriceAdjustmentFactor?: number;
  priorityAdjustmentFactor?: number;
}

export interface WalletConfig extends WalletGlobalConfig {
  rpc?: string;
}

export interface PoolConfig {
  id: string;
  name: string;
  amb: string;
  vaults: {
    name: string;
    chainId: string;
    vaultAddress: string;
    interfaceAddress: string;
    channels: Record<string, string>;
  }[];
}

//TODO config schema verification should not be implemented manually.

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

        return yaml.load(rawConfig) as Record<string, any>;
    }

    private loadGlobalConfig(): GlobalConfig {
        const rawGlobalConfig = this.rawConfig.global;
        if (rawGlobalConfig == undefined) {
            throw new Error(
                "'global' configuration missing on the configuration file",
            );
        }

        if (rawGlobalConfig.privateKey == undefined) {
            throw new Error("Invalid global configuration: 'privateKey' missing.");
        }

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
            monitor: rawGlobalConfig.monitor ?? {},
            listener: rawGlobalConfig.listener ?? {},
            underwriter: rawGlobalConfig.underwriter ?? {},
            expirer: rawGlobalConfig.expirer ?? {},
            wallet: rawGlobalConfig.wallet ?? {}
        };
    }

    private loadChainsConfig(): Map<string, ChainConfig> {
        const chainConfig = new Map<string, ChainConfig>();

        for (const rawChainConfig of this.rawConfig.chains) {
            if (rawChainConfig.chainId == undefined) {
                throw new Error(`Invalid chain configuration: 'chainId' missing.`);
            }
            if (rawChainConfig.name == undefined) {
                throw new Error(
                    `Invalid chain configuration for chain '${rawChainConfig.chainId}': 'name' missing.`,
                );
            }
            if (rawChainConfig.rpc == undefined) {
                throw new Error(
                    `Invalid chain configuration for chain '${rawChainConfig.chainId}': 'rpc' missing.`,
                );
            }
            chainConfig.set(rawChainConfig.chainId.toString(), {
                chainId: rawChainConfig.chainId.toString(),
                name: rawChainConfig.name,
                rpc: rawChainConfig.rpc,
                startingBlock: rawChainConfig.startingBlock,
                blockDelay: rawChainConfig.blockDelay,
                monitor: rawChainConfig.monitor ?? {},          //TODO 'monitor' object should be verified
                listener: rawChainConfig.listener ?? {},        //TODO 'listener' object should be verified
                underwriter: rawChainConfig.underwriter ?? {},  //TODO 'underwriter' object should be verified
                expirer: rawChainConfig.expirer ?? {},          //TODO 'expirer' object should be verified
                wallet: rawChainConfig.wallet ?? {},            //TODO 'wallet' object should be verified
            });
        }

        return chainConfig;
    }

    private loadAMBsConfig(): Map<string, AMBConfig> {
        const ambConfig = new Map<string, AMBConfig>();

        for (const rawAMBConfig of this.rawConfig.ambs) {

            const ambName = rawAMBConfig.name;

            if (ambName == undefined) {
                throw new Error(`Invalid AMB configuration: 'name' missing.`);
            }

            if (rawAMBConfig.enabled == false) {
                continue;
            }

            const globalProperties = rawAMBConfig;

            ambConfig.set(ambName, {
                name: ambName,
                globalProperties,
            });
        }

        return ambConfig;
    }

    private loadPoolsConfig(ambNames: string[]): Map<string, PoolConfig> {
        const poolsConfig = new Map<string, PoolConfig>();

        for (const rawPoolsConfig of this.rawConfig.pools) {
            if (rawPoolsConfig.id == undefined) {
                throw new Error(
                    `Invalid pool configuration: 'id' missing.`,
                );
            }

            if (rawPoolsConfig.name == undefined) {
                throw new Error(
                    `Invalid pool configuration for pool '${rawPoolsConfig.id}': 'name' missing.`,
                );
            }

            if (rawPoolsConfig.amb == undefined || !ambNames.includes(rawPoolsConfig.amb)) {
                throw new Error(
                    `Invalid pool configuration for pool '${rawPoolsConfig.id}': 'amb' invalid or missing.`,
                );
            }

            const vaults = rawPoolsConfig.vaults ?? [];
            if (vaults.length < 2) {
                throw new Error(
                    `Invalid pool configuration for pool '${rawPoolsConfig.id}': at least 2 vaults must be specified.`,
                );
            }
            for (const vault of vaults) {
                if (vault.name == undefined) {
                    throw new Error(
                        `Invalid vault configuration': 'name' missing.`,
                    );
                }
                if (vault.chainId == undefined) {
                    throw new Error(
                        `Invalid vault configuration for vault '${vault.name}': 'chainId' missing.`
                    );
                }
                if (vault.vaultAddress == undefined) {
                    throw new Error(
                        `Invalid vault configuration for vault '${vault.name}': 'vaultAddress' missing.`
                    );
                }
                if (vault.interfaceAddress == undefined) {
                    throw new Error(
                        `Invalid vault configuration for vault '${vault.name}': 'interfaceAddress' missing.`
                    );
                }
                if (vault.channels == undefined) {
                    throw new Error(
                        `Invalid vault configuration for vault '${vault.name}': 'channels' missing.`
                    );
                }

                // Make sure 'chainId's are always strings
                vault.chainId = vault.chainId.toString();

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
}
