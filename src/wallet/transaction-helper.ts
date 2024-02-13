//TODO replace this file with an import from the GeneralisedRelayer once 1) relayer is made public 2) relayer is updated to ethers 6
import { AbstractProvider, FeeData, TransactionResponse, Wallet } from 'ethers';
import pino from 'pino';
import { GasFeeConfig, GasFeeOverrides } from './wallet.types';

const DECIMAL_BASE = 10000;
const DECIMAL_BASE_BIG_INT = BigInt(DECIMAL_BASE);

export const DEFAULT_PRIORITY_ADJUSTMENT_FACTOR = 1.1;
export const MAX_GAS_PRICE_ADJUSTMENT_FACTOR = 5;

export class TransactionHelper {
  private transactionNonce: number;
  private feeData: FeeData | undefined;

  private priorityAdjustmentFactor: bigint;

  // Config for legacy transactions
  private gasPriceAdjustmentFactor: bigint | undefined;
  private maxAllowedGasPrice: bigint | undefined;

  // Config for EIP 1559 transactions
  private maxFeePerGas: bigint | undefined;
  private maxPriorityFeeAdjustmentFactor: bigint | undefined;
  private maxAllowedPriorityFeePerGas: bigint | undefined;

  constructor(
    gasFeeConfig: GasFeeConfig,
    private readonly retryInterval: number,
    private readonly provider: AbstractProvider,
    private readonly wallet: Wallet,
    private readonly logger: pino.Logger,
  ) {
    this.loadGasFeeConfig(gasFeeConfig);
  }

  private loadGasFeeConfig(config: GasFeeConfig): void {
    const {
      gasPriceAdjustmentFactor,
      maxAllowedGasPrice,
      maxFeePerGas,
      maxPriorityFeeAdjustmentFactor,
      maxAllowedPriorityFeePerGas,
      priorityAdjustmentFactor,
    } = config;

    // Config for legacy transactions
    if (gasPriceAdjustmentFactor != undefined) {
      if (gasPriceAdjustmentFactor > MAX_GAS_PRICE_ADJUSTMENT_FACTOR) {
        throw new Error(
          `Failed to load gas fee configuration. 'gasPriceAdjustmentFactor' is larger than the allowed (${MAX_GAS_PRICE_ADJUSTMENT_FACTOR})`,
        );
      }

      this.gasPriceAdjustmentFactor = BigInt(
        gasPriceAdjustmentFactor * DECIMAL_BASE,
      );
    }

    if (maxAllowedGasPrice != undefined) {
      this.maxAllowedGasPrice = BigInt(maxAllowedGasPrice);
    }

    // Config for EIP 1559 transactions
    if (maxPriorityFeeAdjustmentFactor != undefined) {
      if (maxPriorityFeeAdjustmentFactor > MAX_GAS_PRICE_ADJUSTMENT_FACTOR) {
        throw new Error(
          `Failed to load gas fee configuration. 'maxPriorityFeeAdjustmentFactor' is larger than the allowed (${MAX_GAS_PRICE_ADJUSTMENT_FACTOR})`,
        );
      }

      this.maxPriorityFeeAdjustmentFactor = BigInt(
        maxPriorityFeeAdjustmentFactor * DECIMAL_BASE,
      );
    }

    if (maxFeePerGas != undefined) {
      this.maxFeePerGas = BigInt(maxFeePerGas);
    }

    if (maxAllowedPriorityFeePerGas != undefined) {
      this.maxAllowedPriorityFeePerGas = BigInt(
        maxAllowedPriorityFeePerGas,
      );
    }

    // Priority config
    if (priorityAdjustmentFactor != undefined) {
      if (
        priorityAdjustmentFactor > MAX_GAS_PRICE_ADJUSTMENT_FACTOR ||
        priorityAdjustmentFactor < 1
      ) {
        throw new Error(
          `Failed to load gas fee configuration. 'priorityAdjustmentFactor' is larger than the allowed (${MAX_GAS_PRICE_ADJUSTMENT_FACTOR}) or less than 1.`,
        );
      }

      this.priorityAdjustmentFactor = BigInt(
        priorityAdjustmentFactor * DECIMAL_BASE,
      );
    } else {
      this.logger.info(
        `Priority adjustment factor unset. Defaulting to ${DEFAULT_PRIORITY_ADJUSTMENT_FACTOR}`,
      );

      this.priorityAdjustmentFactor = BigInt(
        DEFAULT_PRIORITY_ADJUSTMENT_FACTOR * DECIMAL_BASE,
      );
    }
  }

  async init(): Promise<void> {
    await this.updateTransactionNonce();
    await this.updateFeeData();
  }

  /**
   * Update the transaction nonce of the signer.
   */
  async updateTransactionNonce(): Promise<void> {
    let i = 1;
    while (true) {
      try {
        this.transactionNonce =
          await this.wallet.getNonce('pending'); //TODO 'pending' may not be supported
        break;
      } catch (error) {
        // Continue trying indefinitely. If the transaction count is incorrect, no transaction will go through.
        this.logger.error(`Failed to update nonce for chain (try ${i}).`);
        await new Promise((r) => setTimeout(r, this.retryInterval));
      }

      i++;
    }
  }

