import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import dotenv from 'dotenv';

export interface UnderwriterConfig {
  port: number;
  privateKey: string;
  logLevel?: string;
  blockDelay?: number;
  listener: {
    interval?: number;
    maxBlocks?: number;
  };
  underwriter: {
    retryInterval?: number;
    processingInterval?: number;
    maxTries?: number;
    maxPendingTransactions?: number;
    transactionTimeout?: number;
    gasLimitBuffer?: Record<string, any> & { default: number };
  };
}

export interface AMBConfig {
  name: string;
  globalProperties: Record<string, any>;
}

export interface ChainConfig {
  chainId: string;
  name: string;
  rpc: string;
  blockDelay?: number;
  listener: {
    interval: number;
    maxBlocks: number;
  },
  underwriter: {
    rpc?: string;
    retryInterval?: number;
    processingInterval?: number;
    maxTries?: number;
    maxPendingTransactions?: number;
    transactionTimeout?: number;
    gasLimitBuffer?: Record<string, any> & { default: number };
  }
}

export interface PoolConfig {
  name: string;
  amb: string;
  vaults: {
    name: string;
    chainId: string;
    address: string;
  }[];
}

//TODO config schema verification should not be implemented manually.

@Injectable()
export class ConfigService {
  private readonly rawConfig: Record<string, any>;

  readonly nodeEnv: string;

  readonly underwriterConfig: UnderwriterConfig;
  readonly chainsConfig: Map<string, ChainConfig>;
  readonly ambsConfig: Map<string, AMBConfig>;
  readonly poolsConfig: Map<string, PoolConfig>;

  constructor() {
    this.nodeEnv = this.loadNodeEnv();

    this.loadEnvFile();
    this.rawConfig = this.loadConfigFile();

    this.underwriterConfig = this.loadUnderwriterConfig();
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

  private loadUnderwriterConfig(): UnderwriterConfig {
    const rawUnderwriterConfig = this.rawConfig.underwriter;
    if (rawUnderwriterConfig == undefined) {
      throw new Error(
        "'underwriter' configuration missing on the configuration file",
      );
    }

    if (rawUnderwriterConfig.privateKey == undefined) {
      throw new Error("Invalid underwriter configuration: 'privateKey' missing.");
    }

    if (process.env.UNDERWRITER_PORT == undefined) {
      throw new Error(
        "Invalid underwriter configuration: environment variable 'UNDERWRITER_PORT' missing",
      );
    }

    return {
      port: parseInt(process.env.UNDERWRITER_PORT),
      privateKey: rawUnderwriterConfig.privateKey,
      logLevel: rawUnderwriterConfig.logLevel,
      blockDelay: rawUnderwriterConfig.blockDelay,
      listener: rawUnderwriterConfig.listener ?? {},
      underwriter: rawUnderwriterConfig.underwriter ?? {}
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
      chainConfig.set(rawChainConfig.chainId, {
        chainId: rawChainConfig.chainId.toString(),
        name: rawChainConfig.name,
        rpc: rawChainConfig.rpc,
        blockDelay: rawChainConfig.blockDelay,
        listener: rawChainConfig.listener ?? {},
        underwriter: rawChainConfig.underwriter ?? {},
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
      const globalProperties = rawAMBConfig;
      delete globalProperties['name'];

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
      if (rawPoolsConfig.name == undefined) {
        throw new Error(
          `Invalid pool configuration: 'name' missing.`,
        );
      }

      if (rawPoolsConfig.amb == undefined || !ambNames.includes(rawPoolsConfig.amb)) {
        throw new Error(
          `Invalid pool configuration for pool '${rawPoolsConfig.name}': 'amb' invalid or missing.`,
        );
      }

      const vaults = rawPoolsConfig.vaults ?? [];
      if (vaults.length < 2) {
        throw new Error(
          `Invalid pool configuration for pool '${rawPoolsConfig.name}': at least 2 vaults must be specified.`,
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
        if (vault.address == undefined) {
          throw new Error(
            `Invalid vault configuration for vault '${vault.name}': 'address' missing.`
          );
        }
      }

      poolsConfig.set(rawPoolsConfig.name, {
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
