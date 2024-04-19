import Ajv from "ajv"
import { AnyValidateFunction } from "ajv/dist/core"

const MIN_PROCESSING_INTERVAL = 1;
const MAX_PROCESSING_INTERVAL = 500;

const EVM_ADDRESS_EXPR = '^0x[0-9a-fA-F]{40}$';  // '0x' + 20 bytes (40 chars)
const BYTES_32_HEX_EXPR = '^0x[0-9a-fA-F]{64}$';  // '0x' + 32 bytes (64 chars)

const POSITIVE_NUMBER_SCHEMA = {
    $id: "positive-number-schema",
    type: "number",
    minimum: 0,
}
const POSITIVE_NON_ZERO_INTEGER_SCHEMA = {
    $id: "positive-non-zero-integer-schema",
    type: "number",
    exclusiveMinimum: 0,
    multipleOf: 1,
}
const NON_EMPTY_STRING_SCHEMA = {
    $id: "non-empty-string-schema",
    type: "string",
    minLength: 1,
}

const ADDRESS_FIELD_SCHEMA = {
    $id: "address-field-schema",
    type: "string",
    pattern: EVM_ADDRESS_EXPR
}

const BYTES32_FIELD_SCHMEA = {
    $id: "bytes32-field-schema",
    type: "string",
    pattern: BYTES_32_HEX_EXPR
}

const GAS_FIELD_SCHEMA = {
    $id: "gas-field-schema",
    type: "string",
    minLength: 1,
}

const UINT256_FIELD_SCHEMA = {
    $id: "uint256-field-schema",
    type: "string",
    minLength: 1,
}

const CHAIN_ID_SCHEMA = {
    $id: "chain-id-schema",
    type: "number",
    minimum: 0
}

const PROCESSING_INTERVAL_SCHEMA = {
    $id: "processing-interval-schema",
    type: "number",
    minimum: MIN_PROCESSING_INTERVAL,
    maximum: MAX_PROCESSING_INTERVAL,
}

const CONFIG_SCHEMA = {
    $id: "config-schema",
    type: "object",
    properties: {
        global: {$ref: "global-schema"},
        ambs: {$ref: "ambs-schema"},
        chains: {$ref: "chains-schema"},
        endpoints: {$ref: "endpoints-schema"},
    },
    required: ["global", "ambs", "chains", "endpoints"],
    additionalProperties: false
}

const GLOBAL_SCHEMA = {
    $id: "global-schema",
    type: "object",
    properties: {
        privateKey: {
            type: "string",
            pattern: BYTES_32_HEX_EXPR,
        },
        logLevel: {$ref: "non-empty-string-schema"},

        monitor: {$ref: "monitor-schema"},
        listener: {$ref: "listener-schema"},
        underwriter: {$ref: "underwriter-global-schema"},
        expirer: {$ref: "expirer-schema"},
        wallet: {$ref: "wallet-schema"},
    },
    required: ["privateKey"],
    additionalProperties: false
}

const MONITOR_SCHEMA = {
    $id: "monitor-schema",
    type: "object",
    properties: {
        blockDelay: {$ref: "positive-number-schema"},
        retryInterval: {$ref: "positive-number-schema"},
    },
    additionalProperties: false
}

const LISTENER_SCHEMA = {
    $id: "listener-schema",
    type: "object",
    properties: {
        retryInterval: {$ref: "positive-number-schema"},
        processingInterval: {$ref: "processing-interval-schema"},
        maxBlocks: {
            type: "number",
            minimum: 0,
            maximum: 1_000_000,
        },
        startingBlock: {$ref: "positive-number-schema"},
    },
    additionalProperties: false
}

