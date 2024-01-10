
export interface RetryOrder<T> {
    order: T;
    retryCount: number;
    retryAtTimestamp: number;
}

//TODO rename Queue
export abstract class RetryQueue<OrderType, ReturnOrderType=OrderType> {

    readonly queue: RetryOrder<OrderType>[] = [];
    readonly retryQueue: RetryOrder<OrderType>[] = []

    constructor(
        readonly retryInterval: number,
        readonly maxTries: number
    ) { }

    abstract init(): Promise<void>

    protected abstract handleOrder(order: OrderType, retryCount: number): Promise<ReturnOrderType | null>;
    protected abstract handleFailedOrder(order: OrderType, retryCount: number, error: any): Promise<boolean>;

    protected async onProcessOrders(): Promise<void> {
    };

    protected async onRetryOrderDrop(_order: OrderType, _retryCount: number): Promise<void> {
    }

    addOrders(...orders: OrderType[]): void {
        for (const order of orders) {
            this.queue.push({
                order,
                retryCount: 0,
                retryAtTimestamp: 0
            })
        }
    };

    async processOrders(): Promise<ReturnOrderType[]> {

        const validOrders: ReturnOrderType[] = [];

        for (const order of this.queue) {
            try {
                const returnOrder = await this.handleOrder(order.order, order.retryCount);
                if (returnOrder != null) {
                    validOrders.push(returnOrder);
                }
            } catch (error) {
                const retryOrder = await this.handleFailedOrder(order.order, error, order.retryCount);
                if (retryOrder) {
                    await this.addOrderToRetryQueue(order);
                }
            }
        }

        // Clear the 'retry' queue
        this.queue.length = 0;

        return validOrders;
    }

    async processRetryOrders(): Promise<void> {
        // Get the number of elements to move from the `retry` to the `submit` queue. Note that the
        // `retry` queue elements are in chronological order.

        const nowTimestamp = Date.now();

        let i;
        for (i = 0; i < this.retryQueue.length; i++) {
            const retryOrder = this.retryQueue[i];
            if (retryOrder.retryAtTimestamp <= nowTimestamp) {
                this.queue.push(retryOrder);
            } else {
                break;
            }
        }

        // Remove the elements to be retried from the `retry` queue
        this.retryQueue.splice(0, i);
    }
    

    protected async addOrderToRetryQueue(order: RetryOrder<OrderType>): Promise<void> {

        order.retryCount += 1;
        if (order.retryCount >= this.maxTries) {
            // Discard the message
            await this.onRetryOrderDrop(order.order, order.retryCount);
        } else {
            // Move the order to the 'retry' queue
            order.retryAtTimestamp = Date.now() + this.retryInterval;
            this.retryQueue.push(order);
        }
    }
}