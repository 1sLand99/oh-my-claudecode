// Budget-coherent PER-CALL ceiling for nested git calls in generic hooks.
// 2000ms is below the 3s shipped-hook inner runner budget (2500ms after the
// 500ms host-fuse cushion), so an inner git timeout fires before run.cjs reaps
// the hook. Non-proportional by design (see #3493, #3920).
export const BOUNDED_GIT_TIMEOUT_MS = 2000;
