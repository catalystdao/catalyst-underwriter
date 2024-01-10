import { Wallet } from "ethers";
import pino from "pino";
import { RetryQueue } from "./retry-queue";
import { EvalOrder, UnderwriteOrder } from "../underwriter.types";

export class EvalQueue extends RetryQueue<EvalOrder, UnderwriteOrder> {

    constructor(
        retryInterval: number,
        maxTries: number,
        private readonly signer: Wallet,
        private readonly logger: pino.Logger
    ) {
        super(retryInterval, maxTries);
    }

    async init(): Promise<void> {
        // No init required for the eval queue
    }

    protected async onRetryOrderDrop(order: EvalOrder, retryCount: number): Promise<void> {
        this.logger.error(
          `Failed to eval underwrite for swap ${order.swapIdentifier} (swap txHash ${order.txHash}). Dropping message (try ${retryCount + 1}).`,
        );
    }

    protected async handleOrder(order: EvalOrder, retryCount: number): Promise<UnderwriteOrder | null> {

        //TODO evaluation
        if (true) {
            return {
                ...order,
                calldata: '0x0000', //TODO
                gasLimit: 10000000 //TODO
            };
        } else {
            this.logger.info(
                `Dropping order ${'TODO'} on evaluation (try ${retryCount + 1})`   //TODO set order id
            );

            return null;
        }
    }

    protected async handleFailedOrder(order: EvalOrder, retryCount: number, error: any): Promise<boolean> {
        //TODO improve error filtering?
        if (error.code === 'CALL_EXCEPTION') {
            this.logger.info(
                `Failed to evaluate message ${order}: CALL_EXCEPTION. Dropping message (try ${retryCount + 1}).`,
            );
            return false;
        }

        this.logger.warn(
            error,
            `Failed to eval order ${'TODO'} (try ${retryCount + 1})`,   //TODO set order id
        );

        return true;
    }

}