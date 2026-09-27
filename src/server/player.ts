// Server-side player: authoritative simulation state, input queue, lag-comp history, stats.
import { MAX_LAG_COMP, TICK_RATE } from '../shared/constants';
import type { Action, CosmeticLoadout } from '../shared/protocol';
import { MatchStats, emptyStats } from '../shared/progression';
import { InputCmd, Mode, SimState, createSim } from '../shared/sim';
import type { BotBrain } from './bot';
import type { Profile } from './profiles';

export interface ClientLink {
  send(msg: unknown): void;
  sendBin(data: Uint8Array): void;
  readonly open: boolean;
  profileId: string | null;
}

export type QueueItem = { kind: 'input'; cmd: InputCmd } | { kind: 'action'; act: Action };

const HIST = Math.ceil(MAX_LAG_COMP * TICK_RATE) + 4;

export interface Channel {
  kind: 'chest' | 'ammo' | 'supply' | 'revive' | 'spire';
  id: number;
  t: number;
  dur: number;
}

export class ServerPlayer {
  sim: SimState;
  queue: QueueItem[] = [];
  lastSeq = 0;
  lastViewTick = 0;
  inputBudget = 0.1;
  lastInputAt = 0;

  alive = true; // standing or downed
  downed = false;
  downedHp = 0;
  eliminated = false;
  eliminatedAt = 0;
  placement = 0;
  resultsSent = false;
  disconnectedAt: number | null = null;
  leftMatch = false;

  stats: MatchStats = emptyStats();
  channel: Channel | null = null;
  lastBuildAt = -10;
  lastDamagedAt = -10;
  lastAttacker = 0;
  knockedBy = 0;
  spectating = 0;
  overTime = 0; // fizzpop remaining
  chips: number[] = []; // rebirth chips carried (player ids)
  landed = false;
  vehicleId = 0;
  seat = 0;
  lastPos = { x: 0, z: 0 };
  outbox: unknown[] = [];
  lastSnapshotTick = 0;
  stormAccum = 0;
  profile: Profile | null = null;

  // lag-comp history ring buffer: tick, x, y, z, crouch, mode
  private hTick = new Int32Array(HIST).fill(-1);
  private hPos = new Float32Array(HIST * 5);

  constructor(
    public id: number,
    public name: string,
    public team: number,
    public cos: CosmeticLoadout,
    public level: number,
    public link: ClientLink | null,
    public bot: BotBrain | null,
  ) {
    this.sim = createSim();
  }

  get isBot() {
    return this.bot !== null;
  }

  get connected() {
    return !!this.link && this.link.open;
  }

  get standing() {
    return this.alive && !this.downed;
  }

  record(tick: number) {
    const i = tick % HIST;
    this.hTick[i] = tick;
    const s = this.sim;
    this.hPos[i * 5] = s.x;
    this.hPos[i * 5 + 1] = s.y;
    this.hPos[i * 5 + 2] = s.z;
    this.hPos[i * 5 + 3] = s.crouch ? 1 : 0;
    this.hPos[i * 5 + 4] = s.mode;
  }

  /** Position at a (fractional) past tick for lag compensation. */
  posAt(tickF: number, nowTick: number): { x: number; y: number; z: number; crouch: boolean; mode: Mode } {
    const minTick = nowTick - MAX_LAG_COMP * TICK_RATE;
    const t = Math.max(minTick, Math.min(nowTick, tickF));
    const a = Math.floor(t);
    const b = a + 1;
    const f = t - a;
    const ia = a % HIST, ib = b % HIST;
    const s = this.sim;
    const okA = this.hTick[ia] === a;
    const okB = this.hTick[ib] === b;
    if (!okA && !okB) return { x: s.x, y: s.y, z: s.z, crouch: s.crouch, mode: s.mode };
    if (!okB || f === 0) {
      return { x: this.hPos[ia * 5], y: this.hPos[ia * 5 + 1], z: this.hPos[ia * 5 + 2], crouch: this.hPos[ia * 5 + 3] > 0, mode: this.hPos[ia * 5 + 4] as Mode };
    }
    if (!okA) {
      return { x: this.hPos[ib * 5], y: this.hPos[ib * 5 + 1], z: this.hPos[ib * 5 + 2], crouch: this.hPos[ib * 5 + 3] > 0, mode: this.hPos[ib * 5 + 4] as Mode };
    }
    const L = (k: number) => this.hPos[ia * 5 + k] + (this.hPos[ib * 5 + k] - this.hPos[ia * 5 + k]) * f;
    return { x: L(0), y: L(1), z: L(2), crouch: this.hPos[ib * 5 + 3] > 0, mode: this.hPos[ib * 5 + 4] as Mode };
  }

  send(msg: unknown) {
    this.outbox.push(msg);
  }
}
