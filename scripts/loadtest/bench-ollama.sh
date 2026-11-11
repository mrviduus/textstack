#!/usr/bin/env bash
#
# Side-by-side CPU vs GPU micro-benchmark for the Ollama LLM path.
#
# Ollama exposes `num_gpu` per-request: 0 = force CPU only, 99 = let the
# loader put as many layers on GPU as fit. We exercise both modes against
# the same prompts on the same model in the same run — no redeploy, no
# config flip — so the deltas are clean.
#
# Run from a host that can SSH to `asus`:
#   bash scripts/loadtest/bench-ollama.sh [out-dir]
#
# Produces:
#   $OUT/bench-cpu.ndjson   one Ollama /api/generate response per prompt
#   $OUT/bench-gpu.ndjson   same prompts, GPU layers requested
#   $OUT/summary.txt        avg / p50 / p95 latency, tokens/sec, speedup
set -euo pipefail

OUT="${1:-docs/internal/loadtest/bench-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"

PROMPTS=(
"Word: \"polling\"\nDefinition: \"checking for updates by repeated queries\"\nContext: \"The client uses polling to discover state changes.\"\nLanguage: en\n\nReply EXACT format:\nDISTRACTORS: w1, w2, w3, w4, w5\nHINT: one sentence under 15 words\nEXPLANATION: 2-3 sentences in Russian"
"Word: \"warehouse\"\nDefinition: \"a central storage facility for data\"\nContext: \"The data warehouse aggregates transactional data for analytics.\"\nLanguage: en\n\nReply EXACT format:\nDISTRACTORS: w1, w2, w3, w4, w5\nHINT: one sentence under 15 words\nEXPLANATION: 2-3 sentences in Russian"
"Word: \"linearizability\"\nDefinition: \"a strong consistency guarantee\"\nContext: \"Linearizability ensures operations appear to occur atomically.\"\nLanguage: en\n\nReply EXACT format:\nDISTRACTORS: w1, w2, w3, w4, w5\nHINT: one sentence under 15 words\nEXPLANATION: 2-3 sentences in Russian"
"Word: \"throughput\"\nDefinition: \"the rate at which a system processes requests\"\nContext: \"This database sustains 10k QPS throughput under load.\"\nLanguage: en\n\nReply EXACT format:\nDISTRACTORS: w1, w2, w3, w4, w5\nHINT: one sentence under 15 words\nEXPLANATION: 2-3 sentences in Russian"
"Word: \"partition\"\nDefinition: \"a horizontal slice of data\"\nContext: \"Each partition is replicated three times across availability zones.\"\nLanguage: en\n\nReply EXACT format:\nDISTRACTORS: w1, w2, w3, w4, w5\nHINT: one sentence under 15 words\nEXPLANATION: 2-3 sentences in Russian"
)

bench_one() {
    local mode="$1" extra_opts="$2"
    local file="$OUT/bench-$mode.ndjson"
    : > "$file"
    echo "==> Benchmark mode=$mode (opts=$extra_opts)"

    # Warm-up — first request after a mode-flip pays a load_duration. We do
    # one throwaway pass so the timing samples below all hit a hot model.
    ssh asus "docker run --rm --network textstack_default curlimages/curl:latest \
        -sS --max-time 120 -X POST http://ollama:11434/api/generate \
        -H 'Content-Type: application/json' \
        -d '{\"model\":\"gemma4:e2b\",\"prompt\":\"warmup\",\"stream\":false,\"think\":false,\"options\":{\"num_predict\":5$extra_opts}}'" \
        > /dev/null

    for i in "${!PROMPTS[@]}"; do
        local p="${PROMPTS[$i]}"
        local json_prompt="$(printf '%s' "$p" | jq -Rs .)"
        local body="{\"model\":\"gemma4:e2b\",\"prompt\":$json_prompt,\"stream\":false,\"think\":false,\"options\":{\"num_predict\":400$extra_opts}}"
        echo "  prompt $((i+1))/${#PROMPTS[@]}"
        # Push the request through a curl container on the docker network.
        ssh asus "docker run --rm --network textstack_default curlimages/curl:latest \
            -sS --max-time 180 -X POST http://ollama:11434/api/generate \
            -H 'Content-Type: application/json' -d '$body'" \
            | jq -c '{model, eval_count, prompt_eval_count, prompt_eval_duration, eval_duration, total_duration, load_duration, done_reason}' \
            >> "$file"
    done
}

summary() {
    local mode_local="$1"
    local file="$OUT/bench-$mode_local.ndjson"
    echo "=== $mode_local ==="
    jq -s '
        {
            n: length,
            total_ms_avg:  (map(.total_duration / 1e6) | add / length | round),
            total_ms_p50:  (map(.total_duration / 1e6) | sort | .[length / 2 | floor] | round),
            total_ms_max:  (map(.total_duration / 1e6) | max | round),
            eval_ms_avg:   (map(.eval_duration / 1e6) | add / length | round),
            eval_tok_avg:  (map(.eval_count) | add / length | round),
            tok_per_s_avg: (map((.eval_count / (.eval_duration / 1e9))) | add / length | (.*10|round)/10),
            load_ms_first: (.[0].load_duration / 1e6 | round)
        }' "$file"
}

bench_one cpu ',\"num_gpu\":0'
# GPU mode lets Ollama auto-pick the layer split based on free VRAM. On this
# box (GTX 1650 Ti, 4 GB) we see ~26 % of layers offloaded for gemma4:e2b.
# Forcing num_gpu=99 fails with "memory layout cannot be allocated".
bench_one gpu ''

{
    echo "Ollama micro-benchmark — gemma4:e2b on prod (GTX 1650 Ti Mobile, 4GB)"
    echo "Generated: $(date -u --iso-8601=seconds 2>/dev/null || date -u)"
    echo "Prompts: ${#PROMPTS[@]} distractor-shape, num_predict=400, think:false"
    echo ""
    summary cpu
    summary gpu
} > "$OUT/summary.txt"

cat "$OUT/summary.txt"
echo ""
echo "Raw responses: $OUT/bench-{cpu,gpu}.ndjson"
