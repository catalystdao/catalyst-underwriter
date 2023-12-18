set -exo pipefail

source .env set
docker run --rm -p $REDIS_PORT:$REDIS_PORT --name redis-docker -d redis