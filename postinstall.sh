#!/bin/sh
set -e

cd "$(dirname "$0")"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git_dir="$(git rev-parse --path-format=absolute --git-dir)"
    git_common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
    main_checkout="$(dirname "${git_common_dir}")"
    env_source="${main_checkout}/apps/cloudflare-worker/.env.local"
    if [ "${git_dir}" != "${git_common_dir}" ] && [ -f "${env_source}" ]; then
        if [ ! -f apps/cloudflare-worker/.env.local ] || [ ! -f libs/narration-source-analysis/.env.evals ]; then
            node tooling/env-setup/src/cli.ts setup --from "${env_source}"
        fi
    fi
    if [ "${git_dir}" != "${git_common_dir}" ]; then
        node tooling/env-setup/src/cli.ts copy-upload-key --from "${main_checkout}"
    fi
fi

pnpm run env:check

pnpm run cf-typegen

if [ "${CI}" = "true" ]; then
    exit 0
else

    husky
fi
