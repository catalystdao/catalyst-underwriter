set -exo pipefail

source .env set

anvil -f https://rpc.notadegen.com/eth/sepolia --port $FORK_PORT
