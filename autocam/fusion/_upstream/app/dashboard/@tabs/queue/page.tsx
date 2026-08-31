"use client";

import { Reorder } from "framer-motion";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useDashboardEvents } from "@/app/dashboard/dashboardTeam";
import { PrimaryButton, SecondaryButton } from "@/components/Buttons/Buttons";
import styles from "./queue.module.css";
import { ConfirmationDialog } from "@/components/ConfirmationDialog/ConfirmationDialog";

type ApiPartCategory = {
  id: number;
  material: string;
  thickness: number;
};

type ApiPlate = {
  id: number;
  name: string;
  width: number;
  length: number;
  true_depth: number;
};

type PlatesJobKind = "arrange" | "cam";
type PlatesJobStatus = "pending" | "in progress" | "completed";

type ApiPlateJob = {
  id: number;
  kind: PlatesJobKind;
  status: PlatesJobStatus;
  queue_position: number;
  created_at?: string;
  payload?: Record<string, unknown>;
};

type QueueItem = {
  id: number;
  kind: PlatesJobKind;
  status: PlatesJobStatus;
  queue_position: number;
  created_at?: string;
  payload: Record<string, unknown>;
  plateId: number;
  plateName: string;
  material: string;
  thickness: number;
  machineId?: number;
  toolId?: number;
};

type IdName = { id: number; name: string };

function idsEqual(a: Array<{ id: number }>, b: number[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i]) return false;
  }
  return true;
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

function NoTeamCard() {
  const router = useRouter();
  return (
    <div className={styles.noTeamContainer}>
      <div className={styles.noTeamCard}>
        <h2>No Team Found</h2>
        <p>You need to be part of a team to manage job queues.</p>
        <div className={styles.noTeamButtons}>
          <PrimaryButton onClick={() => router.push("/dashboard/settings/newteam")}>
            <span className="textGradient">Create a Team</span>
          </PrimaryButton>
          <SecondaryButton onClick={() => router.push("/dashboard/settings/jointeam")}>
            <span className="textGradient">Join a Team</span>
          </SecondaryButton>
        </div>
      </div>
    </div>
  );
}

