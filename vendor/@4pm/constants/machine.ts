/**
 * Worker & physic-project domain constants.
 */

/** Worker status (physical machine) — aggregated from the machine's cli. */
export const WorkerStatus = {
  ONLINE: "online",
  OFFLINE: "offline",
} as const;

/** Union type of worker statuses. */
export type WorkerStatus = (typeof WorkerStatus)[keyof typeof WorkerStatus];

/** Physic-project status (the project folder on the worker). */
export const PhysicProjectStatus = {
  /** Folder not yet finalized (wizard step 2 has not run). */
  PENDING: "pending",
  ACTIVE: "active",
  /** The folder no longer exists on the worker. */
  MISSING: "missing",
  DISABLED: "disabled",
} as const;

/** Union type of physic-project statuses. */
export type PhysicProjectStatus =
  (typeof PhysicProjectStatus)[keyof typeof PhysicProjectStatus];
