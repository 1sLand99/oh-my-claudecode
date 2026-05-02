import { describe, expect, it } from 'vitest';
import {
  TEAM_REMINDER_INTENTS,
  isTeamReminderIntent,
  resolveLeaderNudgeIntent,
} from '../reminder-intents.js';

describe('reminder-intents OMX parity surface', () => {
  it('exposes the OMX reminder intent vocabulary', () => {
    expect(TEAM_REMINDER_INTENTS).toEqual([
      'followup-reuse',
      'followup-relaunch',
      'stalled-unblock',
      'done-review-or-shutdown',
      'pending-mailbox-review',
    ]);
    expect(isTeamReminderIntent('stalled-unblock')).toBe(true);
    expect(isTeamReminderIntent('unknown')).toBe(false);
  });

  it('maps leader nudge reasons to the same intent classes as OMX', () => {
    expect(resolveLeaderNudgeIntent('new_mailbox_message')).toBe('pending-mailbox-review');
    expect(resolveLeaderNudgeIntent('ack_without_start_evidence')).toBe('stalled-unblock');
    expect(resolveLeaderNudgeIntent('done_waiting_on_leader')).toBe('done-review-or-shutdown');
    expect(resolveLeaderNudgeIntent('all_workers_idle')).toBe('followup-relaunch');
    expect(resolveLeaderNudgeIntent('all_workers_idle', { leaderActionState: 'done_waiting_on_leader' })).toBe('done-review-or-shutdown');
    expect(resolveLeaderNudgeIntent('stale_leader_panes_alive')).toBe('followup-reuse');
  });
});
