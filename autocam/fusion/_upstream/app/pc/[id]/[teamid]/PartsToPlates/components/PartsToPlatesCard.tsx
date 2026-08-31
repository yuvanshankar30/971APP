import styles from "../partstoplates.module.css";
import { useMaterialEvents } from "../../materialEvents";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import type { PlatesJob } from "@/app/types";
import type { PlateJobRun } from "./helpers";
import { PlatePartsSection } from "./PlatePartsSection";
import {
  PlateJobsList,
  PlatesJobWithMeta,
} from "./PlateJobsList";
import { CamModal } from "./modals/CamModal";
import { CamDownloadModal } from "./modals/CamDownloadModal";
import { CamDeleteConfirmModal } from "./modals/CamDeleteConfirmModal";
import { ArrangeErrorModal } from "./modals/ArrangeErrorModal";
import { CamErrorModal } from "./modals/CamErrorModal";
import { PlateDeleteConfirmModal } from "./modals/PlateDeleteConfirmModal";
import { ConfirmationDialog } from "@/components/ConfirmationDialog/ConfirmationDialog";

function formatMachiningTime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function getMachiningTimeSeconds(response: unknown): number | null {
  if (!response || typeof response !== "object") return null;
  const value = (response as { total_machining_time?: unknown })
    .total_machining_time;
  return typeof value === "number" && value >= 0 ? value : null;
}