const UNDERWRITER_GLOBAL_SCHEMA = {
    $id: "underwriter-global-schema",
    type: "object",
    properties: {
        enabled: {
            type: "boolean"
        },
        retryInterval: {$ref: "positive-number-schema"},
        processingInterval: {$ref: "processing-interval-schema"},
        maxTries: {$ref: "positive-number-schema"},
        maxPendingTransactions: {$ref: "positive-number-schema"},
        minRelayDeadlineDuration: {$ref: "positive-number-schema"},
        underwriteDelay: {$ref: "positive-number-schema"},
        maxUnderwriteDelay: {$ref: "positive-number-schema"},
        maxSubmissionDelay: {$ref: "positive-number-schema"},
        underwritingCollateral: {
            type: "number",
            exclusiveMinimum: 0,
            maximum: 0.1
        },
        allowanceBuffer: {
            type: "number",
            exclusiveMinimum: 0,
            maximum: 0.3
        },
        maxUnderwriteAllowed: {$ref: "uint256-field-schema"},
        minUnderwriteReward: {$ref: "uint256-field-schema"},
        lowTokenBalanceWarning: {$ref: "uint256-field-schema"},
        tokenBalanceUpdateInterval: {$ref: "positive-number-schema"},
    },
    additionalProperties: false
}

const UNDERWRITER_SCHEMA = {
    $id: "underwriter-schema",
    type: "object",
    properties: {
        ...UNDERWRITER_GLOBAL_SCHEMA.properties,
        minMaxGasDelivery: {$ref: "positive-number-schema"},
    },
    required: ["minMaxGasDelivery"],
    additionalProperties: false
}

const EXPIRER_SCHEMA = {
    $id: "expirer-schema",
    type: "object",
    properties: {
        enabled: {
            type: "boolean"
        },
        retryInterval: {$ref: "positive-number-schema"},
        processingInterval: {$ref: "processing-interval-schema"},
        maxTries: {$ref: "positive-number-schema"},
        maxPendingTransactions: {$ref: "positive-number-schema"},
        expireBlocksMargin: {$ref: "positive-number-schema"}
    },
    additionalProperties: false
}

const WALLET_SCHEMA = {
    $id: "wallet-schema",
    type: "object",
    properties: {
        retryInterval: {$ref: "positive-number-schema"},
        processingInterval: {$ref: "processing-interval-schema"},
        maxTries: {$ref: "positive-number-schema"},
        maxPendingTransactions: {$ref: "positive-number-schema"},
        confirmations: {$ref: "positive-non-zero-integer-schema"},
        confirmationTimeout: {$ref: "positive-number-schema"},
        lowGasBalanceWarning: {$ref: "gas-field-schema"},
        gasBalanceUpdateInterval: {$ref: "positive-number-schema"},
        maxFeePerGas: {$ref: "gas-field-schema"},
        maxAllowedPriorityFeePerGas: {$ref: "gas-field-schema"},
        maxPriorityFeeAdjustmentFactor: {
            type: "number",
            minimum: 0,
            maximum: 100
        },
        maxAllowedGasPrice: {$ref: "gas-field-schema"},
        gasPriceAdjustmentFactor: {
            type: "number",
            minimum: 0,
            maximum: 100
        },
        priorityAdjustmentFactor: {
            type: "number",
            minimum: 0,
            maximum: 100
        },
    },
    additionalProperties: false
}

const AMBS_SCHEMA = {
    $id: "ambs-schema",
    type: "array",
    items: {
        type: "object",
        properties: {
            name: {$ref: "non-empty-string-schema"},
            enabled: {
                type: "boolean"
            },
            relayPrioritisation: {
                type: "boolean"
            },
        },
        required: ["name"],
        additionalProperties: true,
    },
    minItems: 1
}

const TOKENS_SCHEMA = {
    $id: "tokens-schema",
    type: "array",
    items: {
        type: "object",
        properties: {
            name: {$ref: "non-empty-string-schema"},
            address: {$ref: "address-field-schema"},
            maxUnderwriteAllowed: {$ref: "uint256-field-schema"},
            minUnderwriteReward: {$ref: "uint256-field-schema"},
            lowTokenBalanceWarning: {$ref: "uint256-field-schema"},
            tokenBalanceUpdateInterval: {$ref: "positive-number-schema"},
            allowanceBuffer: {$ref: "gas-field-schema"}
        },
        required: ["name", "address"],
        additionalProperties: false
    },
    minItems: 1
}

