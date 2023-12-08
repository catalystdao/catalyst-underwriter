set -exo pipefail

cat "./src/chains.config.json" | jq -r '.[]|[.rpc, .forkPort] | @tsv' |
  while IFS=$'\t' read -r rpc forkPort; do
    pm2 start "anvil -f $rpc --port $forkPort"
  done
