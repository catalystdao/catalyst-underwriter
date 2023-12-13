set -exo pipefail

cat "./src/chains.config.json" | jq -r '.[]|[.name, .rpc, .forkPort] | @tsv' |
  while IFS=$'\t' read -r name rpc forkPort; do
    pm2 start -n $name "anvil -f "$rpc" -p $forkPort"
  done