  getTransactionNonce(): number {
    return this.transactionNonce;
  }

  increaseTransactionNonce(): void {
    this.transactionNonce++;
  }

  async updateFeeData(): Promise<void> {
    try {
      this.feeData = await this.provider.getFeeData();
    } catch {
      // Continue with stale fee data.
    }
  }

  getFeeDataForTransaction(priority?: boolean): GasFeeOverrides {
    const queriedFeeData = this.feeData;
    if (queriedFeeData == undefined) {
      return {};
    }

    const queriedMaxPriorityFeePerGas = queriedFeeData.maxPriorityFeePerGas;
    if (queriedMaxPriorityFeePerGas != null) {
      // Set fee data for an EIP 1559 transactions
      let maxFeePerGas = this.maxFeePerGas;

      // Adjust the 'maxPriorityFeePerGas' by the adjustment factor
      let maxPriorityFeePerGas;
      if (this.maxPriorityFeeAdjustmentFactor != undefined) {
        maxPriorityFeePerGas = queriedMaxPriorityFeePerGas
          * this.maxPriorityFeeAdjustmentFactor
          / DECIMAL_BASE_BIG_INT;
      }

      // Apply the max allowed 'maxPriorityFeePerGas'
      if (
        maxPriorityFeePerGas != undefined &&
        this.maxAllowedPriorityFeePerGas != undefined &&
        this.maxAllowedPriorityFeePerGas < maxPriorityFeePerGas
      ) {
        maxPriorityFeePerGas = this.maxAllowedPriorityFeePerGas;
      }

      if (priority) {
        if (maxFeePerGas != undefined) {
          maxFeePerGas = maxFeePerGas * this.priorityAdjustmentFactor / DECIMAL_BASE_BIG_INT;
        }

        if (maxPriorityFeePerGas != undefined) {
          maxPriorityFeePerGas = maxPriorityFeePerGas * this.priorityAdjustmentFactor / DECIMAL_BASE_BIG_INT;
        }
      }

      return {
        maxFeePerGas,
        maxPriorityFeePerGas,
      };
    } else {
      // Set traditional gasPrice
      const queriedGasPrice = queriedFeeData.gasPrice;
      if (queriedGasPrice == null) return {};

      // Adjust the 'gasPrice' by the adjustment factor
      let gasPrice;
      if (this.gasPriceAdjustmentFactor != undefined) {
        gasPrice = queriedGasPrice
          * this.gasPriceAdjustmentFactor
          / DECIMAL_BASE_BIG_INT;
      }

      // Apply the max allowed 'gasPrice'
      if (
        gasPrice != undefined &&
        this.maxAllowedGasPrice != undefined &&
        this.maxAllowedGasPrice < gasPrice
      ) {
        gasPrice = this.maxAllowedGasPrice;
      }

      if (priority && gasPrice != undefined) {
        gasPrice = gasPrice
          * this.priorityAdjustmentFactor
          / DECIMAL_BASE_BIG_INT;
      }

      return {
        gasPrice,
      };
    }
  }

  getIncreasedFeeDataForTransaction(
    originalTx: TransactionResponse,
  ): GasFeeOverrides {
    const priorityFees = this.getFeeDataForTransaction(true);

    const gasPrice = this.getLargestFee(
      originalTx.gasPrice,
      priorityFees.gasPrice,
    );
    const maxFeePerGas = this.getLargestFee(
      originalTx.maxFeePerGas,
      priorityFees.maxFeePerGas,
    );
    const maxPriorityFeePerGas = this.getLargestFee(
      originalTx.maxPriorityFeePerGas,
      priorityFees.maxPriorityFeePerGas,
    );

    if (
      gasPrice == undefined &&
      maxFeePerGas == undefined &&
      maxPriorityFeePerGas == undefined
    ) {
      this.logger.warn(
        { tx: originalTx },
        `Failed to compute increased fee data for tx. All fee values returned 'undefined'.`,
      );
    }

    return {
      gasPrice,
      maxFeePerGas,
      maxPriorityFeePerGas,
    };
  }

  // If 'previousFee' exists, return the largest of:
  // - previousFee * priorityAdjustmentFactor
  // - priorityFee
  private getLargestFee(
    previousFee: bigint | null | undefined,
    priorityFee: bigint | null | undefined,
  ): bigint | undefined {
    if (previousFee != undefined) {
      const increasedPreviousFee = previousFee
        * this.priorityAdjustmentFactor
        / DECIMAL_BASE_BIG_INT;

      if (priorityFee == undefined || increasedPreviousFee > priorityFee) {
        return increasedPreviousFee;
      } else {
        return priorityFee;
      }
    }

    return undefined;
  }
}
