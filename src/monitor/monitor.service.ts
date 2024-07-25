import { Global, Injectable, OnModuleInit } from '@nestjs/common';
import { MessagePort, MessageChannel } from 'worker_threads';
import { ConfigService } from 'src/config/config.service';
import { LoggerService } from 'src/logger/logger.service';
import WebSocket from "ws";
import { tryErrorToString } from 'src/common/utils';
import pino, { LoggerOptions } from 'pino';
import { MonitorStatusMessage } from './monitor.types';
import Ajv from "ajv"
import { AnyValidateFunction } from "ajv/dist/core"

export const DEFAULT_MONITOR_RETRY_INTERVAL = 2000;
export const DEFAULT_MONITOR_BLOCK_DELAY = 2;

interface MonitorConfig {
    retryInterval: number;
}

interface MonitorChainConfig {
    blockDelay: number;
    ports: MessagePort[];
}

// TODO use the ajv instance used by the config service.
const BYTES_32_HEX_EXPR = '^0x[0-9a-fA-F]{64}$';  // '0x' + 32 bytes (64 chars)
const MONITOR_EVENT_SCHEMA = {
    $id: "monitor-event-schema",
    type: "object",
    properties: {
        chainId: {
            type: "string",
            minLength: 1,
        },
        blockNumber: {
            type: "number",
            exclusiveMinimum: 0,
        },
        blockHash: {
            type: "string",
            pattern: BYTES_32_HEX_EXPR
        },
        timestamp: {
            type: "number",
            exclusiveMinimum: 0,
        },
    },
    required: ["chainId", "blockNumber", "blockHash", "timestamp"],
    additionalProperties: false,
}

interface MonitorEvent {
    chainId: string;
    blockNumber: number;
    blockHash: string;
    timestamp: number;
}

@Global()
@Injectable()
export class MonitorService implements OnModuleInit {

    private readonly logger: pino.Logger;

    private readonly config: MonitorConfig;
    private readonly chainConfig: Map<string, MonitorChainConfig>;

    private readonly monitorEventValidator: AnyValidateFunction;

    constructor(
        private readonly configService: ConfigService,
        loggerService: LoggerService,
    ) {
        this.logger = this.initializeLogger(loggerService.loggerOptions);

        this.config = this.loadConfig();
        this.chainConfig = this.loadChainConfig();

        this.monitorEventValidator = this.loadMonitorEventValidator();
        this.startListeningToRelayerMonitor();
    }

    private initializeLogger(loggerOptions: LoggerOptions): pino.Logger {
        return pino(loggerOptions).child({
            worker: 'monitor',
        });
    }

    private loadConfig(): MonitorConfig {
        const monitorGlobalConfig = this.configService.globalConfig.monitor;
        return {
            retryInterval: monitorGlobalConfig.retryInterval
                ?? DEFAULT_MONITOR_RETRY_INTERVAL,
        };
    }

    private loadChainConfig(): Map<string, MonitorChainConfig> {

        const loadedChainConfig = new Map<string, MonitorChainConfig>();

        const monitorGlobalConfig = this.configService.globalConfig.monitor;
        for (const [chainId, chainConfig] of this.configService.chainsConfig) {
            const monitorChainConfig = chainConfig.monitor;

            loadedChainConfig.set(
                chainId,
                {
                    blockDelay: monitorChainConfig.blockDelay
                        ?? monitorGlobalConfig.blockDelay
                        ?? DEFAULT_MONITOR_BLOCK_DELAY,
                    ports: []
                }
            )
        }

        return loadedChainConfig;
    }

    private loadMonitorEventValidator(): AnyValidateFunction<unknown> {
        const ajv = new Ajv({ strict: true });
        ajv.addSchema(MONITOR_EVENT_SCHEMA);

        const verifier = ajv.getSchema('monitor-event-schema');
        if (verifier == undefined) {
            throw new Error('Unable to load the \'monitor-event\' schema.');
        }

        return verifier;
    }

    onModuleInit() {
        this.logger.info(`Starting Monitor...`);
    }


    attachToMonitor(chainId: string): MessagePort {
        const chainConfig = this.chainConfig.get(chainId);

        if (chainConfig == undefined) {
            throw new Error(`Monitor does not support chain ${chainId}`);
        }

        const { port1, port2 } = new MessageChannel();
        chainConfig.ports.push(port1);

        return port2;
    }

    private startListeningToRelayerMonitor(): void {
        this.logger.info(`Start listening to the relayer for new monitor events.`);

        const wsUrl = `http://${process.env['RELAYER_HOST']}:${process.env['RELAYER_PORT']}/`;
        const ws = new WebSocket(wsUrl);

        ws.on("open", () => {
            ws.send(
                JSON.stringify({ event: "monitor" }),
                (error) => {
                    if (error != null) {
                        this.logger.error("Failed to subscribe to 'monitor' events.");
                    }
                }
            );
        });

        ws.on("error", (error) => {
            this.logger.warn(
                {
                    wsUrl,
                    error: tryErrorToString(error)
                },
                'Error on websocket connection.'
            );
        });

        ws.on("close", (exitCode) => {
            this.logger.warn(
                {
                    wsUrl,
                    exitCode,
                    retryInterval: this.config.retryInterval
                },
                'Websocket connection with the relayer closed. Will attempt reconnection.'
            );

            setTimeout(() => this.startListeningToRelayerMonitor(), this.config.retryInterval);
        });

        ws.on("message", (data) => {
            const parsedMessage = JSON.parse(data.toString());

            if (parsedMessage.event == "monitor") {
                const monitorEvent = parsedMessage.data;
                if (monitorEvent == undefined) {
                    this.logger.warn(
                        { parsedMessage },
                        "No data present on 'monitor' event."
                    );
                    return;
                }

                const isEventValid = this.monitorEventValidator(monitorEvent);
                if (!isEventValid) {
                    this.logger.warn(
                        { monitorEvent },
                        "Skipping monitor event: object schema invalid."
                    );
                    return;
                }


                this.handleMonitorEvent(monitorEvent);
            } else {
                this.logger.warn(
                    { message: data },
                    "Unknown message type received on websocket connection.",
                )
            }
        });
    }

    private handleMonitorEvent(event: MonitorEvent): void {

        const eventChainId = event.chainId;

        const chainConfig = this.chainConfig.get(eventChainId);
        if (chainConfig == undefined) {
            this.logger.debug(
                { chainId: eventChainId },
                `Skipping monitor event: chain not supported.`
            );
            return;
        }

        this.logger.debug(
            { chainId: event.chainId, blockNumber: event.blockNumber },
            "Monitor event received.",
        );

        const status: MonitorStatusMessage = {
            blockNumber: Math.max(0, event.blockNumber - chainConfig.blockDelay)
        };

        for (const port of chainConfig.ports) {
            port.postMessage(status);
        }

    }
}
