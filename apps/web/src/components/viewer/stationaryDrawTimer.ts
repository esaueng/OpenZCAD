import { SEVERE_FRAME_MS } from './renderBudget';

/**
 * A few full-size scene draws can already occupy seconds of a software GPU's
 * queue before requestAnimationFrame slows down. Time two ordinary still
 * draws on that same model. Read only completed queries on a subsequent
 * frame, without scheduling work or waiting for the GPU.
 */
export class StationaryDrawTimer {
  private readonly extension;
  private readonly pending: WebGLQuery[] = [];
  private fullDraw: WebGLSync | null = null;
  private submittedAt = 0;
  private unmeasuredFullDraws = 0;
  private samples = 0;
  private fastestMs = Infinity;
  private model: object | null = null;
  private viewHeight = 0;
  private perspective = false;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.extension = gl.getExtension('EXT_disjoint_timer_query_webgl2') as {
      TIME_ELAPSED_EXT: number;
      GPU_DISJOINT_EXT: number;
    } | null;
  }

  private clearFence() {
    if (this.fullDraw) this.gl.deleteSync(this.fullDraw);
    this.fullDraw = null;
  }

  /** Keep automatic full-size fades and camera glides from filling the GPU
   * queue ahead of the user's next gesture. Explicit input can always draw. */
  submittedFullSize(now: number) {
    if (
      !this.extension ||
      !this.model ||
      (this.samples === 2 && this.fastestMs <= SEVERE_FRAME_MS)
    )
      return;
    // An external profiler can hold the timer target indefinitely. Bound
    // the provisional pacing when there is still no measurement in flight.
    if (
      this.samples < 2 &&
      !this.pending.length &&
      ++this.unmeasuredFullDraws > 8
    )
      return;
    // Also pace the initial fade while its full-size samples are still in
    // flight. Keep its oldest unsignaled fence across explicit input draws.
    if (this.waitingForFullSize()) return;
    this.fullDraw = this.gl.fenceSync(this.gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    this.submittedAt = now;
  }

  waitingForFullSize(): boolean {
    if (!this.fullDraw) return false;
    if (
      this.gl.clientWaitSync(this.fullDraw, 0, 0) === this.gl.TIMEOUT_EXPIRED
    ) {
      return true;
    }
    this.clearFence();
    return false;
  }

  /** An unsignaled fence this old is direct evidence of an existing backlog,
   * even before the timer queries have returned their first measurements. */
  backlogMs(now: number): number | null {
    const age = now - this.submittedAt;
    return this.fullDraw && age > SEVERE_FRAME_MS && this.waitingForFullSize()
      ? age
      : null;
  }

  reset() {
    this.clearFence();
    for (const query of this.pending) this.gl.deleteQuery(query);
    this.pending.length = 0;
    this.fastestMs = Infinity;
    this.unmeasuredFullDraws = 0;
    this.samples = 0;
    this.model = null;
  }

  /** A lower bound from two independent draws of the current scene. */
  read(
    model: object | null,
    viewHeight = 1,
    perspective = false
  ): number | null {
    if (
      model !== this.model ||
      perspective !== this.perspective ||
      Math.abs(viewHeight - this.viewHeight) > Math.abs(this.viewHeight) * 1e-12
    ) {
      this.reset();
      this.model = model;
      this.viewHeight = viewHeight;
      this.perspective = perspective;
    }
    const { gl, extension } = this;
    if (!extension || !model) return null;
    if (this.pending.length) {
      if (gl.getParameter(extension.GPU_DISJOINT_EXT)) {
        this.reset();
        return null;
      }
      while (this.pending.length) {
        const query = this.pending[0]!;
        if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
        const ms = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
        gl.deleteQuery(query);
        this.pending.shift();
        if (Number.isFinite(ms) && ms > 0) {
          this.samples++;
          this.fastestMs = Math.min(this.fastestMs, ms);
        }
      }
    }
    return this.samples === 2 ? this.fastestMs : null;
  }

  draw(render: () => void) {
    const { gl, extension } = this;
    if (!extension || !this.model || this.samples + this.pending.length >= 2) {
      render();
      return;
    }
    const target = extension.TIME_ELAPSED_EXT;
    const query = gl.getQuery(target, gl.CURRENT_QUERY)
      ? null
      : gl.createQuery();
    if (!query) {
      render();
      return;
    }
    gl.beginQuery(target, query);
    try {
      render();
    } finally {
      gl.endQuery(target);
      this.pending.push(query);
    }
  }
}