export default function QueueTab() {
  const { team } = useDashboardEvents();
  const teamId = team?.id;

  const [isLoading, setIsLoading] = useState(true);
  const [isApplying, setIsApplying] = useState<PlatesJobKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingApplyKind, setPendingApplyKind] = useState<PlatesJobKind | null>(null);

  const [arrangeQueue, setArrangeQueue] = useState<QueueItem[]>([]);
  const [camQueue, setCamQueue] = useState<QueueItem[]>([]);
  const [arrangeOriginalIds, setArrangeOriginalIds] = useState<number[]>([]);
  const [camOriginalIds, setCamOriginalIds] = useState<number[]>([]);
  const [camOriginalQueue, setCamOriginalQueue] = useState<QueueItem[]>([]);

  const [machinesById, setMachinesById] = useState<Record<number, string>>({});
  const [toolsById, setToolsById] = useState<Record<number, string>>({});

  const arrangeDirty = useMemo(
    () => !idsEqual(arrangeQueue, arrangeOriginalIds),
    [arrangeQueue, arrangeOriginalIds]
  );
  const camDirty = useMemo(
    () => !idsEqual(camQueue, camOriginalIds),
    [camQueue, camOriginalIds]
  );

  const loadQueues = useCallback(async (currentTeamId: number, signal?: AbortSignal) => {
    setError(null);
    setNotice(null);
    setIsLoading(true);

    const [categories, machines, tools] = await Promise.all([
      fetchJson<ApiPartCategory[]>(`/api/teams/${currentTeamId}/pc`, signal),
      fetchJson<IdName[]>(`/api/teams/${currentTeamId}/machines`, signal).catch(
        () => []
      ),
      fetchJson<IdName[]>(`/api/teams/${currentTeamId}/tools`, signal).catch(
        () => []
      ),
    ]);

    setMachinesById(Object.fromEntries(machines.map((m) => [m.id, m.name])));
    setToolsById(Object.fromEntries(tools.map((t) => [t.id, t.name])));

    const platesByCategory = await Promise.all(
      categories.map(async (category) => {
        const plates = await fetchJson<ApiPlate[]>(
          `/api/pc/${category.id}/plates`,
          signal
        ).catch(() => []);
        return plates.map((plate) => ({ plate, category }));
      })
    );

    const plateRows = platesByCategory.flat();

    const jobsByPlate = await Promise.all(
      plateRows.map(async ({ plate, category }) => {
        const jobs = await fetchJson<ApiPlateJob[]>(
          `/api/plates/${plate.id}/jobs`,
          signal
        ).catch(() => []);

        return jobs.map((job) => {
          const payload = job.payload ?? {};
          const machineId =
            typeof payload.machine_id === "number"
              ? (payload.machine_id as number)
              : undefined;
          const toolId =
            typeof payload.tool_id === "number"
              ? (payload.tool_id as number)
              : undefined;

          return {
            id: job.id,
            kind: job.kind,
            status: job.status,
            queue_position: job.queue_position,
            created_at: job.created_at,
            payload,
            plateId: plate.id,
            plateName: plate.name,
            material: category.material,
            thickness: category.thickness,
            machineId,
            toolId,
          } satisfies QueueItem;
        });
      })
    );

    const allJobs = jobsByPlate.flat();
    const nextArrange = allJobs
      .filter((j) => j.kind === "arrange" && j.status === "pending")
      .sort((a, b) => a.queue_position - b.queue_position);
    const nextCam = allJobs
      .filter((j) => j.kind === "cam" && j.status === "pending")
      .sort((a, b) => a.queue_position - b.queue_position);

    setArrangeQueue(nextArrange);
    setCamQueue(nextCam);
    setArrangeOriginalIds(nextArrange.map((j) => j.id));
    setCamOriginalIds(nextCam.map((j) => j.id));
    setCamOriginalQueue(nextCam);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    if (!teamId) {
      setArrangeQueue([]);
      setCamQueue([]);
      setArrangeOriginalIds([]);
      setCamOriginalIds([]);
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    loadQueues(teamId, controller.signal).catch((err) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("Failed to load queues:", err);
      setError("Failed to load queues");
      setIsLoading(false);
    });
    return () => controller.abort();
  }, [loadQueues, teamId]);

  async function applyQueue(kind: PlatesJobKind, confirmed = false) {
    if (!teamId) return;
    setError(null);
    setNotice(null);

    const items = kind === "arrange" ? arrangeQueue : camQueue;
    if (items.length === 0) {
      setNotice(`No pending ${kind.toUpperCase()} jobs to reorder.`);
      return;
    }
    if (kind === "arrange" && !arrangeDirty) {
      setNotice("Arrange queue order is unchanged.");
      return;
    }
    if (kind === "cam" && !camDirty) {
      setNotice("CAM queue order is unchanged.");
      return;
    }

    if (!confirmed) {
      setPendingApplyKind(kind);
      return;
    }

    setIsApplying(kind);

    const skipped: number[] = [];

    try {
      for (const job of items) {
        const payloadPlateId =
          typeof job.payload.plate_id === "number"
            ? (job.payload.plate_id as number)
            : undefined;
        const plateId = payloadPlateId ?? job.plateId;

        const latestJobs = await fetchJson<ApiPlateJob[]>(
          `/api/plates/${plateId}/jobs`
        ).catch(() => null);

        const latest = latestJobs?.find((j) => j.id === job.id);
        if (!latest || latest.status !== "pending" || latest.kind !== kind) {
          skipped.push(job.id);
          continue;
        }

        const deleteRes = await fetch(`/api/jobs/${job.id}`, {
          method: "DELETE",
        });
        if (!deleteRes.ok) {
          throw new Error(
            `Failed to delete job ${job.id} (${deleteRes.status})`
          );
        }

        let body:
          | { type: "arrange" }
          | { type: "cam"; machine_id: number; tool_id: number };
        if (kind === "arrange") {
          body = { type: "arrange" };
        } else {
          if (typeof job.machineId !== "number") {
            throw new Error(`Missing machine_id for CAM job ${job.id}`);
          }
          if (typeof job.toolId !== "number") {
            throw new Error(`Missing tool_id for CAM job ${job.id}`);
          }
          body = { type: "cam", machine_id: job.machineId, tool_id: job.toolId };
        }

        const createRes = await fetch(`/api/plates/${plateId}/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!createRes.ok) {
          throw new Error(
            `Failed to recreate job ${job.id} (${createRes.status})`
          );
        }

        await new Promise((r) => setTimeout(r, 25));
      }

      await loadQueues(teamId);
      if (skipped.length > 0) {
        setNotice(
          `Requeued ${kind.toUpperCase()} jobs. Skipped ${skipped.length} job(s) that were no longer pending.`
        );
      } else {
        setNotice(`Requeued ${kind.toUpperCase()} jobs.`);
      }
    } catch (err) {
      console.error("Failed to apply queue:", err);
      setError(err instanceof Error ? err.message : "Failed to apply queue");
      await loadQueues(teamId).catch(() => null);
    } finally {
      setIsApplying(null);
    }
  }

  async function handleDelete(job: QueueItem) {
    if (!teamId) return;
    if (job.kind === "arrange") {
      setIsApplying("arrange");
      try {
        const res = await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
        if (!res.ok) {
          throw new Error(`Failed to delete job ${job.id} (${res.status})`);
        }
        await loadQueues(teamId);
        setNotice(`Deleted arrange job #${job.id}.`);
      } catch (err) {
        console.error("Failed to delete arrange job:", err);
        setError(
          err instanceof Error ? err.message : "Failed to delete arrange job"
        );
      } finally {
        setIsApplying(null);
      }
      return;
    }

    setCamQueue(camOriginalQueue);
    setNotice("CAM queue reset to its previous state.");
  }

  if (!teamId && !isLoading) return <NoTeamCard />;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Queue Manager</div>
          <div className={styles.subtitle}>
            Reorder pending plate jobs for Arrange and CAM.
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className={styles.loadingContainer}>
          <span className={styles.loadingSpinner} />
        </div>
      ) : (
        <>
          {error ? <div className={styles.bannerError}>{error}</div> : null}
          {notice ? <div className={styles.bannerNotice}>{notice}</div> : null}

          <div className={styles.grid}>
            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <div className={styles.panelTitle}>Arrange Queue</div>
                  <div className={styles.panelMeta}>
                    {arrangeQueue.length} pending
                  </div>
                </div>
                <PrimaryButton
                  onClick={() => applyQueue("arrange")}
                  disabled={!teamId || Boolean(isApplying) || !arrangeDirty}
                >
                  <span className="textGradient">
                    {isApplying === "arrange" ? "Applying…" : "Apply Order"}
                  </span>
                </PrimaryButton>
              </div>

              {arrangeQueue.length === 0 ? (
                <div className={styles.empty}>No pending arrange jobs.</div>
              ) : (
                <Reorder.Group
                  axis="y"
                  values={arrangeQueue}
                  onReorder={setArrangeQueue}
                  className={styles.list}
                >
                  {arrangeQueue.map((job, index) => (
                    <Reorder.Item
                      key={job.id}
                      value={job}
                      className={styles.item}
                    >
                      <div className={styles.itemIndex}>{index + 1}</div>
                      <div className={styles.dragHandle} title="Drag to reorder">
                        ⠿
                      </div>
                      <div className={styles.itemMain}>
                        <div className={styles.itemTitle}>
                          {job.plateName} · {job.material} · {job.thickness}
                        </div>
                        <div className={styles.itemSub}>
                          Job #{job.id} · Queue pos {job.queue_position}
                        </div>
                      </div>
                      <div className={styles.itemActions}>
                        <button
                          type="button"
                          className={styles.actionBtn}
                          onClick={() => handleDelete(job)}
                          disabled={Boolean(isApplying)}
                          aria-label="Delete arrange job"
                        >
                          Delete
                        </button>
                      </div>
                    </Reorder.Item>
                  ))}
                </Reorder.Group>
              )}
            </section>

            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <div className={styles.panelTitle}>CAM Queue</div>
                  <div className={styles.panelMeta}>{camQueue.length} pending</div>
                </div>
                <PrimaryButton
                  onClick={() => applyQueue("cam")}
                  disabled={!teamId || Boolean(isApplying) || !camDirty}
                >
                  <span className="textGradient">
                    {isApplying === "cam" ? "Applying…" : "Apply Order"}
                  </span>
                </PrimaryButton>
              </div>

              {camQueue.length === 0 ? (
                <div className={styles.empty}>No pending CAM jobs.</div>
              ) : (
                <Reorder.Group
                  axis="y"
                  values={camQueue}
                  onReorder={setCamQueue}
                  className={styles.list}
                >
                  {camQueue.map((job, index) => (
                    <Reorder.Item
                      key={job.id}
                      value={job}
                      className={styles.item}
                    >
                      <div className={styles.itemIndex}>{index + 1}</div>
                      <div className={styles.dragHandle} title="Drag to reorder">
                        ⠿
                      </div>
                      <div className={styles.itemMain}>
                        <div className={styles.itemTitle}>
                          {job.plateName} · {job.material} · {job.thickness}
                        </div>
                        <div className={styles.itemSub}>
                          Job #{job.id} · Queue pos {job.queue_position}
                          {job.machineId ? (
                            <> · Machine {machinesById[job.machineId] ?? job.machineId}</>
                          ) : null}
                          {job.toolId ? (
                            <> · Tool {toolsById[job.toolId] ?? job.toolId}</>
                          ) : null}
                        </div>
                      </div>
                      <div className={styles.itemActions}>
                        <button
                          type="button"
                          className={styles.actionBtn}
                          onClick={() => handleDelete(job)}
                          disabled={Boolean(isApplying)}
                          aria-label="Reset CAM queue"
                        >
                          Delete
                        </button>
                      </div>
                    </Reorder.Item>
                  ))}
                </Reorder.Group>
              )}
            </section>
          </div>

          <div className={styles.footerHint}>
            Applying an order requeues jobs using existing endpoints (delete +
            recreate) and only affects pending jobs.
          </div>
        </>
      )}
      <ConfirmationDialog
        open={pendingApplyKind !== null}
        title="Apply queue order"
        message={pendingApplyKind ? `Apply the new ${pendingApplyKind.toUpperCase()} queue order?\n\nThis will requeue jobs by deleting and recreating all pending ${pendingApplyKind.toUpperCase()} jobs in the new order.` : ""}
        confirmLabel="Apply order"
        danger
        onCancel={() => setPendingApplyKind(null)}
        onConfirm={() => {
          const kind = pendingApplyKind;
          setPendingApplyKind(null);
          if (kind) void applyQueue(kind, true);
        }}
      />
    </div>
  );
}
