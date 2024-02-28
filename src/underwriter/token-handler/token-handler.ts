import pino from "pino";
import { UnderwriteOrder } from "../underwriter.types";
import { JsonRpcProvider } from "ethers";
import { PoolConfig, TokenConfig } from "src/config/config.types";
import { ApprovalHandler } from "./approval-handler";
import { WalletInterface } from "src/wallet/wallet.interface";
import { BalanceHandler } from "./balance-handler";


export type InterfaceAddress = string;
export type TokenAddress = string;

export class TokenHandler {

    private balanceHandlers = new Map<TokenAddress, BalanceHandler>();
    private approvalHandlers = new Map<InterfaceAddress, ApprovalHandler>();

    constructor(
        private readonly chainId: string,
        private readonly retryInterval: number,
        private readonly pools: PoolConfig[],
        private readonly tokens: Record<string, TokenConfig>,
        private readonly walletPublicKey: string,
        private readonly wallet: WalletInterface,
        private readonly provider: JsonRpcProvider,
        private readonly logger: pino.Logger
    ) {
    }

    async init(): Promise<void> {
        await this.initializeBalanceHandlers();
        this.initializeApprovalHandlers();
    }

    async processOrders(...orders: UnderwriteOrder[]): Promise<void> {
        for (const order of orders) {
            this.registerRequiredAllowanceIncrease(
                order.interfaceAddress,
                order.toAsset,
                order.toAssetAllowance
            );

            await this.registerBalanceUse(
                order.toAssetAllowance,
                order.toAsset
            );
        }

        await this.setRequiredAllowances();
    }



    // Balance logic
    // ********************************************************************************************
    private async initializeBalanceHandlers(): Promise<void> {
        await Promise.all(
            Object.keys(this.tokens).map(tokenAddress => {
                return this.initializeBalanceHandler(tokenAddress);
            })
        );
    }

    private async initializeBalanceHandler(
        tokenAddress: TokenAddress
    ): Promise<BalanceHandler> {

        const normalizedTokenAddress = tokenAddress.toLowerCase();

        const tokenConfig = this.tokens[normalizedTokenAddress];
        if (tokenConfig == undefined) {
            this.logger.error(
                { tokenAddress: normalizedTokenAddress },
                'Unable to register token balance use: token configuration not found.'
            );
        }

        const helper = new BalanceHandler(
            {
                lowBalanceWarning: tokenConfig.lowTokenBalanceWarning,
                balanceUpdateInterval: tokenConfig.tokenBalanceUpdateInterval!
            },
            normalizedTokenAddress,
            this.walletPublicKey,
            this.retryInterval,
            this.provider,
            this.logger
        );

        await helper.init();

        this.balanceHandlers.set(normalizedTokenAddress, helper);

        return helper;
    }

    private getBalanceHandler(tokenAddress: string): BalanceHandler {
        const handler = this.balanceHandlers.get(tokenAddress.toLowerCase());

        if (handler == undefined) {
            throw new Error(`BalanceHandler of token ${tokenAddress} not found.`)
        }

        return handler;
    }

    async getBalance(tokenAddress: string) {
        return this.getBalanceHandler(tokenAddress).getBalance();
    }

    async hasEnoughBalance(amount: bigint, tokenAddress: string) {
        return this.getBalanceHandler(tokenAddress).hasEnoughBalance(amount);
    }

    async registerBalanceUse(amount: bigint, tokenAddress: string) {
        return this.getBalanceHandler(tokenAddress).registerBalanceUse(amount);
    }

    async registerBalanceRefund(amount: bigint, tokenAddress: string) {
        return this.getBalanceHandler(tokenAddress).registerBalanceRefund(amount);
    }



    // Approval logic
    // ********************************************************************************************
    private initializeApprovalHandlers(): void {

        for (const poolConfig of this.pools) {
            for (const vaultConfig of poolConfig.vaults) {
                if (vaultConfig.chainId != this.chainId) {
                    continue
                }

                if (!this.approvalHandlers.has(vaultConfig.interfaceAddress)) {
                    this.initializeApprovalHandler(vaultConfig.interfaceAddress);
                }
            }
        }
    }

    private initializeApprovalHandler(
        interfaceAddress: InterfaceAddress
    ): ApprovalHandler {

        const normalizedInterfaceAddress = interfaceAddress.toLowerCase();

        const handler = new ApprovalHandler(
            this.tokens,
            normalizedInterfaceAddress,
            this.walletPublicKey,
            this.wallet,
            this.provider,
            this.logger
        );

        this.approvalHandlers.set(interfaceAddress, handler);

        return handler;
    }

    private getApprovalHandler(interfaceAddress: string): ApprovalHandler {
        const handler = this.approvalHandlers.get(interfaceAddress);

        if (handler == undefined) {
            throw new Error(`ApprovalHandler of interface ${interfaceAddress} not found.`)
        }

        return handler;
    }

    private registerRequiredAllowanceIncrease(
        interfaceAddress: string,
        assetAddress: string,
        amount: bigint
    ): void {
        const approvalHandler = this.getApprovalHandler(interfaceAddress);
        approvalHandler.registerRequiredAllowanceIncrease(assetAddress, amount);
    }

    registerRequiredAllowanceDecrease(
        interfaceAddress: string,
        assetAddress: string,
        amount: bigint
    ): void {
        const approvalHandler = this.getApprovalHandler(interfaceAddress);
        approvalHandler.registerRequiredAllowanceDecrease(assetAddress, amount);
    }

    registerSetAllowanceDecrease(
        interfaceAddress: string,
        assetAddress: string,
        amount: bigint
    ): void {
        const approvalHandler = this.getApprovalHandler(interfaceAddress);
        approvalHandler.registerSetAllowanceDecrease(assetAddress, amount);
    }

    registerAllowanceUse(interfaceAddress: string, assetAddress: string, amount: bigint): void {
        const approvalHandler = this.getApprovalHandler(interfaceAddress);
        approvalHandler.registerAllowanceUse(assetAddress, amount);
    }


    private async setRequiredAllowances(): Promise<void> {

        const promises: Promise<void>[] = [];
        for (const handler of this.approvalHandlers.values()) {
            promises.push(handler.setRequiredAllowances())
        }

        await Promise.allSettled(promises);
    }
    
}