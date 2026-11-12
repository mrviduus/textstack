# Ollama CPU vs GPU micro-benchmark — 2026-05-12

Side-by-side: same model, same prompts, same box. Only thing that
moves is whether Ollama is allowed to offload layers to the GPU.

## Setup

| | |
|---|---|
| Box | AMD Ryzen 5 4600H + NVIDIA GTX 1650 Ti Mobile, 4 GB VRAM |
| Model | `gemma4:e2b` (7.8 GB on disk) |
| Engine | Ollama 0.23.1 |
| Prompt shape | Real `DistractorGenerator` prompt — word + definition + sentence + instructions for distractors / hint / explanation |
| Output cap | `num_predict: 400`, `think: false` |
| Sample size | 5 prompts × 5 distinct technical words (polling / warehouse / linearizability / throughput / partition) |
| Mode flip | `num_gpu: 0` → force CPU. No `num_gpu` → Ollama auto-splits (it ends up at `74%/26% CPU/GPU` for this model on this VRAM) |
| Warm-up | One throwaway call per mode before timed samples |

Both modes run after a warm-up so we measure **steady-state inference**,
not first-load cost. Raw responses live in `bench-cpu.ndjson` and
`bench-gpu.ndjson` (one Ollama `/api/generate` response per line).

## Result

| Metric | CPU only | GPU hybrid (35/36 layers on GPU, 26 % of weights) | Δ |
|---|---:|---:|---:|
| Avg output tokens / call | 60 | 55 | ~same |
| Avg eval latency (token gen only) | **3 506 ms** | **1 411 ms** | **-60 %  ·  2.49× faster** |
| Avg total latency (prompt eval + token gen) | **5 390 ms** | **2 174 ms** | **-60 %  ·  2.48× faster** |
| Tokens / sec | **17** | **39** | **+129 %  ·  2.29× faster** |

`ollama ps` during the GPU run:

```
NAME          SIZE     PROCESSOR          CONTEXT    UNTIL   
gemma4:e2b    7.8 GB   74%/26% CPU/GPU    4096       Forever
```

`nvidia-smi` during a GPU inference:

```
NVIDIA GTX 1650 Ti, used 1998 MiB, free 1909 MiB, util 32 %
process: /usr/bin/ollama, 1998 MiB used
```

## Reading the split correctly

`ollama ps` reports `74%/26% CPU/GPU` for this model on this box. The
first read of that number is "26 % of the layers fit on GPU." The
load logs say something different — and the difference matters.

Per Ollama's load output, **35 of the model's 36 transformer blocks
were offloaded to the GPU**. By layer count, almost the entire
forward pass is on the card. The `26 %` in `ollama ps` is the
**memory** split — the share of total model weights resident in
VRAM — not the layer split.

The two diverge because layers in this model aren't the same size.
The single layer that stayed on the CPU is the output projection
(the final matmul that turns hidden states into a distribution over
the vocabulary). Gemma's vocabulary is large, which makes that one
layer disproportionately heavy by weight. There isn't headroom in
4 GB to fit the output layer alongside the transformer stack and
still leave room for the KV cache and forward-pass scratch space,
so Ollama puts it on the CPU.

Every generated token round-trips through that CPU-resident output
layer. GPU does the parallel work over 35 layers, then hands
activations back to the CPU for the final projection, then waits
for the next token. The per-token rate is bounded by that mandatory
CPU step. It's not "74 % of layers running slowly on CPU" — it's
"100 % of tokens crossing the same CPU bottleneck on their way out."

## What this means

The 2.5× number lands where it does because almost all the
parallelisable compute moved to the GPU, but one serial step per
token stayed on the slower device. A full-offload card with enough
VRAM to hold the output layer too would shift that last step to the
GPU and unlock the 10× figure cited in other writeups. We're
running on commodity hardware that can't make that move.

For a real save in TextStack — distractors + hint + explanation in
a single Ollama call, average output ~60 tokens, prompt ~150 tokens
— the user-facing fire-and-forget enrichment goes from **~5.4 s to
~2.2 s** per word. Five rapid saves go from ~27 s of CPU burn down
to ~11 s of mixed CPU/GPU burn. Still not free, but the box stays
demonstrably cooler under the same workload (separate sample:
peak temp during a 5-save burst dropped from 71 °C to ~60 °C).

## Why not bigger

- 4 GB VRAM caps the offload ratio. `num_gpu: 99` errors with
  "memory layout cannot be allocated".
- The next free win on this hardware would be a smaller-quant
  variant of the same model (gemma4:e2b is shipped Q4_K_M; a Q3_K
  build would be ~5 GB and might fit fully). Quality
  trade-off — not pursued here.
- Going off-box to a 16 GB+ GPU is the obvious step but undermines
  the "self-hostable on commodity hardware" framing of the
  project.

## Files

```
docs/loadtest/
├── bench-20260512-140615/
│   └── bench-cpu.ndjson          # first run, CPU baseline (used for this report)
└── bench-20260512-140841/
    ├── REPORT.md                  # this file
    ├── bench-cpu.ndjson           # second run, CPU mode (failed — switching back from hot-GPU model returned no body)
    └── bench-gpu.ndjson           # GPU hybrid measurements
```

## Reproduce

```bash
bash scripts/loadtest/bench-ollama.sh
```

The script SSHs to `asus`, runs both modes against the same prompts
via a `curlimages/curl` container on the `textstack_default` docker
network (so we hit Ollama at `http://ollama:11434` without going
through nginx), and dumps NDJSON + summary into
`docs/loadtest/bench-<timestamp>/`.
