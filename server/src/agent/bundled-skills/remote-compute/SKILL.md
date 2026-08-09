---
name: remote-compute
description: >-
  When and how to offload heavy or GPU work from the local sandbox using
  modal_run (Modal) or runpod_run (Runpod). Prefer this skill for dataset
  experiments, training, fine-tuning, large simulations, or any job that
  should not run on the user's laptop. Covers provider choice, files_in /
  files_out, instance selection, cost, and teardown.
---

# Remote compute (Modal + Runpod)

The local sandbox is the **source of truth**. Remote tools spin ephemeral
machines, run a command, copy results back, and terminate. Use them for heavy
or GPU work — not for everyday file edits or light `uv run` scripts.

## Tools (lead agent only)

| Tool | Provider | When it exists |
| --- | --- | --- |
| `modal_run` | Modal sandbox | `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` set in Settings → API keys |
| `runpod_run` | Ephemeral Runpod pod | `RUNPOD_API_KEY` set in Settings → API keys |

If a tool is missing, tell the user which key to add and that they need a
**new chat tab** after saving credentials (registration is at session open).

Subagents do **not** receive these tools — keep remote compute on the lead agent.

## When to offload

**Do use remote compute when:**
- The job needs a GPU (training, fine-tuning, diffusion, large inference).
- A local run would thrash RAM/CPU or take impractically long.
- The user selected a Modal or Runpod instance in the Compute chip (treat that as their preferred default).
- Working a large dataset under `user_data/` that needs accelerated processing.

**Stay local when:**
- Light Python (`uv run`), file IO, plotting small frames, unit-style checks.
- The Compute chip is on **Local** and the work fits the sandbox.
- You only need to inspect or reshape small tables.

## Modal vs Runpod — which tool?

Both stage files from the sandbox and return outputs. Prefer:

| Prefer | When |
| --- | --- |
| **`modal_run`** | Modal keys are set; you want fast sandbox cold starts, simple image + pip/apt layers, or the user picked a Modal GPU in the Compute chip. |
| **`runpod_run`** | Runpod key is set; user wants Runpod pricing/GPUs (e.g. RTX 4090 community), a specific Docker image, or they picked a Runpod GPU in the Compute chip. |
| **Either** | Both configured and the user did not specify — pick the provider matching the Compute chip default if any, else Modal for quick sandboxes, Runpod when the user mentions Runpod/RTX 4090/pods. |
| **Neither** | Neither tool is available — explain setup; do not pretend remote GPUs exist. |

Never invent a third provider. Do not shell out to `runpodctl` / Modal CLI unless the user explicitly wants that workflow and the binary is installed.

## Calling pattern

1. Put inputs in the sandbox (usually `user_data/` for uploads).
2. Write the script/notebook under the sandbox root if needed.
3. Call the tool with:
   - `command` — shell to run in `/workspace` (use the image's Python; remote is **not** the local uv venv).
   - `instance` — optional; omit to use the session Compute chip default.
   - `files_in` — sandbox-relative paths to upload.
   - `files_out` — sandbox-relative paths to download after success.
   - `timeout_sec` — keep tight; default is generous but billable.
4. Read returned files with normal tools; summarize metrics for the user.
5. Pods/sandboxes are torn down automatically — do not leave orphan cloud resources.

### Example (Runpod)

```text
runpod_run(
  command="python train.py --data dataset.csv --out metrics.json",
  instance="rtx4090",
  files_in=["user_data/dataset.csv", "train.py"],
  files_out=["metrics.json", "checkpoints/best.pt"]
)
```

### Example (Modal)

```text
modal_run(
  command="python infer.py --input data.parquet",
  instance="l4",
  files_in=["user_data/data.parquet", "infer.py"],
  files_out=["predictions.csv"],
  image={ "pip": ["pandas", "torch"] }
)
```

## Instance hints

**Modal** (bare ids): `cpu`, `t4`, `l4`, `a10g`, `a100-40gb`, `a100-80gb`, `h100`.

**Runpod** (ids; wire form is `runpod:<id>` in the UI): `cpu`, `rtx4090`, `l4`, `a40`, `a6000`, `a100-80gb`, `h100`.

Pick the smallest GPU that fits VRAM needs. Cost is estimated as wall-time ×
catalog $/hr and counts toward the project spend limit.

## Cost and safety

- Remote wall-time is billed on the **user's** Modal/Runpod account; ResearchCraft also meters an estimate into the project budget.
- If the budget gate blocks the tool, stop and ask the user to raise the limit or shrink the job.
- Do **not** forward API keys or secrets into remote envs unless the user explicitly requests it.
- Prefer scoped `files_in` / `files_out` — don't sync the entire sandbox.

## Failure handling

- **Auth errors** → Settings → API keys; new chat tab after save.
- **Out of stock / capacity** (Runpod) → try another instance or `cloud_type: "SECURE"`.
- **Missing outputs** → check `files_out_missing` in the tool result; fix paths or the script.
- Always report exit code, approximate cost, and which files came back.
