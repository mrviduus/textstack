#!/usr/bin/env bash
# Fails (exit 1) if any of the given images carries a secret.
#
#   scripts/scan-image-secrets.sh IMAGE [IMAGE...]
#
# The images are published to GHCR and meant to go public, so anything baked in
# is published with them. Three places a secret can hide, all checked:
#   - Config.Env      (an ENV / ARG→ENV in a Dockerfile)
#   - docker history  (a RUN line that echoed a build arg)
#   - every layer     (a COPY that picked up .env, a key, a service account).
#     Each layer separately, from `docker save`: a file deleted by a later layer
#     is invisible in the container but still downloadable from the registry.
# CANARY_SECRET is what images.yml puts in every .env value, so a compose build
# arg that forwards a .env variable shows up here by name.
set -euo pipefail

# Tokens. Precise shapes, not "sk-" plus anything: CoreLib's culture table contains
# "sk-sksl-sisma-…" and libunistring "AKIAISLANDISSHARITAL".
CONTENT='CANARY_SECRET|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|(^|[^A-Za-z0-9])AKIA[0-9A-Z]{16}([^A-Za-z0-9]|$)|sk-[A-Za-z0-9_-]*T3BlbkFJ|sk-(proj|svcacct|admin)-[A-Za-z0-9_-]{40,}'
# A private key is the header followed by key material. The header alone is a
# string literal in every TLS library (node, chromium, gnutls…).
PEM='-----BEGIN ([A-Z]+ )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/]{40}'
# Files whose mere presence is a finding. .env.example is documentation.
NAMES='(^|/)(\.env(\.[^/]*)?|[^/]*service-account[^/]*\.json|appsettings\.[^/]*\.json|id_(rsa|ed25519|ecdsa)|[^/]*\.(p12|pfx|jks|keystore))$'
# Known public files that match anyway (path regex). Keep it short; say why.
#   - expo-updates ships test-fixture signing keys, and pnpm hoists the mobile
#     workspace's dependencies into the admin and ssg-worker installs.
#   - libgnutls (distro package) embeds a PEM key literal for its self-tests.
ALLOW='^(etc/ssl/|usr/share/ca-certificates/)|\.env\.example$|node_modules/expo-updates/android/src/shared/certificates/|^usr/lib/([a-z0-9_]+-linux-gnu/)?libgnutls\.so'
# Where layers are searched: a throwaway Linux container, so a CI runner and a Mac
# run the same GNU grep (BSD grep took minutes per image) and nothing from the
# image is unpacked onto the host.
SCANNER=alpine:3.22

# Runs in $SCANNER with `docker save` on stdin. Prints "<path>\t<why>, layer <id>"
# per finding, then LAYERS=<n>.
INNER=$(cat <<'SH'
set -eu
apk add -q --no-cache grep >/dev/null
mkdir /s /x && tar -x -C /s
n=0
for b in $(find /s -type f); do
  d=/x/$(basename "$b" | cut -c1-12)
  mkdir -p "$d"
  if tar -tf "$b" >/dev/null 2>&1; then tar -x -C "$d" -f "$b" 2>/dev/null || true; n=$((n+1))
  elif gzip -t "$b" 2>/dev/null; then gzip -dc "$b" | tar -x -C "$d" 2>/dev/null || true; n=$((n+1))
  else cp "$b" "$d/"; fi   # config / manifest JSON: searched as a file
done
cd /x
# grep: 0 = match, 1 = none, 2 = broken. A broken search must not read as clean.
search() { why=$1; shift; rc=0; grep "$@" > /tmp/hit || rc=$?
  [ "$rc" -le 1 ] || { echo "SCAN-ERROR $why"; exit 1; }
  awk -v w="$why" '{print $0 "\t" w}' /tmp/hit; }
find . -type f > /tmp/files
{ search name -E -e "$NAMES" /tmp/files
  search token -rlaE -e "$CONTENT" .
  search 'private key' -rlaPz -e "$PEM" .
} | awk -F'\t' '{ l = $1; sub(/^\.\//, "", l); i = index(l, "/");
                  print substr(l, i + 1) "\t" $2 ", layer " substr(l, 1, i - 1) }'
echo "LAYERS=$n"
SH
)

fail=0
for img in "$@"; do
  echo "== $img"
  if docker image inspect "$img" --format '{{json .Config.Env}}' | grep -Eo "$CONTENT"; then
    echo "::error::$img: secret pattern in Config.Env"; fail=1
  fi
  if docker history --no-trunc --format '{{.CreatedBy}}' "$img" | grep -Eo "$CONTENT"; then
    echo "::error::$img: secret pattern in layer history"; fail=1
  fi

  out=$(docker save "$img" \
    | docker run --rm -i -e CONTENT="$CONTENT" -e PEM="$PEM" -e NAMES="$NAMES" "$SCANNER" sh -c "$INNER")
  layers=$(printf '%s\n' "$out" | sed -n 's/^LAYERS=//p')
  [ "${layers:-0}" -gt 0 ] || { echo "::error::$img: no layers found in docker save output"; exit 1; }
  if printf '%s\n' "$out" | grep -q 'SCAN-ERROR'; then echo "::error::$img: grep failed in the scanner"; exit 1; fi
  hits=$(printf '%s\n' "$out" | { grep -v '^LAYERS=' || true; } \
    | ALLOW="$ALLOW" awk -F'\t' 'NF > 1 && $1 !~ ENVIRON["ALLOW"] { print "  " $1 "  (" $2 ")" }' | sort -u)
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits"
    echo "::error::$img: secret-like files in the image layers"; fail=1
  else
    echo "  clean ($layers layers)"
  fi
done
exit $fail
