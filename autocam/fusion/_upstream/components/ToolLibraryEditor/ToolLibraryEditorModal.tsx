"use client";

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import styles from "./ToolLibraryEditorModal.module.css";
import { PrimaryButton } from "@/components/Buttons/Buttons";
import { ToolLibrary, ToolItem, createEmptyTool } from "./types";
import BasicInfoSection from "./sections/BasicInfoSection";
import GeometrySection from "./sections/GeometrySection";
import PostProcessSection from "./sections/PostProcessSection";
import PresetsSection from "./sections/PresetsSection";
import { ConfirmationDialog } from "@/components/ConfirmationDialog/ConfirmationDialog";

interface ToolLibraryEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  toolId: number;
  toolName: string;
  onSave?: () => void;
}

type TabType = "basic" | "geometry" | "postprocess" | "presets";

export default function ToolLibraryEditorModal({
  isOpen,
  onClose,
  toolId,
  toolName,
  onSave,
}: ToolLibraryEditorModalProps) {
  const [library, setLibrary] = useState<ToolLibrary | null>(null);
  const [selectedToolIndex, setSelectedToolIndex] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>("basic");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [showDiscardConfirmation, setShowDiscardConfirmation] = useState(false);

  // Load tool library when modal opens
  useEffect(() => {
    if (!isOpen || !toolId) return;
    let mounted = true;

    async function loadLibrary() {
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/tools/${toolId}/library`);
        if (!response.ok) {
          throw new Error("Failed to load tool library");
        }
        const data = await response.json();
        if (mounted) {
          setLibrary(data);
          // Select first tool by default if available
          if (data.data && data.data.length > 0) {
            setSelectedToolIndex(0);
          }
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : "Failed to load tool library");
        }
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    }

    loadLibrary();
    return () => {
      mounted = false;
    };
  }, [isOpen, toolId]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setLibrary(null);
      setSelectedToolIndex(null);
      setActiveTab("basic");
      setError(null);
      setHasUnsavedChanges(false);
    }
  }, [isOpen]);

  const selectedTool = library && selectedToolIndex !== null
    ? library.data[selectedToolIndex]
    : null;

  const handleToolUpdate = useCallback((updates: Partial<ToolItem>) => {
    if (library === null || selectedToolIndex === null) return;

    setLibrary(prev => {
      if (!prev) return prev;
      const newData = [...prev.data];
      newData[selectedToolIndex] = { ...newData[selectedToolIndex], ...updates };
      return { ...prev, data: newData };
    });
    setHasUnsavedChanges(true);
  }, [library, selectedToolIndex]);

  const handleAddTool = useCallback(() => {
    if (!library) return;

    const newTool = createEmptyTool();
    setLibrary(prev => {
      if (!prev) return prev;
      return { ...prev, data: [...prev.data, newTool] };
    });
    setSelectedToolIndex(library.data.length);
    setActiveTab("basic");
    setHasUnsavedChanges(true);
  }, [library]);

  const handleDeleteTool = useCallback(() => {
    if (library === null || selectedToolIndex === null) return;

    setLibrary(prev => {
      if (!prev) return prev;
      const newData = prev.data.filter((_, i) => i !== selectedToolIndex);
      return { ...prev, data: newData };
    });

    // Select previous tool or first tool
    if (library.data.length > 1) {
      setSelectedToolIndex(Math.max(0, selectedToolIndex - 1));
    } else {
      setSelectedToolIndex(null);
    }
    setHasUnsavedChanges(true);
  }, [library, selectedToolIndex]);

  const handleDuplicateTool = useCallback(() => {
    if (!library || selectedToolIndex === null) return;

    const toolToDuplicate = library.data[selectedToolIndex];
    const duplicatedTool = structuredClone(toolToDuplicate) as ToolItem;
    duplicatedTool.guid = crypto.randomUUID();
    duplicatedTool.last_modified = Date.now();
    if (duplicatedTool["start-values"]?.presets) {
      duplicatedTool["start-values"].presets = duplicatedTool["start-values"].presets.map(preset => ({
        ...preset,
        guid: crypto.randomUUID(),
      }));
    }

    setLibrary(prev => {
      if (!prev) return prev;
      const newData = [...prev.data];
      newData.splice(selectedToolIndex + 1, 0, duplicatedTool);
      return { ...prev, data: newData };
    });
    setSelectedToolIndex(selectedToolIndex + 1);
    setActiveTab("basic");
    setHasUnsavedChanges(true);
  }, [library, selectedToolIndex]);

  const handleSave = useCallback(async () => {
    if (!library) return;

    setIsSaving(true);
    setError(null);

    try {
      const response = await fetch(`/api/tools/${toolId}/library`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: library.data,
          version: library.version + 1,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to save tool library");
      }

      setLibrary(prev => prev ? { ...prev, version: prev.version + 1 } : prev);
      setHasUnsavedChanges(false);
      onSave?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save tool library");
    } finally {
      setIsSaving(false);
    }
  }, [library, toolId, onSave]);

  const handleClose = useCallback(() => {
    if (hasUnsavedChanges) {
      setShowDiscardConfirmation(true);
      return;
    }
    onClose();
  }, [hasUnsavedChanges, onClose]);

  const tabs: { id: TabType; label: string }[] = [
    { id: "basic", label: "Basic Info" },
    { id: "geometry", label: "Geometry" },
    { id: "postprocess", label: "Post-Process" },
    { id: "presets", label: "Presets" },
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className={styles.overlay}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={handleClose}
        >
          <motion.div
            className={styles.modal}
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className={styles.header}>
              <h2>Edit Tool Library: {toolName}</h2>
              <div className={styles.headerActions}>
                {isSaving && (
                  <span className={styles.savingIndicator}>
                    <span className={styles.savingSpinner} />
                    Saving...
                  </span>
                )}
                <button type="button" className={styles.closeButton} onClick={handleClose}>
                  <Image
                    src="/settings/teams/X.svg"
                    alt="Close"
                    className={styles.icon}
                    width={16}
                    height={16}
                  />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className={styles.body}>
              {/* Sidebar - Tool List */}
              <div className={styles.sidebar}>
                <div className={styles.sidebarHeader}>
                  <span className={styles.sidebarTitle}>Tools</span>
                  <button
                    type="button"
                    className={styles.addToolButton}
                    onClick={handleAddTool}
                    disabled={isLoading}
                    title="Add new tool"
                  >
                    <Image
                      src="/settings/teams/Plus.svg"
                      alt="Add"
                      width={18}
                      height={18}
                      className={styles.addToolIcon}
                    />
                  </button>
                </div>
                <div className={styles.toolList}>
                  {isLoading ? (
                    <div className={styles.loadingContainer}>
                      <span className={styles.loadingSpinner} />
                    </div>
                  ) : library && library.data.length > 0 ? (
                    library.data.map((tool, index) => (
                      <div
                        key={tool.guid}
                        className={`${styles.toolListItem} ${selectedToolIndex === index ? styles.active : ""}`}
                        onClick={() => setSelectedToolIndex(index)}
                      >
                        <div className={styles.toolListItemName}>
                          {tool.description || "Unnamed Tool"}
                        </div>
                        <div className={styles.toolListItemType}>
                          {tool.type}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className={styles.emptyList}>
                      No tools in library. Click + to add one.
                    </div>
                  )}
                </div>
              </div>

              {/* Editor Panel */}
              <div className={styles.editorPanel}>
                {selectedTool ? (
                  <>
                    {/* Tabs */}
                    <div className={styles.tabs}>
                      {tabs.map((tab) => (
                        <button
                          type="button"
                          key={tab.id}
                          className={`${styles.tab} ${activeTab === tab.id ? styles.active : ""}`}
                          onClick={() => setActiveTab(tab.id)}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>

                    {/* Editor Content */}
                    <div className={styles.editorContent}>
                      {error && <div className={styles.error}>{error}</div>}

                      {activeTab === "basic" && (
                        <BasicInfoSection
                          tool={selectedTool}
                          onChange={handleToolUpdate}
                        />
                      )}
                      {activeTab === "geometry" && (
                        <GeometrySection
                          geometry={selectedTool.geometry || {}}
                          unit={selectedTool.unit}
                          onChange={(geometry) => handleToolUpdate({ geometry })}
                        />
                      )}
                      {activeTab === "postprocess" && (
                        <PostProcessSection
                          postProcess={selectedTool["post-process"] || {}}
                          onChange={(postProcess) => handleToolUpdate({ "post-process": postProcess })}
                        />
                      )}
                      {activeTab === "presets" && (
                        <PresetsSection
                          presets={selectedTool["start-values"]?.presets || []}
                          unit={selectedTool.unit}
                          onChange={(presets) => handleToolUpdate({
                            "start-values": {
                              ...selectedTool["start-values"],
                              presets
                            }
                          })}
                        />
                      )}
                    </div>
                  </>
                ) : (
                  <div className={styles.noSelection}>
                    {isLoading ? (
                      <div className={styles.loadingContainer}>
                        <span className={styles.loadingSpinner} />
                      </div>
                    ) : (
                      "Select a tool from the list or add a new one"
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className={styles.footer}>
              <div className={styles.footerLeft}>
                {selectedTool && (
                  <button
                    type="button"
                    className={styles.duplicateButton}
                    onClick={handleDuplicateTool}
                    disabled={isLoading || isSaving}
                  >
                    Duplicate Tool
                  </button>
                )}
                {selectedTool && (
                  <button
                    type="button"
                    className={styles.deleteButton}
                    onClick={handleDeleteTool}
                    disabled={isLoading || isSaving}
                  >
                    Delete Tool
                  </button>
                )}
              </div>
              <div className={styles.footerRight}>
                <button type="button" className={styles.cancelButton} onClick={handleClose}>
                  Cancel
                </button>
                <PrimaryButton
                  onClick={handleSave}
                  disabled={isLoading || isSaving || !hasUnsavedChanges}
                >
                  <span className="textGradient">
                    {isSaving ? "Saving..." : "Save Changes"}
                  </span>
                </PrimaryButton>
              </div>
            </div>
            <ConfirmationDialog
              open={showDiscardConfirmation}
              title="Discard unsaved changes"
              message="You have unsaved changes. Close without saving them?"
              confirmLabel="Discard changes"
              danger
              onCancel={() => setShowDiscardConfirmation(false)}
              onConfirm={() => {
                setShowDiscardConfirmation(false);
                onClose();
              }}
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