const CHAINS_SCHEMA = {
    $id: "chains-schema",
    type: "array",
    items: {
        type: "object",
        properties: {
            chainId: {$ref: "chain-id-schema"},
            name:  {$ref: "non-empty-string-schema"},
            rpc:  {$ref: "non-empty-string-schema"},
            resolver: {$ref: "non-empty-string-schema"},
            tokens: {$ref: "tokens-schema"},

            blockDelay: {$ref: "positive-number-schema"},
            monitor: {$ref: "monitor-schema"},
            listener: {$ref: "listener-schema"},
            underwriter: {$ref: "underwriter-schema"},
            expirer: {$ref: "expirer-schema"},
            wallet: {$ref: "wallet-schema"},
        },
        required: ["chainId", "name", "rpc", "tokens", "underwriter"],
        additionalProperties: false
    },
    minItems: 2
}

const ENDPOINTS_SCHEMA = {
    $id: "endpoints-schema",
    type: "array",
    items: {
        type: "object",
        properties: {
            name: {$ref: "non-empty-string-schema"},
            amb: {$ref: "non-empty-string-schema"},
            chainId: {$ref: "chain-id-schema"},
            factoryAddress: {$ref: "address-field-schema"},
            interfaceAddress: {$ref: "address-field-schema"},
            incentivesAddress: {$ref: "address-field-schema"},
            channelsOnDestination: {
                type: "object",
                patternProperties: {
                    ['^[0-9]{1,64}$']: {$ref: "bytes32-field-schema"}, //TODO specify a better match for the key (i.e. the chain id)
                },
                additionalProperties: false
            },
            vaultTemplates: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        name: {$ref: "non-empty-string-schema"},
                        address: {$ref: "address-field-schema"},
                    },
                    required: ["name", "address"],
                    additionalProperties: false
                },
                minItems: 1
            }
        },
        required: ["name", "amb", "chainId", "factoryAddress", "interfaceAddress", "incentivesAddress", "channelsOnDestination", "vaultTemplates"],
        additionalProperties: false
    },
    minItems: 2
}

export function getConfigValidator(): AnyValidateFunction<unknown> {
    const ajv = new Ajv({strict: true});
    ajv.addSchema(POSITIVE_NUMBER_SCHEMA);
    ajv.addSchema(POSITIVE_NON_ZERO_INTEGER_SCHEMA);
    ajv.addSchema(NON_EMPTY_STRING_SCHEMA);
    ajv.addSchema(ADDRESS_FIELD_SCHEMA);
    ajv.addSchema(BYTES32_FIELD_SCHMEA);
    ajv.addSchema(GAS_FIELD_SCHEMA);
    ajv.addSchema(UINT256_FIELD_SCHEMA);
    ajv.addSchema(CHAIN_ID_SCHEMA);
    ajv.addSchema(PROCESSING_INTERVAL_SCHEMA);
    ajv.addSchema(CONFIG_SCHEMA);
    ajv.addSchema(GLOBAL_SCHEMA);
    ajv.addSchema(MONITOR_SCHEMA);
    ajv.addSchema(LISTENER_SCHEMA);
    ajv.addSchema(UNDERWRITER_GLOBAL_SCHEMA);
    ajv.addSchema(UNDERWRITER_SCHEMA);
    ajv.addSchema(EXPIRER_SCHEMA);
    ajv.addSchema(WALLET_SCHEMA);
    ajv.addSchema(AMBS_SCHEMA);
    ajv.addSchema(TOKENS_SCHEMA);
    ajv.addSchema(CHAINS_SCHEMA);
    ajv.addSchema(ENDPOINTS_SCHEMA);

    const verifier = ajv.getSchema('config-schema');
    if (verifier == undefined) {
        throw new Error('Unable to load the \'config\' schema.');
    }

    return verifier;
}