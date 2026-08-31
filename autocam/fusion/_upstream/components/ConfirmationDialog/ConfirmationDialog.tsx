"use client";

import styles from "./ConfirmationDialog.module.css";

type ConfirmationDialogProps = {
  open: boolean;
  title?: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmationDialog({
  open,
  title = "Confirm action",
  message,
  confirmLabel = "Confirm",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmationDialogProps) {
  if (!open) return null;

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="confirmation-dialog-title">
        <h2 id="confirmation-dialog-title">{title}</h2>
        <p>{message}</p>
        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onCancel}>Cancel</button>
          <button type="button" className={danger ? styles.danger : styles.confirm} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