export function PartsToPlatesCard({
  name,
  categoryId,
}: {
  name: string;
  categoryId: number;
}) {
  type ExcessPart = {
    part_id: number;
    quantity: number;
  };
  type TrueDepthStatus = "idle" | "saving" | "saved" | "error";
  type LibraryToolItem = {
    id: string;
    name: string;
    guid: string;
    libraryId: number;
    libraryName: string;
    default_selected?: boolean;
    machine_ids?: number[];
    material_ids?: number[];
  };

  const {
    partsToPlates,
    setPartsToPlates,
    plates,
    setPlates,
    setUnassignedParts,
  } = useMaterialEvents();
  const [jobs, setJobs] = useState<PlatesJob[]>([]);
  const [jobsDeleteBusy, setJobsDeleteBusy] = useState<Record<number, boolean>>(
    {}
  );
  const [jobsDeleteError, setJobsDeleteError] = useState<string | null>(null);
  const [pendingDeleteRun, setPendingDeleteRun] = useState<PlateJobRun | null>(null);
  const [arrangeLoading, setArrangeLoading] = useState(false);
  const { teamid } = useParams();
  const teamDbId = Number(Array.isArray(teamid) ? teamid[0] : teamid);
  const plateIndex = Number.parseInt(name);
  const currentPlate = plates[plateIndex];
  const currentPlateId = currentPlate?.id;
  const plateAssignments = isValidPlateId(currentPlateId)
    ? partsToPlates[currentPlateId] ?? []
    : [];

  function isValidPlateId(id: number | null | undefined): id is number {
    return Number.isFinite(id) && (id as number) > 0;
  }

  const [camModalOpen, setCamModalOpen] = useState(false);
  const [camModalArrangeJobId, setCamModalArrangeJobId] = useState<
    number | null
  >(null);
  const [camModalPlateId, setCamModalPlateId] = useState<number | null>(null);
  const [camModalLoading, setCamModalLoading] = useState(false);
  const [camModalError, setCamModalError] = useState<string | null>(null);
  const [camFileUrl, setCamFileUrl] = useState<string | null>(null);
  const [camFileType, setCamFileType] = useState<
    "image" | "pdf" | "other" | null
  >(null);
  const [camDownloadModalOpen, setCamDownloadModalOpen] = useState(false);
  const [camDownloadJobId, setCamDownloadJobId] = useState<number | null>(null);
  const [camDownloadArrangeJobId, setCamDownloadArrangeJobId] = useState<
    number | null
  >(null);
  const [camDownloadPlateId, setCamDownloadPlateId] = useState<number | null>(
    null
  );
  const [camDeleteConfirmOpen, setCamDeleteConfirmOpen] = useState(false);
  const [camDeleteBusy, setCamDeleteBusy] = useState(false);
  const [machineNames, setMachineNames] = useState<Record<number, string>>({});
  const [camDownloadLoading, setCamDownloadLoading] = useState(false);
  const [camDownloadError, setCamDownloadError] = useState<string | null>(null);
  const [camBundleUrl, setCamBundleUrl] = useState<string | null>(null);
  const [camDownloadMachiningTime, setCamDownloadMachiningTime] = useState<
    string | null
  >(null);
  const [arrangePreviewUrl, setArrangePreviewUrl] = useState<string | null>(
    null
  );
  const [arrangePreviewType, setArrangePreviewType] = useState<
    "image" | "pdf" | "other" | null
  >(null);
  const [machines, setMachines] = useState<
    Array<{ id: number; name: string; can_run_plates?: boolean }>
  >([]);
  const [assignmentsLoaded, setAssignmentsLoaded] = useState(false);
  const [tools, setTools] = useState<LibraryToolItem[]>([]);
  const [camSelectedToolIds, setCamSelectedToolIds] = useState<string[]>([]);
  const [selectedMachineId, setSelectedMachineId] = useState<number | null>(
    null
  );
  const [materialNameForCategory, setMaterialNameForCategory] = useState<
    string | null
  >(null);
  const [materialIdForCategory, setMaterialIdForCategory] = useState<
    number | null
  >(null);
  const [camErrorModalOpen, setCamErrorModalOpen] = useState(false);
  const [camErrorMessage, setCamErrorMessage] = useState<string | null>(null);
  const [camErrorPlateId, setCamErrorPlateId] = useState<number | null>(null);
  const [camErrorArrangeJobId, setCamErrorArrangeJobId] = useState<
    number | null
  >(null);
  const [camErrorCamJobId, setCamErrorCamJobId] = useState<number | null>(null);
  const [camErrorRetryBusy, setCamErrorRetryBusy] = useState(false);
  const [camErrorMachineName, setCamErrorMachineName] = useState<string | null>(
    null
  );
  const [camErrorTitle, setCamErrorTitle] = useState("CAM Error");
  const [trueDepthInput, setTrueDepthInput] = useState<string>("");
  const [trueDepthStatus, setTrueDepthStatus] =
    useState<TrueDepthStatus>("idle");
  const trueDepthSaveTimeout = useRef<number | null>(null);
  const trueDepthStatusTimeout = useRef<number | null>(null);
  const [arrangeErrorModalOpen, setArrangeErrorModalOpen] = useState(false);
  const [arrangeErrorMessage, setArrangeErrorMessage] = useState<string | null>(
    null
  );
  const [arrangeErrorArrangeJobId, setArrangeErrorArrangeJobId] = useState<
    number | null
  >(null);
  const [arrangeErrorPlateId, setArrangeErrorPlateId] = useState<number | null>(
    null
  );
  const [arrangeErrorRetryBusy, setArrangeErrorRetryBusy] = useState(false);
  const [plateDeleteConfirmOpen, setPlateDeleteConfirmOpen] = useState(false);
  const [plateDeleteBusy, setPlateDeleteBusy] = useState(false);
  const [plateDeleteTargetId, setPlateDeleteTargetId] = useState<number | null>(
    null
  );
  const [camDownloadMachineName, setCamDownloadMachineName] = useState<
    string | null
  >(null);
  const handledExcessJobs = useRef<Set<number>>(new Set());
  const camModalPlate =
    camModalPlateId != null
      ? plates.find((plate) => plate.id === camModalPlateId) ?? null
      : null;
  const arrangeDimensions = camModalPlate ?? currentPlate;
  const isCardLoading = !assignmentsLoaded;
  const availableCamTools = useMemo(
    () => getEligibleTools(selectedMachineId),
    [selectedMachineId, tools, materialIdForCategory]
  );

  useEffect(() => {
    if (!camModalOpen) return;
    setCamSelectedToolIds((prev) => {
      const valid = prev.filter((id) =>
        availableCamTools.some((tool) => tool.id === id)
      );
      if (valid.length > 0) return valid;
      const defaults = availableCamTools
        .filter((tool) => tool.default_selected)
        .map((tool) => tool.id);
      if (defaults.length > 0) return defaults;
      if (availableCamTools.length > 0) {
        return availableCamTools.map((tool) => tool.id);
      }
      return [];
    });
  }, [camModalOpen, availableCamTools]);

  useEffect(() => {
    if (!currentPlate) {
      setTrueDepthInput("");
      setTrueDepthStatus("idle");
      return;
    }
    setTrueDepthInput(
      Number.isFinite(currentPlate.true_depth)
        ? String(currentPlate.true_depth)
        : ""
    );
  }, [currentPlate?.id, currentPlate?.true_depth]);

  useEffect(() => {
    return () => {
      if (trueDepthSaveTimeout.current) {
        window.clearTimeout(trueDepthSaveTimeout.current);
      }
      if (trueDepthStatusTimeout.current) {
        window.clearTimeout(trueDepthStatusTimeout.current);
      }
    };
  }, []);

  useEffect(() => {
    if (trueDepthSaveTimeout.current) {
      window.clearTimeout(trueDepthSaveTimeout.current);
      trueDepthSaveTimeout.current = null;
    }
    if (trueDepthStatusTimeout.current) {
      window.clearTimeout(trueDepthStatusTimeout.current);
      trueDepthStatusTimeout.current = null;
    }
    setTrueDepthStatus("idle");
  }, [currentPlate?.id]);

  function openCamModal(plateId: number, arrangeJobId: number) {
    setCamModalPlateId(plateId);
    setCamModalArrangeJobId(arrangeJobId);
    setCamModalOpen(true);
  }

  function closeCamModal() {
    setCamModalOpen(false);
    setCamModalPlateId(null);
    setCamModalArrangeJobId(null);
    setCamModalError(null);
    setCamModalLoading(false);
    setCamFileUrl(null);
    setCamFileType(null);
    setMachines([]);
    setTools([]);
    setSelectedMachineId(null);
    setCamSelectedToolIds([]);
  }

  function closeCamDownloadModal() {
    setCamDownloadModalOpen(false);
    setCamDownloadJobId(null);
    setCamDownloadArrangeJobId(null);
    setCamDownloadPlateId(null);
    setCamDownloadError(null);
    setCamBundleUrl(null);
    setArrangePreviewUrl(null);
    setArrangePreviewType(null);
    setCamDownloadLoading(false);
    setCamDownloadMachineName(null);
  }

  function openCamDownloadModal(
    arrangeJobId: number,
    camJobId: number,
    plateId: number
  ) {
    setCamDownloadArrangeJobId(arrangeJobId);
    setCamDownloadJobId(camJobId);
    setCamDownloadPlateId(plateId);
    setCamDownloadModalOpen(true);
  }

  function openCamDeleteConfirm() {
    setCamDeleteConfirmOpen(true);
  }

  function closeCamDeleteConfirm() {
    setCamDeleteConfirmOpen(false);
  }

  function getJobError(job?: PlatesJobWithMeta): string | null {
    if (!job) return null;
    const resp = job.response;
    if (resp === null || resp === undefined) return null;
    if (typeof resp !== "object") return null;
    const maybe = resp as { error?: unknown };
    if (typeof maybe.error === "string") return maybe.error;
    return null;
  }

  function getArrangeErrorMessage(job?: PlatesJobWithMeta): string | null {
    if (!job) return null;
    const resp = job.response;
    if (resp === null || resp === undefined) return null;
    if (typeof resp !== "object") return null;
    const maybe = resp as { error?: unknown };
    if (typeof maybe.error === "string") return maybe.error;
    return null;
  }

  function getArrangeExcessParts(job?: PlatesJobWithMeta): ExcessPart[] {
    if (!job) return [];
    const resp = job.response;
    if (resp === null || resp === undefined) return [];
    if (typeof resp !== "object") return [];
    const maybe = resp as { excess_parts?: unknown };
    if (!Array.isArray(maybe.excess_parts)) return [];
    return maybe.excess_parts
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const partId = (item as { part_id?: unknown }).part_id;
        const quantity = (item as { quantity?: unknown }).quantity;
        if (typeof partId !== "number") return null;
        if (typeof quantity !== "number") return null;
        if (quantity <= 0) return null;
        return { part_id: partId, quantity };
      })
      .filter((item): item is ExcessPart => item !== null);
  }

  function getArrangeOversizedParts(job?: PlatesJobWithMeta): ExcessPart[] {
    if (!job) return [];
    const resp = job.response;
    if (resp === null || resp === undefined) return [];
    if (typeof resp !== "object") return [];
    const maybe = resp as { oversized_parts?: unknown };
    if (!Array.isArray(maybe.oversized_parts)) return [];
    return maybe.oversized_parts
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const partId = (item as { part_id?: unknown }).part_id;
        const quantity = (item as { quantity?: unknown }).quantity;
        if (typeof partId !== "number") return null;
        if (typeof quantity !== "number") return null;
        if (quantity <= 0) return null;
        return { part_id: partId, quantity };
      })
      .filter((item): item is ExcessPart => item !== null);
  }

  function getCamMachineLabel(job?: PlatesJobWithMeta): string | null {
    if (!job) return null;
    const payload = job.payload;
    if (!payload || typeof payload !== "object") return null;
    const machineId = (payload as { machine_id?: unknown }).machine_id;
    if (typeof machineId !== "number") return null;
    const name = machineNames[machineId];
    return name ? name : `Machine ${machineId}`;
  }

  function openCamErrorModal(
    message: string | null,
    plateId: number | null,
    arrangeId: number | null,
    camId: number | null,
    machineName: string | null,
    title?: string
  ) {
    setCamErrorTitle(title ?? (camId ? "CAM Error" : "Job Error"));
    setCamErrorMessage(message ?? "This CAM job completed with an error.");
    setCamErrorPlateId(plateId);
    setCamErrorArrangeJobId(arrangeId);
    setCamErrorCamJobId(camId);
    setCamErrorMachineName(machineName);
    setCamErrorModalOpen(true);
  }

  function closeCamErrorModal() {
    setCamErrorModalOpen(false);
    setCamErrorMessage(null);
    setCamErrorPlateId(null);
    setCamErrorArrangeJobId(null);
    setCamErrorCamJobId(null);
    setCamErrorRetryBusy(false);
    setCamErrorMachineName(null);
  }

  function openArrangeErrorModal(
    message: string | null,
    plateId: number | null,
    arrangeId: number | null
  ) {
    if (plateId == null || arrangeId == null) return;
    setArrangeErrorMessage(message);
    setArrangeErrorPlateId(plateId);
    setArrangeErrorArrangeJobId(arrangeId);
    setArrangeErrorModalOpen(true);
  }

  function closeArrangeErrorModal() {
    setArrangeErrorModalOpen(false);
    setArrangeErrorMessage(null);
    setArrangeErrorPlateId(null);
    setArrangeErrorArrangeJobId(null);
    setArrangeErrorRetryBusy(false);
  }

  function openPlateDeleteConfirm(plateId: number | null) {
    if (plateId == null) return;
    setPlateDeleteTargetId(plateId);
    setPlateDeleteConfirmOpen(true);
  }

  function closePlateDeleteConfirm() {
    setPlateDeleteConfirmOpen(false);
    setPlateDeleteBusy(false);
    setPlateDeleteTargetId(null);
  }

  async function detectFileType(url: string, signal?: AbortSignal) {
    try {
      const head = await fetch(url, { method: "HEAD", signal });
      if (!head.ok) return null;
      const ct = head.headers.get("content-type")?.toLowerCase() ?? null;
      if (!ct) return null;
      if (ct.startsWith("image/")) return "image" as const;
      if (ct.includes("application/pdf")) return "pdf" as const;
      return "other" as const;
    } catch {
      // Common if the signed URL doesn't allow HEAD/CORS. We'll fall back to rendering as an image.
      return null;
    }
  }

  const applyExcessParts = useCallback(
    async (
      plateId: number,
      excessParts: ExcessPart[],
      plateAssignments: { partId: number; quantity: number }[]
    ) => {
      if (excessParts.length === 0) return false;

      const excessByPart = new Map<number, number>();
      for (const item of excessParts) {
        excessByPart.set(
          item.part_id,
          (excessByPart.get(item.part_id) ?? 0) + item.quantity
        );
      }

      if (plateAssignments.length === 0) {
        return false;
      }

      const removedByPart = new Map<number, number>();
      const updatedAssignments = plateAssignments
        .map((part) => {
          const totalExcess = excessByPart.get(part.partId) ?? 0;
          if (totalExcess === 0) return part;
          const alreadyRemoved = removedByPart.get(part.partId) ?? 0;
          const remainingToRemove = Math.max(0, totalExcess - alreadyRemoved);
          if (remainingToRemove === 0) return part;
          const removedQty = Math.min(part.quantity, remainingToRemove);
          if (removedQty <= 0) return part;
          removedByPart.set(
            part.partId,
            (removedByPart.get(part.partId) ?? 0) + removedQty
          );
          const quantity = part.quantity - removedQty;
          if (quantity <= 0) return null;
          return {
            ...part,
            quantity,
          };
        })
        .filter(
          (
            part
          ): part is {
            partId: number;
            quantity: number;
          } => part !== null && part.quantity > 0
        );

      if (removedByPart.size === 0) {
        return false;
      }

      setPartsToPlates((prev) => ({
        ...prev,
        [plateId]: updatedAssignments,
      }));

      const appliedExcessByPart = removedByPart;
      setUnassignedParts((prev) => {
        const next = { ...prev };
        for (const [partId, quantity] of appliedExcessByPart.entries()) {
          const before = next[partId] ?? 0;
          next[partId] = before + quantity;
        }
        return next;
      });

      try {
        const updates = Array.from(appliedExcessByPart.entries())
          .map(([partId, quantity]) => {
            const current = plateAssignments.find((p) => p.partId === partId);
            if (!current) return null;
            const newQuantity = Math.max(0, current.quantity - quantity);
            return fetch(`/api/pc/${categoryId}/assignments`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                plate_id: plateId,
                part_id: partId,
                quantity: newQuantity,
              }),
            });
          })
          .filter((request): request is Promise<Response> => request !== null);

        if (updates.length > 0) {
          const responses = await Promise.all(updates);
          const failed = responses.filter((res) => !res.ok);
          if (failed.length > 0) {
            console.error("Failed to update assignments for excess parts.");
          }
        }
      } catch (err) {
        console.error("Failed to update assignments for excess parts:", err);
      }

      return true;
    },
    [categoryId, setPartsToPlates, setUnassignedParts]
  );

  useEffect(() => {
    if (!Number.isFinite(teamDbId)) return;
    let mounted = true;
    async function loadMachinesForLabels() {
      try {
        const res = await fetch(`/api/teams/${teamDbId}/machines`);
        if (!res.ok || !mounted) return;
        const data = (await res.json()) as Array<{ id: number; name: string }>;
        setMachineNames(Object.fromEntries(data.map((m) => [m.id, m.name])));
      } catch (err) {
        console.error("Failed to load machines for labels", err);
      }
    }
    loadMachinesForLabels();
    async function loadCategoryMaterial() {
      try {
        const res = await fetch(`/api/teams/${teamDbId}/pc`);
        if (!res.ok || !mounted) return;
        const data = (await res.json()) as Array<{
          id: number;
          material?: string;
        }>;
        const category = data.find((pc) => pc.id === categoryId);
        if (category?.material && mounted)
          setMaterialNameForCategory(category.material);
      } catch (err) {
        console.error("Failed to load part category material", err);
      }
    }
    loadCategoryMaterial();
    return () => {
      mounted = false;
    };
  }, [categoryId, teamDbId]);

  useEffect(() => {
    let mounted = true;
    async function assignedParts() {
      if (!Number.isFinite(categoryId) || categoryId <= 0) return;
      if (!isValidPlateId(currentPlateId)) {
        setAssignmentsLoaded(true);
        return;
      }
      setAssignmentsLoaded(false);

      try {
        const res = await fetch(`/api/pc/${categoryId}/assignments`);
        if (!res.ok) {
          console.error("Failed to fetch assigned parts:", await res.text());
          return;
        }
        const assignments: Array<{
          part_id: number;
          plate_id: number;
          quantity: number;
        }> = await res.json();
        const newAssignments = assignments
          .map((a) => {
            if (a.plate_id !== currentPlateId) return null;
            return {
              partId: a.part_id,
              quantity: a.quantity,
            };
          })
          .filter((a): a is { partId: number; quantity: number } => a !== null);
        if (!mounted) return;
        setPartsToPlates((prev) => ({
          ...prev,
          [currentPlateId]: newAssignments,
        }));
        const jobRes = await fetch(`/api/plates/${currentPlateId}/jobs`);
        if (!jobRes.ok) {
          console.error("Failed to fetch plate jobs:", await jobRes.text());
          return;
        }
        const jobsData: PlatesJob[] = await jobRes.json();
        setJobs(jobsData);
      } finally {
        if (mounted) {
          setAssignmentsLoaded(true);
        }
      }
    }
    assignedParts();
    return () => {
      mounted = false;
    };
  }, [categoryId, currentPlateId, setPartsToPlates]);

  useEffect(() => {
    if (!assignmentsLoaded) return;
    if (!isValidPlateId(currentPlateId)) return;
    const plateAssignments = partsToPlates[currentPlateId] ?? [];

    const handleExcessParts = async () => {
      const latestArrange = jobs
        .filter((job) => job.kind === "arrange")
        .sort((a, b) => b.id - a.id)[0];
      if (!latestArrange) return;
      const jobId = latestArrange.id;
      if (handledExcessJobs.current.has(jobId)) return;
      const excessParts = getArrangeExcessParts(
        latestArrange as PlatesJobWithMeta
      );
      const oversizedParts = getArrangeOversizedParts(
        latestArrange as PlatesJobWithMeta
      );
      // Combine excess and oversized parts - both need to move back to unassigned
      const allPartsToMove = [...excessParts, ...oversizedParts];
      if (allPartsToMove.length === 0) return;
      handledExcessJobs.current.add(jobId);
      try {
        await applyExcessParts(
          currentPlateId,
          allPartsToMove,
          plateAssignments
        );
      } catch (err) {
        console.error("Failed to apply excess/oversized parts for plate:", err);
        handledExcessJobs.current.delete(jobId);
      }
    };

    void handleExcessParts();
    return () => {};
  }, [
    assignmentsLoaded,
    currentPlateId,
    jobs,
    partsToPlates,
    applyExcessParts,
  ]);

  const shouldPollJobs = jobs.some((job) => job.status !== "completed");
  useEffect(() => {
    if (!isValidPlateId(currentPlateId)) return;
    if (!shouldPollJobs) return;

    let mounted = true;
    const interval = setInterval(async () => {
      try {
        const jobRes = await fetch(`/api/plates/${currentPlateId}/jobs`);
        if (!jobRes.ok) return;
        const jobsData: PlatesJob[] = await jobRes.json();
        if (!mounted) return;
        setJobs(jobsData);
      } catch (err) {
        console.error("Error polling plate jobs:", err);
      }
    }, 2500);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [currentPlateId, shouldPollJobs]);

  useEffect(() => {
    if (camModalOpen === false || camModalArrangeJobId == null) return;
    if (!Number.isFinite(teamDbId)) {
      setCamModalError("Unable to determine team.");
      return;
    }
    let mounted = true;
    setCamModalLoading(true);
    setCamModalError(null);
    setCamFileUrl(null);
    setCamFileType(null);

    async function load() {
      try {
        const [jobRes, machinesRes, toolsRes, materialsRes] = await Promise.all(
          [
            fetch(`/api/jobs/${camModalArrangeJobId}`),
            fetch(`/api/teams/${teamDbId}/machines`),
            fetch(`/api/teams/${teamDbId}/tools`),
            fetch(`/api/teams/${teamDbId}/materials`),
          ]
        );

        if (!mounted) return;

        if (jobRes.ok) {
          const jobData: { file?: string | null } = await jobRes.json();
          const url = jobData.file ?? null;
          setCamFileUrl(url);

          if (url) {
            const detected = await detectFileType(url);
            // If we can't detect (often due to CORS/HEAD), default to image so screenshots still render.
            setCamFileType(detected ?? "image");
          } else {
            setCamFileType(null);
          }
        } else {
          // Keep loading machines/tools even if the screenshot request fails.
          setCamModalError((await jobRes.text()) || "Failed to load job.");
          setCamFileUrl(null);
          setCamFileType(null);
        }

        if (machinesRes.ok) {
          const machinesData = (await machinesRes.json()) as Array<{
            id: number;
            name: string;
            can_run_plates?: boolean;
          }>;
          const eligibleMachines = machinesData.filter(
            (machine) => machine.can_run_plates !== false
          );
          setMachines(eligibleMachines);
          setMachineNames((prev) => {
            const merged = { ...prev };
            for (const m of machinesData) merged[m.id] = m.name;
            return merged;
          });
          setSelectedMachineId((prev) => {
            if (
              prev != null &&
              eligibleMachines.some((machine) => machine.id === prev)
            ) {
              return prev;
            }
            return eligibleMachines[0]?.id ?? null;
          });
        }

        if (toolsRes.ok) {
          const toolsData = (await toolsRes.json()) as Array<{
            id: number;
            name: string;
            machine_ids?: number[];
            material_ids?: number[];
          }>;
          const libraryTools = await Promise.all(
            toolsData.map(async (toolLibrary) => {
              try {
                const libraryRes = await fetch(
                  `/api/tools/${toolLibrary.id}/library`
                );
                if (!libraryRes.ok) {
                  console.error(
                    "Failed to load tool library",
                    toolLibrary.id,
                    await libraryRes.text()
                  );
                  return [];
                }
                const libraryData = (await libraryRes.json()) as {
                  data?: Array<{
                    guid?: string;
                    description?: string;
                    type?: string;
                    default_selected?: boolean;
                  }>;
                };
                if (!Array.isArray(libraryData.data)) return [];
                return libraryData.data.map((toolItem, index) => {
                  const guid = toolItem.guid ?? `tool-${index + 1}`;
                  const name =
                    toolItem.description || `Tool ${index + 1}`;
                  return {
                    id: `${toolLibrary.id}:${guid}`,
                    name,
                    guid,
                    libraryId: toolLibrary.id,
                    libraryName: toolLibrary.name,
                    default_selected: Boolean(toolItem.default_selected),
                    machine_ids: toolLibrary.machine_ids,
                    material_ids: toolLibrary.material_ids,
                  };
                });
              } catch (err) {
                console.error(
                  "Error loading tool library",
                  toolLibrary.id,
                  err
                );
                return [];
              }
            })
          );
          if (mounted) {
            setTools(libraryTools.flat());
          }
        }

        if (materialsRes.ok) {
          const materialsData = (await materialsRes.json()) as Array<{
            id: number;
            name: string;
          }>;
          if (materialNameForCategory) {
            const match = materialsData.find(
              (m) =>
                m.name.toLowerCase() === materialNameForCategory.toLowerCase()
            );
            if (match) setMaterialIdForCategory(match.id);
          }
        }
      } catch (err) {
        console.error("Error loading CAM modal data:", err);
        if (!mounted) return;
        setCamModalError("Failed to load CAM modal data.");
      } finally {
        if (!mounted) return;
        setCamModalLoading(false);
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [camModalOpen, camModalArrangeJobId, teamDbId, materialNameForCategory]);

  useEffect(() => {
    if (!camDownloadModalOpen) return;
    if (camDownloadJobId == null || camDownloadArrangeJobId == null) return;
    let mounted = true;
    setCamDownloadLoading(true);
    setCamDownloadError(null);
    setCamBundleUrl(null);
    setArrangePreviewUrl(null);
    setArrangePreviewType(null);
    setCamDownloadMachiningTime(null);

    async function load() {
      try {
        const [camRes, arrangeRes] = await Promise.all([
          fetch(`/api/jobs/${camDownloadJobId}`),
          fetch(`/api/jobs/${camDownloadArrangeJobId}`),
        ]);

        if (!mounted) return;

        if (camRes.ok) {
          const camData: {
            file?: string | null;
            payload?: { machine_id?: number | null };
            response?: unknown;
          } = await camRes.json();
          setCamBundleUrl(camData.file ?? null);
          const machineId = camData.payload?.machine_id ?? null;
          if (typeof machineId === "number") {
            setCamDownloadMachineName(
              machineNames[machineId] ?? `Machine ${machineId}`
            );
          } else {
            setCamDownloadMachineName(null);
          }
          const timeSeconds = getMachiningTimeSeconds(camData.response);
          setCamDownloadMachiningTime(
            timeSeconds != null ? formatMachiningTime(timeSeconds) : null
          );
        } else {
          setCamDownloadError((await camRes.text()) || "Failed to load CAM.");
        }

        if (arrangeRes.ok) {
          const arrangeData: { file?: string | null } = await arrangeRes.json();
          const arrangeUrl = arrangeData.file ?? null;
          setArrangePreviewUrl(arrangeUrl);
          if (arrangeUrl) {
            const detected = await detectFileType(arrangeUrl);
            setArrangePreviewType(detected ?? "image");
          } else {
            setArrangePreviewType(null);
          }
        } else {
          setCamDownloadError(
            (await arrangeRes.text()) || "Failed to load arrange preview."
          );
        }
      } catch (err) {
        console.error("Error loading CAM download modal data:", err);
        if (!mounted) return;
        setCamDownloadError("Failed to load CAM bundle or preview.");
      } finally {
        if (!mounted) return;
        setCamDownloadLoading(false);
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [
    camDownloadModalOpen,
    camDownloadJobId,
    camDownloadArrangeJobId,
    machineNames,
  ]);

  async function deleteDownloadedCamJob() {
    if (camDownloadJobId == null) return;
    const plateId = camDownloadPlateId ?? currentPlateId;
    if (!isValidPlateId(plateId)) return;
    const jobIds = [camDownloadJobId, camDownloadArrangeJobId].filter(
      (id): id is number => typeof id === "number"
    );
    if (jobIds.length === 0) return;
    setCamDeleteBusy(true);
    setCamDownloadError(null);
    try {
      await deleteJobs(jobIds);
      const updated = await refreshJobs(plateId);
      if (updated.length === 0) {
        openPlateDeleteConfirm(plateId);
      }
      closeCamDeleteConfirm();
      closeCamDownloadModal();
    } catch (err) {
      console.error("Failed to delete downloaded CAM job:", err);
      setCamDownloadError("Failed to delete jobs. Please try again.");
    } finally {
      setCamDeleteBusy(false);
    }
  }

  async function retryCamFromError() {
    if (camErrorCamJobId == null || camErrorArrangeJobId == null) return;
    const plateId = camErrorPlateId ?? currentPlateId;
    if (plateId == null) return;
    setCamErrorRetryBusy(true);
    try {
      await deleteJobs([camErrorCamJobId]);
      await refreshJobs(plateId);
      closeCamErrorModal();
      openCamModal(plateId, camErrorArrangeJobId);
    } catch (err) {
      console.error("Failed to retry CAM job:", err);
      setCamErrorMessage("Failed to retry CAM job. Please try again.");
    } finally {
      setCamErrorRetryBusy(false);
    }
  }

  async function retryArrangeFromError() {
    if (arrangeErrorPlateId == null || arrangeErrorArrangeJobId == null) return;
    setArrangeErrorRetryBusy(true);
    try {
      await deleteJobs([arrangeErrorArrangeJobId]);
      const response = await fetch(
        `/api/plates/${arrangeErrorPlateId}/jobs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "arrange" }),
        }
      );
      if (!response.ok) {
        throw new Error(await response.text());
      }
      await refreshJobs(arrangeErrorPlateId);
      closeArrangeErrorModal();
    } catch (err) {
      console.error("Failed to retry arrange job:", err);
      setArrangeErrorMessage("Failed to retry arrange job. Please try again.");
    } finally {
      setArrangeErrorRetryBusy(false);
    }
  }

  async function refreshJobs(plateId: number) {
    if (!isValidPlateId(plateId)) {
      setJobs([]);
      return [];
    }
    const jobRes = await fetch(`/api/plates/${plateId}/jobs`);
    if (!jobRes.ok) return [];
    const jobsData: PlatesJob[] = await jobRes.json();
    setJobs(jobsData);
    return jobsData;
  }

  async function deleteJobs(jobIds: number[]) {
    for (const jobId of jobIds) {
      const res = await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
    }
  }

  async function deletePlate(plateId: number) {
    setPlateDeleteBusy(true);
    try {
      const jobsRes = await fetch(`/api/plates/${plateId}/jobs`);
      if (!jobsRes.ok) throw new Error(await jobsRes.text());
      const jobsOnPlate: PlatesJob[] = await jobsRes.json();
      if (plateId === currentPlateId) {
        setJobs(jobsOnPlate);
      }
      if (jobsOnPlate.length > 0) {
        // Remove all jobs on the plate first so nothing is orphaned.
        await deleteJobs(jobsOnPlate.map((job) => job.id));
      }
      const res = await fetch(`/api/plates/${plateId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      setPlates((prev) => prev.filter((p) => p.id !== plateId));
      setPartsToPlates((prev) => {
        const next = { ...prev };
        delete next[plateId];
        return next;
      });
      if (currentPlateId === plateId) {
        setJobs([]);
      }
      closePlateDeleteConfirm();
    } catch (err) {
      console.error("Failed to delete plate and jobs:", err);
      setPlateDeleteBusy(false);
    }
  }

  function getEligibleTools(machineId: number | null) {
    return tools.filter((tool) => {
      const machineOk =
        machineId == null ||
        !Array.isArray(tool.machine_ids) ||
        tool.machine_ids.length === 0 ||
        tool.machine_ids.includes(machineId);
      const materialOk =
        materialIdForCategory == null ||
        !Array.isArray(tool.material_ids) ||
        tool.material_ids.length === 0 ||
        tool.material_ids.includes(materialIdForCategory);
      return machineOk && materialOk;
    });
  }

  function toggleCamTool(toolId: string) {
    setCamSelectedToolIds((prev) =>
      prev.includes(toolId)
        ? prev.filter((id) => id !== toolId)
        : [...prev, toolId]
    );
    setCamModalError(null);
  }

  function toggleCamToolLibrary(toolIds: string[]) {
    if (toolIds.length === 0) return;
    setCamSelectedToolIds((prev) => {
      const allSelected = toolIds.every((id) => prev.includes(id));
      if (allSelected) {
        return prev.filter((id) => !toolIds.includes(id));
      }
      const next = new Set(prev);
      for (const id of toolIds) {
        next.add(id);
      }
      return Array.from(next);
    });
    setCamModalError(null);
  }

  function handleTrueDepthChange(value: string) {
    setTrueDepthInput(value);
    if (trueDepthSaveTimeout.current) {
      window.clearTimeout(trueDepthSaveTimeout.current);
      trueDepthSaveTimeout.current = null;
    }
    if (trueDepthStatusTimeout.current) {
      window.clearTimeout(trueDepthStatusTimeout.current);
      trueDepthStatusTimeout.current = null;
    }

    const trimmed = value.trim();
    if (trimmed === "") {
      setTrueDepthStatus("idle");
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setTrueDepthStatus("idle");
      return;
    }

    if (currentPlateId != null) {
      setPlates((prev) =>
        prev.map((plate) =>
          plate.id === currentPlateId
            ? { ...plate, true_depth: parsed }
            : plate
        )
      );
    }

    const plateId = currentPlateId;
    if (!Number.isFinite(plateId) || !Number.isInteger(plateId)) {
      setTrueDepthStatus("saved");
      trueDepthStatusTimeout.current = window.setTimeout(() => {
        setTrueDepthStatus("idle");
      }, 2000);
      return;
    }

    setTrueDepthStatus("saving");
    trueDepthSaveTimeout.current = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/plates/${plateId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ true_depth: parsed }),
        });
        if (!res.ok) {
          throw new Error(await res.text());
        }
        setTrueDepthStatus("saved");
        trueDepthStatusTimeout.current = window.setTimeout(() => {
          setTrueDepthStatus("idle");
        }, 2000);
      } catch (err) {
        console.error("Failed to save true depth:", err);
        setTrueDepthStatus("error");
      }
    }, 400);
  }

  async function syncPlateAssignments(
    plateId: number,
    desiredAssignments: { partId: number; quantity: number }[]
  ) {
    if (!Number.isFinite(categoryId) || categoryId <= 0) return false;
    try {
      const res = await fetch(`/api/pc/${categoryId}/assignments`);
      if (!res.ok) {
        console.error(
          "Failed to fetch assignments before arrange:",
          await res.text()
        );
        return false;
      }
      const assignments: Array<{
        part_id: number;
        plate_id: number;
        quantity: number;
      }> = await res.json();
      const currentAssignments = assignments.filter(
        (assignment) => assignment.plate_id === plateId
      );

      const desiredMap = new Map<number, number>();
      for (const assignment of desiredAssignments) {
        if (assignment.quantity <= 0) continue;
        desiredMap.set(
          assignment.partId,
          (desiredMap.get(assignment.partId) ?? 0) + assignment.quantity
        );
      }

      const currentMap = new Map<number, number>();
      for (const assignment of currentAssignments) {
        currentMap.set(assignment.part_id, assignment.quantity);
      }

      const partIds = new Set([...desiredMap.keys(), ...currentMap.keys()]);
      const updates = Array.from(partIds).map((partId) =>
        fetch(`/api/pc/${categoryId}/assignments`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            plate_id: plateId,
            part_id: partId,
            quantity: desiredMap.get(partId) ?? 0,
          }),
        })
      );

      if (updates.length === 0) return true;
      const responses = await Promise.all(updates);
      const failed = responses.filter((res) => !res.ok);
      if (failed.length > 0) {
        console.error("Failed to sync assignments before arrange.");
        return false;
      }
      return true;
    } catch (err) {
      console.error("Failed to sync assignments before arrange:", err);
      return false;
    }
  }

  async function handleArrange() {
    if (categoryId === 0) return;
    if (arrangeLoading) return;
    try {
      const localPlate = plates[plateIndex];
      if (!localPlate) return;
      const assignments = partsToPlates[localPlate.id] || [];
      if (assignments.filter((p) => p.quantity > 0).length === 0) {
        return;
      }

      setArrangeLoading(true);
      const databasePlates = await fetch(`/api/pc/${categoryId}/plates`);
      if (!databasePlates.ok) {
        console.error(
          "Failed to fetch database plates:",
          await databasePlates.text()
        );
        return;
      }
      const databasePlatesData: Array<{
        id: number;
        width: number;
        length: number;
        true_depth: number;
      }> = await databasePlates.json();
      const matchingPlate = databasePlatesData.find(
        (p) => p.id === localPlate.id
      );

      let realPlateId: number;
      if (!matchingPlate) {
        const createPlateRes = await fetch(`/api/pc/${categoryId}/plates`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            width: localPlate.width,
            length: localPlate.length,
            true_depth: localPlate.true_depth,
            name: `Plate ${plateIndex + 1}`,
          }),
        });

        if (!createPlateRes.ok) {
          console.error("Failed to create plate:", await createPlateRes.text());
          return;
        }

        realPlateId = (await createPlateRes.json()).id;
        for (const assignment of assignments) {
          if (assignment.quantity <= 0) continue;

          const assignRes = await fetch(`/api/pc/${categoryId}/assignments`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              plate_id: realPlateId,
              part_id: assignment.partId,
              quantity: assignment.quantity,
            }),
          });

          if (!assignRes.ok) {
            console.error(
              "Failed to assign part:",
              assignment.partId,
              await assignRes.text()
            );
          }

          const oldPart = await fetch(`/api/parts/${assignment.partId}`);
          const oldPartQuantity = (await oldPart.json()).quantity;
          const changeQuantityRes = await fetch(
            `/api/parts/${assignment.partId}`,
            {
              method: "PATCH",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                quantity: oldPartQuantity - assignment.quantity,
              }),
            }
          );
          if (!changeQuantityRes.ok) {
            console.error(
              "Failed to update part quantity:",
              await changeQuantityRes.text()
            );
          }
        }

        const oldPlateId = localPlate.id;
        const newPlates = plates.map((p, idx) =>
          idx === plateIndex ? { ...p, id: realPlateId } : p
        );
        setPlates(newPlates);

        const newPartsToPlates = { ...partsToPlates };
        newPartsToPlates[realPlateId] = newPartsToPlates[oldPlateId];
        delete newPartsToPlates[oldPlateId];
        setPartsToPlates(newPartsToPlates);
      } else {
        realPlateId = localPlate.id;
        const synced = await syncPlateAssignments(realPlateId, assignments);
        if (!synced) return;
      }

      const response = await fetch(`/api/plates/${realPlateId}/jobs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "arrange",
        }),
      });
      if (!response.ok) {
        console.error("Failed to create arrange job:", await response.text());
        return;
      }
      await response.json();
      await refreshJobs(realPlateId);
    } catch (err) {
      console.error("Error during arrange:", err);
    } finally {
      setArrangeLoading(false);
    }
  }

  async function onDeleteRun(run: PlateJobRun) {
    if (!isValidPlateId(currentPlateId)) return;
    const jobIds = [run.arrange.id, run.cam?.id].filter(
      (id): id is number => typeof id === "number"
    );
    if (jobIds.length === 0) return;

    setPendingDeleteRun(run);
  }

  async function confirmDeleteRun() {
    const run = pendingDeleteRun;
    setPendingDeleteRun(null);
    if (!run || !isValidPlateId(currentPlateId)) return;
    const jobIds = [run.arrange.id, run.cam?.id].filter(
      (id): id is number => typeof id === "number"
    );
    if (jobIds.length === 0) return;

    setJobsDeleteError(null);
    setJobsDeleteBusy((prev) => {
      const next = { ...prev };
      for (const id of jobIds) next[id] = true;
      return next;
    });

    try {
      await deleteJobs(jobIds);
      if (
        camModalArrangeJobId != null &&
        jobIds.includes(camModalArrangeJobId)
      ) {
        closeCamModal();
      }
      const updated = await refreshJobs(currentPlateId);
      if (updated.length === 0) {
        openPlateDeleteConfirm(currentPlateId);
      }
    } catch (err) {
      console.error("Failed to delete job(s):", err);
      setJobsDeleteError("Failed to delete job(s).");
    } finally {
      setJobsDeleteBusy((prev) => {
        const next = { ...prev };
        for (const id of jobIds) delete next[id];
        return next;
      });
    }
  }

  async function submitCam() {
    if (camModalPlateId == null) return;
    if (selectedMachineId == null) {
      setCamModalError("Select a machine to continue.");
      return;
    }
    if (availableCamTools.length === 0) {
      setCamModalError(
        "No tool is configured for this machine and material. Add one in Settings → Fusion Inputs."
      );
      return;
    }
    const selectedTools = camSelectedToolIds.filter((id) =>
      availableCamTools.some((tool) => tool.id === id)
    );
    const selectedToolItems = availableCamTools.filter((tool) =>
      selectedTools.includes(tool.id)
    );
    if (selectedToolItems.length === 0) {
      setCamModalError("Select at least one tool to continue.");
      return;
    }
    const toolLibraryIds = Array.from(
      new Set(selectedToolItems.map((tool) => tool.libraryId))
    );
    const toolItems = selectedToolItems.map((tool) => ({
      tool_id: tool.libraryId,
      tool_guid: tool.guid,
    }));
    setCamModalLoading(true);
    setCamModalError(null);
    try {
      const response = await fetch(`/api/plates/${camModalPlateId}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "cam",
          machine_id: selectedMachineId,
          tool_ids: toolLibraryIds,
          tool_items: toolItems,
        }),
      });
      if (!response.ok) {
        setCamModalError(await response.text());
        return;
      }
      await refreshJobs(camModalPlateId);
      closeCamModal();
    } catch (err) {
      console.error("Error creating CAM job:", err);
      setCamModalError("Failed to create CAM job.");
    } finally {
      setCamModalLoading(false);
    }
  }

  function onReceive(data: {
    partId: number;
    quantity: number;
    from?: number;
  }) {
    if (!partsToPlates || !setPartsToPlates) {
      console.warn("onReceive: partsToPlates or setPartsToPlates is not available");
      return;
    }
    const plateIndex = Number.parseInt(name);
    const plate = plates[plateIndex];
    const currentPlateId = plate?.id;
    if (currentPlateId == null) {
      console.warn("onReceive: plate or plate.id is null/undefined", { plateIndex, plate, platesLength: plates.length });
      return;
    }
    if (data.from != null && data.from === currentPlateId) return;

    if (data.from == null) {
      console.log("onReceive: Moving from unassigned to plate", {
        partId: data.partId,
        quantity: data.quantity,
        targetPlateId: currentPlateId
      });
      setUnassignedParts((prev) => {
        const currentQuantity = prev[data.partId] || 0;
        const newQuantity = Math.max(0, currentQuantity - data.quantity);
        console.log("onReceive: Reducing unassigned", {
          partId: data.partId,
          before: currentQuantity,
          after: newQuantity
        });
        return { ...prev, [data.partId]: newQuantity };
      });
    }

    setPartsToPlates((prev) => {
      console.log("onReceive: Adding to plate", {
        targetPlateId: currentPlateId,
        partId: data.partId,
        existingAssignments: prev[currentPlateId]
      });
      const next = { ...prev };

      if (data.from != null) {
        const oldPlate = next[data.from] ?? [];
        next[data.from] = oldPlate
          .map((part) =>
            part.partId === data.partId
              ? { ...part, quantity: part.quantity - data.quantity }
              : part
          )
          .filter((part) => part.quantity > 0);
      }

      const current = next[currentPlateId] ?? [];
      const exists = current.some((part) => part.partId === data.partId);
      next[currentPlateId] = exists
        ? current.map((part) =>
            part.partId === data.partId
              ? { ...part, quantity: part.quantity + data.quantity }
              : part
          )
        : [...current, { partId: data.partId, quantity: data.quantity }];

      return next;
    });
  }
  return (
    <div className={styles.cardWrapper}>
      <PlatePartsSection
        plateId={currentPlateId}
        plateIndex={plateIndex}
        parts={plateAssignments}
        onDeletePlate={openPlateDeleteConfirm}
        onArrange={handleArrange}
        onReceive={onReceive}
        arrangeLoading={arrangeLoading}
        loading={isCardLoading}
        trueDepthValue={trueDepthInput}
        trueDepthStatus={trueDepthStatus}
        onTrueDepthChange={handleTrueDepthChange}
      />
      <PlateJobsList
        currentPlateId={currentPlateId ?? null}
        jobs={jobs}
        jobsDeleteError={jobsDeleteError}
        jobsDeleteBusy={jobsDeleteBusy}
        loading={isCardLoading}
        arrangeLoading={arrangeLoading}
        onDeleteRun={onDeleteRun}
        onOpenArrangeError={openArrangeErrorModal}
        onOpenCamModal={openCamModal}
        onOpenCamError={openCamErrorModal}
        onOpenCamDownload={openCamDownloadModal}
        getArrangeErrorMessage={getArrangeErrorMessage}
        getArrangeExcessParts={getArrangeExcessParts}
        getArrangeOversizedParts={getArrangeOversizedParts}
        getJobError={getJobError}
        getCamMachineLabel={getCamMachineLabel}
      />
      <CamModal
        open={camModalOpen}
        loading={camModalLoading}
        error={camModalError}
        machines={machines}
        selectedMachineId={selectedMachineId}
        camFileUrl={camFileUrl}
        camFileType={camFileType}
        onClose={closeCamModal}
        onSelectMachine={setSelectedMachineId}
        onSubmit={submitCam}
        availableTools={availableCamTools}
        selectedToolIds={camSelectedToolIds}
        onToggleTool={toggleCamTool}
        onToggleToolLibrary={toggleCamToolLibrary}
        arrangeDimensions={
          arrangeDimensions
            ? {
                width: arrangeDimensions.width,
                length: arrangeDimensions.length,
              }
            : null
        }
        trueDepthValue={trueDepthInput}
        trueDepthStatus={trueDepthStatus}
        onTrueDepthChange={handleTrueDepthChange}
      />
      <CamDownloadModal
        open={camDownloadModalOpen}
        loading={camDownloadLoading}
        error={camDownloadError}
        arrangePreviewUrl={arrangePreviewUrl}
        arrangePreviewType={arrangePreviewType}
        camBundleUrl={camBundleUrl}
        machineName={camDownloadMachineName}
        machiningTime={camDownloadMachiningTime}
        onClose={closeCamDownloadModal}
        onOpenDeleteConfirm={openCamDeleteConfirm}
      />
      <CamDeleteConfirmModal
        open={camDeleteConfirmOpen}
        busy={camDeleteBusy}
        errorMessage={camDownloadError}
        onClose={closeCamDeleteConfirm}
        onConfirm={deleteDownloadedCamJob}
      />
      <ArrangeErrorModal
        open={arrangeErrorModalOpen}
        message={arrangeErrorMessage}
        retryBusy={arrangeErrorRetryBusy}
        onClose={closeArrangeErrorModal}
        onRetry={retryArrangeFromError}
      />
      <CamErrorModal
        open={camErrorModalOpen}
        title={camErrorTitle}
        message={camErrorMessage}
        machineName={camErrorMachineName}
        retryBusy={camErrorRetryBusy}
        onClose={closeCamErrorModal}
        onRetry={retryCamFromError}
      />
      <PlateDeleteConfirmModal
        open={plateDeleteConfirmOpen}
        busy={plateDeleteBusy}
        onClose={closePlateDeleteConfirm}
        onConfirm={() => {
          if (plateDeleteTargetId != null) deletePlate(plateDeleteTargetId);
        }}
      />
      <ConfirmationDialog
        open={pendingDeleteRun !== null}
        title="Delete queued job"
        message={pendingDeleteRun && [pendingDeleteRun.arrange.id, pendingDeleteRun.cam?.id].filter((id) => typeof id === "number").length === 1 ? "Delete this job?" : "Delete these jobs?"}
        confirmLabel="Delete"
        danger
        onCancel={() => setPendingDeleteRun(null)}
        onConfirm={confirmDeleteRun}
      />
    </div>
  );
}
