/**
 * Server-side Runpod compute instance catalog — maps a user-facing instance id
 * (e.g. "rtx4090") onto a Runpod gpuTypeId (or CPU flavor) and the hourly rate
 * used to meter compute cost.
 *
 * Keep in sync with the display catalog in web/src/data/runpod-instances.json.
 * Rates are community-cloud estimates for budget metering (same model as Modal);
 * actual Runpod invoices may differ by cloud tier / data center / stock.
 */

export interface RunpodInstanceSpec {
  id: string;
  label: string;
  /**
   * Runpod GPU type id for `gpuTypeIds` (e.g. "NVIDIA GeForce RTX 4090").
   * Null for CPU-only pods.
   */
  gpuTypeId: string | null;
  /** Number of GPUs (GPU pods only). */
  gpuCount: number;
  /** Hourly rate (USD) used to estimate compute cost from wall-time. */
  pricePerHour: number;
  /** Default base registry image when the caller doesn't specify one. */
  defaultImage: string;
  /** Container disk size in GB. */
  containerDiskInGb: number;
}

/**
 * Official Runpod PyTorch image with SSH support when PUBLIC_KEY is set.
 * Matches the MCP server's recommended default family.
 */
const DEFAULT_GPU_IMAGE =
  "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04";
const DEFAULT_CPU_IMAGE = "runpod/base:0.6.2-ubuntu2204";

export const RUNPOD_INSTANCES: RunpodInstanceSpec[] = [
  {
    id: "cpu",
    label: "CPU",
    gpuTypeId: null,
    gpuCount: 0,
    pricePerHour: 0.06,
    defaultImage: DEFAULT_CPU_IMAGE,
    containerDiskInGb: 20,
  },
  {
    id: "rtx4090",
    label: "RTX 4090",
    gpuTypeId: "NVIDIA GeForce RTX 4090",
    gpuCount: 1,
    pricePerHour: 0.44,
    defaultImage: DEFAULT_GPU_IMAGE,
    containerDiskInGb: 40,
  },
  {
    id: "l4",
    label: "L4",
    gpuTypeId: "NVIDIA L4",
    gpuCount: 1,
    pricePerHour: 0.44,
    defaultImage: DEFAULT_GPU_IMAGE,
    containerDiskInGb: 40,
  },
  {
    id: "a40",
    label: "A40",
    gpuTypeId: "NVIDIA A40",
    gpuCount: 1,
    pricePerHour: 0.4,
    defaultImage: DEFAULT_GPU_IMAGE,
    containerDiskInGb: 40,
  },
  {
    id: "a6000",
    label: "RTX A6000",
    gpuTypeId: "NVIDIA RTX A6000",
    gpuCount: 1,
    pricePerHour: 0.49,
    defaultImage: DEFAULT_GPU_IMAGE,
    containerDiskInGb: 40,
  },
  {
    id: "a100-80gb",
    label: "A100 80GB",
    gpuTypeId: "NVIDIA A100 80GB PCIe",
    gpuCount: 1,
    pricePerHour: 1.64,
    defaultImage: DEFAULT_GPU_IMAGE,
    containerDiskInGb: 50,
  },
  {
    id: "h100",
    label: "H100",
    gpuTypeId: "NVIDIA H100 80GB HBM3",
    gpuCount: 1,
    pricePerHour: 2.99,
    defaultImage: DEFAULT_GPU_IMAGE,
    containerDiskInGb: 50,
  },
];

const BY_ID = new Map(RUNPOD_INSTANCES.map((i) => [i.id, i]));

/** Valid instance ids, for error messages and schema hints. */
export const RUNPOD_INSTANCE_IDS = RUNPOD_INSTANCES.map((i) => i.id);

/** Default instance when the session/caller hasn't picked one. */
export const DEFAULT_RUNPOD_INSTANCE_ID = "rtx4090";

/** Look up an instance spec by id; returns null for unknown ids ("local" included). */
export function resolveRunpodInstance(id: string | null | undefined): RunpodInstanceSpec | null {
  if (!id) return null;
  // Accept "runpod:rtx4090" from the compute selector wire format.
  const bare = id.startsWith("runpod:") ? id.slice("runpod:".length) : id;
  return BY_ID.get(bare) ?? null;
}
