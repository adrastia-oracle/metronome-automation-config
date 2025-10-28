import { AdrastiaConfig, BatchConfig } from "../../src/config/adrastia-config";

const STD_WRITE_DELAY = 6_000; // Workers incrementally push updates with higher gas prices at 6 second intervals

const workerIndex = parseInt(process.env.ADRASTIA_WORKER_INDEX ?? "1");

const BASE_UPTIME_WEBHOOK_URL = process.env.BASE_UPTIME_WEBHOOK_URL;

const STANDARD_BATCH_CONFIG: BatchConfig = {
    // Primary and secondary polls every 10ms (with caching)
    // Tertiary every 2 seconds and others every 4 seconds (no caching)
    pollingInterval: workerIndex <= 2 ? 10 : workerIndex == 3 ? 2_000 : 4_000,
    writeDelay: STD_WRITE_DELAY * (workerIndex - 1),
    logging: [
        process.env.DD_AGENT_LOGGING_ENABLED === "true"
            ? {
                  // Default to datadog-agent logging if enabled (faster and more reliable)
                  type: "datadog-agent",
                  level: "notice",
              }
            : process.env.DATADOG_API_KEY
              ? {
                    type: "datadog",
                    sourceToken: process.env.DATADOG_API_KEY,
                    region: process.env.DATADOG_REGION,
                    level: "notice",
                }
              : undefined,
        process.env.ADRASTIA_LOGTAIL_TOKEN
            ? {
                  type: "logtail",
                  sourceToken: process.env.ADRASTIA_LOGTAIL_TOKEN,
                  level: "info",
              }
            : undefined,
    ],
    customerId: "metronome",
    type: "pyth-feeds",
};

// The primary and secondary workers uses 1 wei per feed update to calculate the update fee.
// Others call the Pyth contract to calculate the update fee.
const UPDATE_FEE = workerIndex <= 2 ? 1n : undefined;

const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

// Priority is based on the worker index. Lower value means higher priority.
const PYTH_HERMES_ENDPOINTS = [
    {
        name: "Triton One",
        url: process.env.PYTH_HERMES_TRITONONE_WS_URL,
        onlySubscriptions: true,
        priority: {
            1: 1,
            2: 2,
            3: 2,
            4: 1,
        },
    },
    {
        name: "Triton One",
        url: process.env.PYTH_HERMES_TRITONONE_REST_URL,
        disableSubscriptions: true,
        priority: {
            1: 1,
            2: 2,
            3: 2,
            4: 1,
        },
    },
    {
        name: "Extrnode",
        url: process.env.PYTH_HERMES_EXTRNODE_URL,
        priority: {
            1: 2,
            2: 1,
            3: 3,
            4: 3,
        },
    },
    {
        name: "Pyth Official",
        url: "https://hermes.pyth.network",
        priority: {
            1: 3,
            2: 3,
            3: 1,
            4: 2,
        },
    },
];

const sortedHermesEndpoints = PYTH_HERMES_ENDPOINTS.sort((a, b) => {
    return a.priority[workerIndex] - b.priority[workerIndex];
}).map((endpoint) => {
    // Only return name and url
    return {
        name: endpoint.name,
        url: endpoint.url,
        disableSubscriptions: endpoint.disableSubscriptions,
        onlySubscriptions: endpoint.onlySubscriptions,
    };
});

const config: AdrastiaConfig = {
    httpCacheSeconds: 0,
    onchainCacheTtl: workerIndex <= 2 ? 1_000 : workerIndex == 3 ? 2_000 : 4_000,
    pythHermesEndpoints: sortedHermesEndpoints,
    chains: {
        base: {
            blockTime: 2_000,
            txConfig: {
                transactionTimeout: STD_WRITE_DELAY * 2,
                txType: 2,
                eip1559: {
                    // Gas prices are based on the 75th percentile
                    percentile: 75,
                    historicalBlocks: 4, // 8 seconds of blocks
                    // Base fee multiplier of 1.25
                    baseFeeMultiplierDividend: 125n,
                    baseFeeMultiplierDivisor: 100n,
                    // Minimum priority fee of 250 wei
                    minPriorityFee: 250n,
                    // Priority fee is incrementally scaled based on worker index
                    priorityFeeMultiplierDividend: 150n + BigInt(workerIndex - 1) * 50n,
                    priorityFeeMultiplierDivisor: 100n,
                },
                // Check for tx confirmations every 250ms
                confirmationPollingInterval: 250,
                // Wait up to 6 seconds for tx confirmations
                transactionConfirmationTimeout: 6_000,
                // Wait for 1 confirmation
                waitForConfirmations: 1,
                // Gas limit is hardcoded
                gasLimit: 1_000_000n,
                opGasPriceOracle: "0x420000000000000000000000000000000000000F", // Used for L1 fee calculation
            },
            multicall2Address: MULTICALL3_ADDRESS,
            pythAddress: "0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a",
            uptimeWebhookUrl: BASE_UPTIME_WEBHOOK_URL,
            batches: {
                3: {
                    ...STANDARD_BATCH_CONFIG,
                    batchId: "1-pyth-core",
                },
            },
            oracles: [
                {
                    type: "pyth-feeds",
                    address: "0x0315a3e20e772b6D444B7B45e743e5a0CF80D7A2", // Adrastia Pyth Updater contract address
                    tokens: [
                        {
                            address: "0xcd4eb98d487478925bb032580ab13e7ccfcb2e814500b526f00bd9fa651cc6b6",
                            batch: 3,
                            extra: {
                                desc: "Pyth:msETH/USD",
                                heartbeat: 60 * 60, // 1 hour
                                updateThreshold: 50, // 50 bips, 0.5%
                                earlyUpdateTime: 30 * 60, // 30 minutes
                                earlyUpdateThreshold: 25, // 25 bips, 0.25%
                                updateFee: UPDATE_FEE,
                            },
                        },
                        {
                            address: "0xc753c899ffdfcc8d1a02440fe380501b454b559122998bcd245d9063d07cc162",
                            batch: 3,
                            extra: {
                                desc: "Pyth:msUSD/USD",
                                heartbeat: 60 * 60, // 1 hour
                                updateThreshold: 10, // 10 bips, 0.1%
                                earlyUpdateTime: 30 * 60, // 30 minutes
                                earlyUpdateThreshold: 5, // 5 bips, 0.05%
                                updateFee: UPDATE_FEE,
                            },
                        },
                    ],
                },
            ],
        },
    },
};

export default config;
