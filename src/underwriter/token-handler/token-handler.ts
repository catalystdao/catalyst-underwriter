import pino from "pino";
import { UnderwriteOrder } from "../underwriter.types";
import { JsonRpcProvider } from "ethers";
import { TokenConfig } from "src/config/config.types";
import { ApprovalHandler } from "./approval-handler";
import { WalletInterface } from "src/wallet/wallet.interface";


export type InterfaceAddress = string;
export type TokenAddress = string;

export class TokenHandler {

    private approvalHandlers = new Map<InterfaceAddress, ApprovalHandler>();

    constructor(
        readonly retryInterval: number,
        readonly tokens: Record<string, TokenConfig>,
        private readonly walletPublicKey: string,
        private readonly wallet: WalletInterface,
        private readonly provider: JsonRpcProvider,
        private readonly logger: pino.Logger
    ) {
    }

    private getApprovalHandler(interfaceAddress: string): ApprovalHandler {
        const handler = this.approvalHandlers.get(interfaceAddress);

        if (handler == undefined) {
            const newHandler = new ApprovalHandler(
                this.tokens,
                interfaceAddress,
                this.walletPublicKey,
                this.wallet,
                this.provider,
                this.logger
            );

            this.approvalHandlers.set(interfaceAddress, newHandler);

            return newHandler;
        }

        return handler;
    }

    async processOrders(...orders: UnderwriteOrder[]): Promise<void> {
        for (const order of orders) {
            this.registerRequiredAllowanceIncrease(
                order.interfaceAddress,
                order.toAsset,
                order.toAssetAllowance
            );
        }

        await this.setRequiredAllowances();
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