import { AbstractProvider } from "ethers";
import pino from "pino";
import { Token, Token__factory } from "src/contracts";
import { BalanceConfig } from "src/wallet/wallet.types";

export class BalanceHandler {
    private walletBalance: bigint;
    private transactionsSinceLastBalanceUpdate: number = 0;
    private isBalanceLow: boolean = false;

    private lowBalanceWarning: bigint | undefined;
    private balanceUpdateInterval: number;

    private tokenContract: Token;

    constructor(
        balanceConfig: BalanceConfig,
        private readonly tokenAddress: string,
        private readonly walletAddress: string,
        private readonly retryInterval: number,
        private readonly provider: AbstractProvider,
        private readonly logger: pino.Logger,
    ) {
        this.loadBalanceConfig(balanceConfig);
        this.tokenContract = this.initializeTokenContract(
            this.tokenAddress,
            this.provider
        );
    }


    // Initialization helpers
    // ********************************************************************************************
    private loadBalanceConfig(config: BalanceConfig): void {
        this.lowBalanceWarning = config.lowBalanceWarning;
        this.balanceUpdateInterval = config.balanceUpdateInterval;
    }

    private initializeTokenContract(
        tokenAddress: string,
        provider: AbstractProvider
    ): Token {
        return Token__factory.connect(tokenAddress, provider);
    }


    // External handlers
    // ********************************************************************************************
    async init(): Promise<void> {
        await this.updateWalletBalance();
    }
  
    async updateWalletBalance(): Promise<void> {
        let i = 0;
        let walletBalance;
        while (walletBalance == undefined) {
            try {
                walletBalance = await this.tokenContract.balanceOf(
                    this.walletAddress,
                    { blockTag: 'pending' } // ! Important: take into account the pending transactions
                                            // TODO is 'pending' widely supported?
                );
            } catch {
                i++;
                this.logger.warn(
                    { account: this.walletAddress, token: this.tokenAddress, try: i },
                    'Failed to update wallet token balance. Worker locked until successful update.',
                );
                await new Promise((r) => setTimeout(r, this.retryInterval));
                // Continue trying
            }
        }
  
        this.walletBalance = walletBalance;
        this.transactionsSinceLastBalanceUpdate = 0;
  
        if (this.lowBalanceWarning != undefined) {
            const isBalanceLow = this.walletBalance < this.lowBalanceWarning;
            if (isBalanceLow != this.isBalanceLow) {
                this.isBalanceLow = isBalanceLow;
                const balanceInfo = {
                    balance: this.walletBalance,
                    lowBalanceWarning: this.lowBalanceWarning,
                    account: this.walletAddress,
                    token: this.tokenAddress
                };
                if (isBalanceLow) this.logger.warn(balanceInfo, 'Wallet token balance low.');
                else this.logger.info(balanceInfo, 'Wallet token funded.');
            }
        }
    }

    async getBalance(): Promise<bigint> {
        await this.runBalanceCheck();
        return this.walletBalance;
    }

    async hasEnoughBalance(amount: bigint): Promise<boolean> {
        const checkExecuted = await this.runBalanceCheck();
        if (this.walletBalance < amount && !checkExecuted) {
            await this.updateWalletBalance();
        }
        return this.walletBalance >= amount;
    }
  
    async runBalanceCheck(): Promise<boolean> {
        if (
            this.isBalanceLow ||
            this.transactionsSinceLastBalanceUpdate > this.balanceUpdateInterval
        ) {
            await this.updateWalletBalance();
            return true;
        }
        return false;
    }

    async registerBalanceUse(amount: bigint): Promise<void> {
        this.transactionsSinceLastBalanceUpdate++;
  
        const newWalletBalance = this.walletBalance - amount;
        if (newWalletBalance < 0n) {
            this.walletBalance = 0n;
        } else {
            this.walletBalance = newWalletBalance;
        }
  
        if (
            this.lowBalanceWarning != undefined &&
            !this.isBalanceLow && // Only trigger update if the current saved state is 'balance not low' (i.e. crossing the boundary)
            this.walletBalance < this.lowBalanceWarning
        ) {
            await this.updateWalletBalance();
        }
    }
  
    async registerBalanceRefund(amount: bigint): Promise<void> {
        this.walletBalance = this.walletBalance + amount;
    }
}