/**
 * Renders a math function waveform to canvas.
 * The curve scrolls horizontally (phase offset) with a dot at the current value.
 */

const TWO_PI = Math.PI * 2;

export interface MathPreviewOptions {
  func: (x: number) => number;
  width: number;
  height: number;
  /** Phase offset — shifts the curve horizontally */
  phase: number;
  /** CSS color string for the curve */
  accentColor: string;
  /** Current input value — shows dot + readout (null = no dot) */
  inputValue: number | null;
  /** Function label (e.g. "sin") */
  funcLabel: string;
}

export function renderMathPreview(
  ctx: CanvasRenderingContext2D,
  opts: MathPreviewOptions,
): void {
  const { func, width, height, phase, accentColor, funcLabel, inputValue } = opts;

  // One cycle: 0 to 2π, shifted by phase
  const xMin = -Math.PI + phase;
  const xMax = Math.PI + phase;
  const yMin = -1.35;
  const yMax = 1.35;

  const toScreenX = (x: number) => ((x - xMin) / (xMax - xMin)) * width;
  const toScreenY = (y: number) => height - ((y - yMin) / (yMax - yMin)) * height;

  // Clear
  ctx.clearRect(0, 0, width, height);

  // Background
  ctx.fillStyle = 'rgba(0, 0, 0, 0.04)';
  ctx.fillRect(0, 0, width, height);

  // Horizontal grid at y = -1, -0.5, 0.5, 1
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.08)';
  ctx.lineWidth = 0.5;
  ctx.setLineDash([2, 2]);
  for (const y of [-1, -0.5, 0.5, 1]) {
    const sy = toScreenY(y);
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(width, sy);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // X-axis (y=0)
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
  ctx.lineWidth = 1;
  const yAxisScreen = toScreenY(0);
  ctx.beginPath();
  ctx.moveTo(0, yAxisScreen);
  ctx.lineTo(width, yAxisScreen);
  ctx.stroke();

  // Function curve
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const step = (xMax - xMin) / width;
  for (let px = 0; px <= width; px++) {
    const x = xMin + px * step;
    const y = func(x);
    const sy = toScreenY(y);
    if (px === 0) ctx.moveTo(px, sy);
    else ctx.lineTo(px, sy);
  }
  ctx.stroke();

  // Dot + value readout — dot stays at horizontal center, moves only on Y
  if (inputValue !== null) {
    const val = func(inputValue);
    const sx = width / 2; // always centered horizontally
    const sy = toScreenY(val);

    // Vertical line from x-axis to dot
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(sx, yAxisScreen);
    ctx.lineTo(sx, sy);
    ctx.stroke();
    ctx.setLineDash([]);

    // Dot
    ctx.fillStyle = accentColor;
    ctx.beginPath();
    ctx.arc(sx, sy, 3, 0, TWO_PI);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Value label with background pill
    const label = `${funcLabel}(${inputValue.toFixed(1)}) = ${val.toFixed(3)}`;
    ctx.font = '8px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    const metrics = ctx.measureText(label);
    const lx = width / 2;
    const ly = height - 3;
    const pw = metrics.width + 6;
    const ph = 10;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.beginPath();
    ctx.roundRect(lx - pw / 2, ly - ph + 2, pw, ph, 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.fillText(label, lx, ly);
  }
}
