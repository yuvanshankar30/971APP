export const NOTIFICATION_KEYS = {
  SHIFT_ASSIGNMENTS: 'shift_assignments',
  PART_ASSIGNMENTS: 'part_assignments',
  MATCH_REMINDERS: 'match_reminders',
  SUBSYSTEM_PARTS_COMPLETE: 'subsystem_parts_complete',
  PURCHASE_APPROVED: 'purchase_approved',
  TASK_ASSIGNED: 'task_assigned',
  TASK_REVIEW_REQUESTED: 'task_review_requested',
  TASK_STATUS_CHANGED: 'task_status_changed',
  TASK_DEADLINE: 'task_deadline',
  MANUFACTURING_REQUEST: 'manufacturing_request',
  MANUFACTURING_REQUEST_STARTED: 'manufacturing_request_started',
  MANUFACTURING_REQUEST_READY: 'manufacturing_request_ready',
  MANUFACTURING_REQUEST_STALE: 'manufacturing_request_stale',
  ROUTER_STATUS_UPDATE: 'router_status_update',
  VISION_ALERT: 'vision_alert'
};

export const DEFAULT_NOTIFICATION_SETTINGS = {
  [NOTIFICATION_KEYS.SHIFT_ASSIGNMENTS]: true,
  [NOTIFICATION_KEYS.PART_ASSIGNMENTS]: true,
  [NOTIFICATION_KEYS.MATCH_REMINDERS]: true,
  [NOTIFICATION_KEYS.SUBSYSTEM_PARTS_COMPLETE]: true,
  [NOTIFICATION_KEYS.PURCHASE_APPROVED]: true,
  [NOTIFICATION_KEYS.TASK_ASSIGNED]: true,
  [NOTIFICATION_KEYS.TASK_REVIEW_REQUESTED]: true,
  [NOTIFICATION_KEYS.TASK_STATUS_CHANGED]: true,
  [NOTIFICATION_KEYS.TASK_DEADLINE]: true,
  [NOTIFICATION_KEYS.MANUFACTURING_REQUEST]: true,
  [NOTIFICATION_KEYS.MANUFACTURING_REQUEST_STARTED]: true,
  [NOTIFICATION_KEYS.MANUFACTURING_REQUEST_READY]: true,
  [NOTIFICATION_KEYS.MANUFACTURING_REQUEST_STALE]: true,
  [NOTIFICATION_KEYS.ROUTER_STATUS_UPDATE]: true,
  [NOTIFICATION_KEYS.VISION_ALERT]: true
};

export const NOTIFICATION_UI_OPTIONS = [
  {
    key: NOTIFICATION_KEYS.SHIFT_ASSIGNMENTS,
    label: 'Scouting assignments',
    description: 'Direct DM when you are assigned to a data or note scouting shift.'
  },
  {
    key: NOTIFICATION_KEYS.MATCH_REMINDERS,
    label: 'Match reminders',
    description: 'Reminder DM two minutes before a match you are scheduled to scout.'
  },
  {
    key: NOTIFICATION_KEYS.PART_ASSIGNMENTS,
    label: 'Manufacturing part assignments',
    description: 'Get pinged whenever a manufacturing lead assigns you to a part.'
  },
  {
    key: NOTIFICATION_KEYS.SUBSYSTEM_PARTS_COMPLETE,
    label: 'Subsystem part completed',
    description: 'Notify your subsystem when one of its manufacturing parts is marked complete.'
  },
  {
    key: NOTIFICATION_KEYS.PURCHASE_APPROVED,
    label: 'Purchasing approvals',
    description: 'Alert when a COTS purchase you submitted is approved.'
  },
  {
    key: NOTIFICATION_KEYS.TASK_ASSIGNED,
    label: 'Task assignments',
    description: 'Direct DM when you are assigned a new task.'
  },
  {
    key: NOTIFICATION_KEYS.TASK_REVIEW_REQUESTED,
    label: 'Task review requests',
    description: 'Alert when a task upload is ready for your review.'
  },
  {
    key: NOTIFICATION_KEYS.TASK_STATUS_CHANGED,
    label: 'Task status changes',
    description: 'Notify you when your task status is changed.'
  },
  {
    key: NOTIFICATION_KEYS.TASK_DEADLINE,
    label: 'Task deadline alerts',
    description: 'Remind you when a task deadline has passed and the task is not finished.'
  },
  {
    key: NOTIFICATION_KEYS.MANUFACTURING_REQUEST,
    label: 'Manufacturing requests (lead)',
    description: 'DM when a new manufacturing request is created for a process you lead (e.g. 3D printing).'
  },
  {
    key: NOTIFICATION_KEYS.MANUFACTURING_REQUEST_STALE,
    label: 'Manufacturing request reminders (lead)',
    description: 'Follow-up DM if a request you lead has sat untouched for a few days (up to 2 reminders).'
  },
  {
    key: NOTIFICATION_KEYS.MANUFACTURING_REQUEST_STARTED,
    label: 'Your request started',
    description: 'DM when work begins on a manufacturing request you made.'
  },
  {
    key: NOTIFICATION_KEYS.MANUFACTURING_REQUEST_READY,
    label: 'Your request is ready',
    description: 'DM when a manufacturing request you made is marked complete.'
  },
  {
    key: NOTIFICATION_KEYS.ROUTER_STATUS_UPDATE,
    label: 'Router part status updates (lead)',
    description: 'DM when a router part reaches a new pipeline step (CAM review, CAM reviewed, postprocessed, jprogged, machined, kitted). Only sent if you lead the Router workflow.'
  },
  {
    key: NOTIFICATION_KEYS.VISION_ALERT,
    label: 'Vision scouting alerts',
    description: 'DM when a vision processing run fails or a new critical discrepancy is flagged. Only sent if an admin has signed you up for Vision Alerts.'
  }
];
