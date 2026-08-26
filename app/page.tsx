'use client';

import { ChangeEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';

type Vec3 = [number, number, number];
type MapPoint = { sourceIndex: number; xyz: Vec3; status: 'ok' | 'placeholder' | 'outlier' };
type Panel = { id: string; name: string; indices: number[]; color: string; enabled: boolean };
type Camera = { yaw: number; pitch: number; zoom: number };
type Projection = { sourceIndex: number; u: number; v: number };

const COLORS = ['#ff4f87', '#8c7cff', '#37d9c5', '#ffae4f', '#4fa8ff', '#d875ff'];
const fmt = new Intl.NumberFormat('de-DE');

function median(values: number[]) {
  if (!values.length) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function dist(a: Vec3, b: Vec3) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function makeDemo() {
  const coords: Vec3[] = [];
  const addPanel = (cx: number, cy: number, cz: number, tilt: number) => {
    for (let row = 0; row < 8; row++) for (let col = 0; col < 12; col++) {
      coords.push([cx + col * 1.05, cy + row * 1.05, cz + col * tilt + Math.sin(row * .7) * .08]);
    }
  };
  addPanel(-20, -4, 3, -.16); addPanel(-4, -5, 0, .02); addPanel(13, -3, -2, .18);
  return coords;
}

function extractCoordinates(value: unknown): Vec3[] {
  const parseRows = (rows: unknown[]): Vec3[] => rows.map((row, index) => {
    if (Array.isArray(row) && row.length >= 2) {
      const nums = [Number(row[0]), Number(row[1]), Number(row[2] ?? 0)];
      if (nums.every(Number.isFinite)) return nums as Vec3;
    }
    if (row && typeof row === 'object') {
      const item = row as Record<string, unknown>;
      const nums = [Number(item.x), Number(item.y), Number(item.z ?? 0)];
      if (nums.every(Number.isFinite)) return nums as Vec3;
    }
    throw new Error(`Eintrag ${index + 1} enthält keine gültigen x/y/z-Koordinaten.`);
  });
  if (Array.isArray(value)) return parseRows(value);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['coordinates', 'points', 'map', 'pixelMap']) if (Array.isArray(obj[key])) return parseRows(obj[key] as unknown[]);
  }
  throw new Error('Erwartet wird ein JSON-Array mit [x, y, z]-Punkten.');
}

function analyze(coords: Vec3[]) {
  const originCount = coords.filter(([x, y, z]) => x === 0 && y === 0 && z === 0).length;
  const candidates = coords.map((xyz, sourceIndex) => ({ xyz, sourceIndex })).filter(p => !(originCount > 1 && p.xyz[0] === 0 && p.xyz[1] === 0 && p.xyz[2] === 0));
  const nearest = candidates.map((point, i) => {
    let best = Infinity;
    for (let j = 0; j < candidates.length; j++) if (i !== j) best = Math.min(best, dist(point.xyz, candidates[j].xyz));
    return best;
  }).filter(Number.isFinite);
  const pitch = median(nearest);
  const eps = Math.max(pitch * 3, 1e-6);
  const parent = candidates.map((_, i) => i);
  const find = (n: number): number => parent[n] === n ? n : (parent[n] = find(parent[n]));
  const unite = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) if (dist(candidates[i].xyz, candidates[j].xyz) <= eps) unite(i, j);
  const grouped = new Map<number, number[]>();
  candidates.forEach((point, i) => { const root = find(i); grouped.set(root, [...(grouped.get(root) ?? []), point.sourceIndex]); });
  const minSize = Math.max(6, Math.ceil(candidates.length * .005));
  const clusters = [...grouped.values()].filter(group => group.length >= minSize).sort((a, b) => Math.min(...a) - Math.min(...b));
  const clustered = new Set(clusters.flat());
  const points: MapPoint[] = coords.map((xyz, sourceIndex) => ({
    sourceIndex, xyz,
    status: originCount > 1 && xyz[0] === 0 && xyz[1] === 0 && xyz[2] === 0 ? 'placeholder' : clustered.has(sourceIndex) ? 'ok' : 'outlier',
  }));
  const panels: Panel[] = clusters.map((indices, i) => ({ id: `panel-${Date.now()}-${i}`, name: `Panel ${String(i + 1).padStart(2, '0')}`, indices: indices.sort((a, b) => a - b), color: COLORS[i % COLORS.length], enabled: true }));
  return { points, panels, pitch, originCount, outliers: points.filter(p => p.status === 'outlier').length };
}

function dot(a: Vec3, b: Vec3) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(v: Vec3): Vec3 { const n = Math.hypot(...v) || 1; return [v[0] / n, v[1] / n, v[2] / n]; }
function mul(m: number[][], v: Vec3): Vec3 { return [dot(m[0] as Vec3, v), dot(m[1] as Vec3, v), dot(m[2] as Vec3, v)]; }
function power(m: number[][], seed: Vec3): Vec3 { let v = norm(seed); for (let i = 0; i < 24; i++) v = norm(mul(m, v)); return v; }

function projectPanel(panel: Panel, points: MapPoint[]): Projection[] {
  const pts = panel.indices.map(index => points[index]).filter(Boolean);
  if (!pts.length) return [];
  const c: Vec3 = [0, 0, 0];
  pts.forEach(p => p.xyz.forEach((n, i) => { c[i] += n / pts.length; }));
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  pts.forEach(p => { const d: Vec3 = [p.xyz[0] - c[0], p.xyz[1] - c[1], p.xyz[2] - c[2]]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += d[i] * d[j]; });
  let e1 = power(cov, [1, .4, .2]);
  const lambda = dot(e1, mul(cov, e1));
  const deflated = cov.map((row, i) => row.map((value, j) => value - lambda * e1[i] * e1[j]));
  let e2 = power(deflated, [.2, 1, .3]);
  const first = pts[0].xyz, last = pts[pts.length - 1].xyz;
  const travel: Vec3 = [last[0] - first[0], last[1] - first[1], last[2] - first[2]];
  if (dot(e1, travel) < 0) e1 = [-e1[0], -e1[1], -e1[2]];
  if (Math.abs(dot(e1, e2)) > .15) e2 = norm([e2[0] - dot(e1, e2) * e1[0], e2[1] - dot(e1, e2) * e1[1], e2[2] - dot(e1, e2) * e1[2]]);
  return pts.map(p => { const d: Vec3 = [p.xyz[0] - c[0], p.xyz[1] - c[1], p.xyz[2] - c[2]]; return { sourceIndex: p.sourceIndex, u: dot(d, e1), v: -dot(d, e2) }; });
}

function xmlEscape(value: string) { return value.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] ?? c)); }
function safeName(value: string) { return value.trim().replace(/[^a-z0-9äöüß_-]+/gi, '-').replace(/^-|-$/g, '') || 'fixture'; }

function layoutPanels(panels: Panel[], points: MapPoint[], ledSize: number) {
  let offsetX = ledSize * 2;
  let maxHeight = 100;
  const laid: { panel: Panel; pixels: (Projection & { x: number; y: number })[] }[] = [];
  panels.forEach(panel => {
    const projected = projectPanel(panel, points);
    const uMin = Math.min(...projected.map(p => p.u)), uMax = Math.max(...projected.map(p => p.u));
    const vMin = Math.min(...projected.map(p => p.v)), vMax = Math.max(...projected.map(p => p.v));
    const nearest2d = projected.map((p, i) => Math.min(...projected.filter((_, j) => i !== j).map(q => Math.hypot(p.u - q.u, p.v - q.v)))).filter(Number.isFinite);
    const scale = 14 / Math.max(median(nearest2d), .001);
    const pixels = projected.map(p => ({ ...p, x: offsetX + (p.u - uMin) * scale, y: ledSize * 2 + (p.v - vMin) * scale }));
    const width = Math.max((uMax - uMin) * scale + ledSize * 4, ledSize * 6);
    maxHeight = Math.max(maxHeight, (vMax - vMin) * scale + ledSize * 4);
    laid.push({ panel, pixels }); offsetX += width + 36;
  });
  return { groups: laid, width: Math.ceil(offsetX), height: Math.ceil(maxHeight) };
}

function addressMap(indices: number[], universeStart: number, channelStart: number, channels: number) {
  let universe = universeStart, channel = channelStart;
  const result = new Map<number, { universe: number; channel: number }>();
  indices.sort((a, b) => a - b).forEach(index => {
    if (channel + channels - 1 > 512) { universe += 1; channel = 1; }
    result.set(index, { universe, channel }); channel += channels;
  });
  return result;
}

function buildSvg(panels: Panel[], points: MapPoint[], settings: ExportSettings) {
  const layout = layoutPanels(panels, points, settings.ledSize);
  const indices = panels.flatMap(p => p.indices).sort((a, b) => a - b);
  const addresses = addressMap(indices, settings.universe, settings.channel, settings.channels);
  const groups = layout.groups.map(group => `  <g id="${xmlEscape(group.panel.name)}">\n${group.pixels.map(pixel => {
    const patch = addresses.get(pixel.sourceIndex)!;
    return `    <rect id="${xmlEscape(group.panel.name)}-Pixel-${String(pixel.sourceIndex + 1).padStart(4, '0')}" x="${pixel.x.toFixed(2)}" y="${pixel.y.toFixed(2)}" width="${settings.ledSize}" height="${settings.ledSize}" universe="${patch.universe}" channel="${patch.channel}" fixture_type="fixture_quad" fixture_definition="${xmlEscape(settings.definition)}"/>`;
  }).join('\n')}\n  </g>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">\n${groups}\n</svg>\n`;
}

function buildCsv(panels: Panel[], points: MapPoint[], settings: ExportSettings) {
  const layout = layoutPanels(panels, points, settings.ledSize);
  const indices = panels.flatMap(p => p.indices).sort((a, b) => a - b);
  const addresses = addressMap(indices, settings.universe, settings.channel, settings.channels);
  const rows = ['Fixture Definition Name;Start Universe;Start Channel;StartX;StartY;EndX;EndY;Width;Fixture Name (optional)'];
  layout.groups.forEach(group => group.pixels.forEach(pixel => {
    const patch = addresses.get(pixel.sourceIndex)!;
    rows.push(`${settings.definition};${patch.universe};${patch.channel};${pixel.x.toFixed(2)};${pixel.y.toFixed(2)};${(pixel.x + settings.ledSize).toFixed(2)};${(pixel.y + settings.ledSize).toFixed(2)};${settings.ledSize};${group.panel.name}/Pixel-${String(pixel.sourceIndex + 1).padStart(4, '0')}`);
  }));
  return rows.join('\n') + '\n';
}

function buildMmfl(panels: Panel[], points: MapPoint[], settings: ExportSettings) {
  const fixtures = panels.map(panel => {
    const projected = projectPanel(panel, points);
    const nearest2d = projected.map((p, i) => Math.min(...projected.filter((_, j) => i !== j).map(q => Math.hypot(p.u - q.u, p.v - q.v)))).filter(Number.isFinite);
    const pitch = Math.max(median(nearest2d), .001);
    const uMin = Math.min(...projected.map(p => p.u)), vMin = Math.min(...projected.map(p => p.v));
    const cells = projected.map((p, rank) => ({ x: Math.round((p.u - uMin) / pitch), y: Math.round((p.v - vMin) / pitch), value: 1 + rank * settings.channels }));
    const width = Math.max(...cells.map(c => c.x)) + 1, height = Math.max(...cells.map(c => c.y)) + 1;
    const grid = Array.from({ length: width * height }, () => 0);
    cells.forEach(cell => { if (!grid[cell.y * width + cell.x]) grid[cell.y * width + cell.x] = cell.value; });
    return `  <LEDFixture favorite="1" group="Pixel Fixture Studio" product="${xmlEscape(panel.name)}">\n    <PixelMapping avoidCrossUniversePixels="1" type="${settings.channels === 4 ? 'RGBW' : 'RGB'}" height="${height}" width="${width}">${grid.join(' ')}</PixelMapping>\n  </LEDFixture>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<LEDFixtureLibrary>\n${fixtures.join('\n')}\n</LEDFixtureLibrary>\n`;
}

type ExportSettings = { universe: number; channel: number; channels: number; ledSize: number; definition: string };

function download(name: string, content: string, type: string) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], { type })); link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function MapCanvas({ points, panels, selectionMode, onSelection, view }: { points: MapPoint[]; panels: Panel[]; selectionMode: boolean; onSelection: (indices: number[]) => void; view: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const camera = useRef<Camera>({ yaw: -.5, pitch: -.28, zoom: 1 });
  const drag = useRef<{ x: number; y: number; yaw: number; pitch: number; selecting: boolean } | null>(null);
  const [box, setBox] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [revision, setRevision] = useState(0);
  const projectedRef = useRef<{ index: number; x: number; y: number }[]>([]);

  useEffect(() => {
    if (view === 'Top') camera.current = { yaw: 0, pitch: -Math.PI / 2, zoom: camera.current.zoom };
    else if (view === 'Front') camera.current = { yaw: 0, pitch: 0, zoom: camera.current.zoom };
    else if (view === 'Side') camera.current = { yaw: -Math.PI / 2, pitch: 0, zoom: camera.current.zoom };
    else camera.current = { yaw: -.5, pitch: -.28, zoom: camera.current.zoom };
    setRevision(r => r + 1);
  }, [view]);

  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const render = () => {
      const rect = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
      canvas.width = rect.width * ratio; canvas.height = rect.height * ratio; ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      const visible = panels.filter(p => p.enabled).flatMap(panel => panel.indices.map(index => ({ index, color: panel.color })));
      const center: Vec3 = [0, 0, 0]; visible.forEach(item => points[item.index].xyz.forEach((n, i) => center[i] += n / Math.max(visible.length, 1)));
      const rotated = visible.map(item => {
        const p = points[item.index].xyz, x = p[0] - center[0], y = p[1] - center[1], z = p[2] - center[2];
        const cy = Math.cos(camera.current.yaw), sy = Math.sin(camera.current.yaw), cp = Math.cos(camera.current.pitch), sp = Math.sin(camera.current.pitch);
        const x1 = x * cy - z * sy, z1 = x * sy + z * cy, y1 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
        return { ...item, x: x1, y: y1, z: z2 };
      });
      const span = Math.max(...rotated.map(p => Math.abs(p.x)), ...rotated.map(p => Math.abs(p.y)), 1);
      const scale = Math.min(rect.width, rect.height) * .39 / span * camera.current.zoom;
      ctx.strokeStyle = 'rgba(137,151,178,.12)'; ctx.lineWidth = 1;
      for (let i = -5; i <= 5; i++) { ctx.beginPath(); ctx.moveTo(rect.width * .08, rect.height / 2 + i * 38); ctx.lineTo(rect.width * .92, rect.height / 2 + i * 38); ctx.stroke(); }
      rotated.sort((a, b) => a.z - b.z);
      projectedRef.current = rotated.map(p => ({ index: p.index, x: rect.width / 2 + p.x * scale, y: rect.height / 2 - p.y * scale }));
      rotated.forEach((p, i) => { const screen = projectedRef.current[i]; ctx.shadowColor = p.color; ctx.shadowBlur = 8; ctx.fillStyle = p.color; ctx.globalAlpha = .66 + i / Math.max(rotated.length, 1) * .34; ctx.beginPath(); ctx.arc(screen.x, screen.y, Math.max(2, Math.min(4.2, 2.3 * camera.current.zoom)), 0, Math.PI * 2); ctx.fill(); });
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
      points.filter(p => p.status !== 'ok').forEach(p => {
        const visiblePoint = projectedRef.current.find(q => q.index === p.sourceIndex); if (!visiblePoint) return;
        ctx.strokeStyle = p.status === 'outlier' ? '#ffb454' : '#5f6a80'; ctx.strokeRect(visiblePoint.x - 3, visiblePoint.y - 3, 6, 6);
      });
      if (box) { ctx.fillStyle = 'rgba(255,79,135,.12)'; ctx.strokeStyle = '#ff4f87'; ctx.setLineDash([5, 4]); ctx.fillRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1); ctx.strokeRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1); ctx.setLineDash([]); }
    };
    render(); const observer = new ResizeObserver(render); observer.observe(canvas); return () => observer.disconnect();
  }, [points, panels, box, revision]);

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const r = event.currentTarget.getBoundingClientRect(); const x = event.clientX - r.left, y = event.clientY - r.top;
    const selecting = selectionMode || event.shiftKey;
    drag.current = { x, y, yaw: camera.current.yaw, pitch: camera.current.pitch, selecting };
    if (selecting) setBox({ x1: x, y1: y, x2: x, y2: y });
  };
  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return; const r = event.currentTarget.getBoundingClientRect(); const x = event.clientX - r.left, y = event.clientY - r.top;
    if (drag.current.selecting) setBox(old => old ? { ...old, x2: x, y2: y } : null);
    else { camera.current.yaw = drag.current.yaw + (x - drag.current.x) * .008; camera.current.pitch = Math.max(-1.5, Math.min(1.5, drag.current.pitch + (y - drag.current.y) * .008)); setRevision(v => v + 1); }
  };
  const pointerUp = () => {
    if (drag.current?.selecting && box) {
      const minX = Math.min(box.x1, box.x2), maxX = Math.max(box.x1, box.x2), minY = Math.min(box.y1, box.y2), maxY = Math.max(box.y1, box.y2);
      onSelection(projectedRef.current.filter(p => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY).map(p => p.index));
      setBox(null);
    }
    drag.current = null;
  };
  const wheel = (event: React.WheelEvent<HTMLCanvasElement>) => { event.preventDefault(); camera.current.zoom = Math.max(.3, Math.min(5, camera.current.zoom * Math.exp(-event.deltaY * .001))); setRevision(v => v + 1); };

  return <canvas ref={ref} className={`map-canvas ${selectionMode ? 'selecting' : ''}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onWheel={wheel} aria-label="Interaktive 3D-Vorschau der LED-Koordinaten" />;
}

function FixturePreview({ panel, points, ledSize }: { panel?: Panel; points: MapPoint[]; ledSize: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current, projected = panel ? projectPanel(panel, points) : []; if (!canvas) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const rect = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1; canvas.width = rect.width * ratio; canvas.height = rect.height * ratio; ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
    if (!projected.length) return;
    const uMin = Math.min(...projected.map(p => p.u)), uMax = Math.max(...projected.map(p => p.u)), vMin = Math.min(...projected.map(p => p.v)), vMax = Math.max(...projected.map(p => p.v));
    const scale = Math.min((rect.width - 24) / Math.max(uMax - uMin, 1), (rect.height - 24) / Math.max(vMax - vMin, 1));
    projected.forEach((p, i) => { const x = 12 + (p.u - uMin) * scale, y = 12 + (p.v - vMin) * scale; ctx.fillStyle = panel?.color ?? '#ff4f87'; ctx.globalAlpha = .6 + .4 * i / projected.length; ctx.fillRect(x - ledSize / 5, y - ledSize / 5, Math.max(2, ledSize / 2.5), Math.max(2, ledSize / 2.5)); }); ctx.globalAlpha = 1;
  }, [panel, points, ledSize]);
  return <canvas ref={ref} className="fixture-canvas" aria-label="2D-Projektion wie in MadMapper" />;
}

export default function Home() {
  const initial = useMemo(() => analyze(makeDemo()), []);
  const [points, setPoints] = useState(initial.points); const [panels, setPanels] = useState(initial.panels);
  const [fileName, setFileName] = useState('Demo · 3 Panels'); const [pitch, setPitch] = useState(initial.pitch); const [activeId, setActiveId] = useState(initial.panels[0]?.id ?? '');
  const [view, setView] = useState('3D'); const [selectionMode, setSelectionMode] = useState(false); const [selection, setSelection] = useState<number[]>([]);
  const [message, setMessage] = useState('Beispieldaten aktiv — lade deine Pixelblaze JSON-Datei.'); const [error, setError] = useState(''); const [showExport, setShowExport] = useState(false); const [showHelp, setShowHelp] = useState(false);
  const [settings, setSettings] = useState<ExportSettings>({ universe: 0, channel: 1, channels: 3, ledSize: 6, definition: 'Generic - Pixel RGB' });
  const inputRef = useRef<HTMLInputElement>(null);
  const active = panels.find(p => p.id === activeId) ?? panels[0];
  const enabledPanels = panels.filter(p => p.enabled);
  const placeholders = points.filter(p => p.status === 'placeholder').length, outliers = points.filter(p => p.status === 'outlier').length;

  const loadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      const coords = extractCoordinates(JSON.parse(await file.text()));
      if (coords.length > 20000) throw new Error('Für die interaktive Vorschau sind maximal 20.000 LEDs vorgesehen.');
      const result = analyze(coords); if (!result.panels.length) throw new Error('Keine zusammenhängenden LED-Bereiche erkannt. Nutze eine sauber gescannte Map oder wähle Punkte manuell.');
      setPoints(result.points); setPanels(result.panels); setActiveId(result.panels[0].id); setPitch(result.pitch); setFileName(file.name); setSelection([]); setError('');
      setMessage(`${fmt.format(coords.length)} Slots geladen · ${result.panels.length} Panels automatisch erkannt.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Die Datei konnte nicht gelesen werden.'); }
    event.target.value = '';
  };
  const togglePanel = (id: string) => setPanels(items => items.map(item => item.id === id ? { ...item, enabled: !item.enabled } : item));
  const addSelection = () => {
    if (!selection.length) { setMessage('Ziehe zuerst im Auswahlmodus einen Rahmen um LEDs.'); return; }
    const id = `manual-${Date.now()}`; const newPanel: Panel = { id, name: `Auswahl ${panels.length + 1}`, indices: [...selection].sort((a, b) => a - b), color: COLORS[panels.length % COLORS.length], enabled: true };
    setPanels(items => [...items, newPanel]); setActiveId(id); setSelection([]); setSelectionMode(false); setMessage(`${fmt.format(newPanel.indices.length)} LEDs als neuer Bereich angelegt.`);
  };
  const exportFile = (format: 'svg' | 'csv' | 'mmfl') => {
    if (!enabledPanels.length) { setError('Aktiviere mindestens ein Panel für den Export.'); return; }
    const base = safeName(fileName.replace(/\.json$/i, ''));
    if (format === 'svg') download(`${base}-madmapper.svg`, buildSvg(enabledPanels, points, settings), 'image/svg+xml');
    if (format === 'csv') download(`${base}-madmapper.csv`, buildCsv(enabledPanels, points, settings), 'text/csv');
    if (format === 'mmfl') download(`${base}-fixtures.mmfl`, buildMmfl(enabledPanels, points, settings), 'application/xml');
    setMessage(`${format.toUpperCase()} für ${enabledPanels.length} Panel${enabledPanels.length === 1 ? '' : 's'} erstellt.`);
  };

  return (
    <main className="app-shell">
      <input ref={inputRef} type="file" accept=".json,application/json" hidden onChange={loadFile} />
      <header className="topbar">
        <div className="brand-mark">PX</div><div className="brand-copy"><strong>Pixel Fixture Studio</strong><span>Pixelblaze → MadMapper 6.1</span></div>
        <div className="top-actions"><span className="status-dot" /><span className="status-label">Lokal im Browser</span><button className="ghost-button" onClick={() => setShowHelp(true)}>Format-Hilfe</button></div>
      </header>

      <section className="workspace">
        <aside className="rail left-rail">
          <div className="eyebrow">WORKFLOW</div>
          <ol className="steps"><li className="done"><span>✓</span><div><strong>Mapping laden</strong><small>{fmt.format(points.length)} Koordinaten</small></div></li><li className={selectionMode ? 'active' : ''}><span>2</span><div><strong>Bereich wählen</strong><small>Rahmen oder Panel</small></div></li><li className={showExport ? 'active' : ''}><span>3</span><div><strong>Fixture bauen</strong><small>2D-Projektion</small></div></li><li><span>4</span><div><strong>Exportieren</strong><small>SVG · CSV · MMFL</small></div></li></ol>
          <button className="load-button" onClick={() => inputRef.current?.click()}>＋ Pixelblaze Map laden</button>
          <div className="tool-group"><button className={selectionMode ? 'tool active' : 'tool'} onClick={() => setSelectionMode(v => !v)}>▧ Rahmenauswahl</button><button className="tool" disabled={!selection.length} onClick={addSelection}>＋ Auswahl als Panel</button></div>
          <div className="data-card"><span>Erkannter LED-Abstand</span><strong>{pitch.toFixed(3)}</strong><small>Cluster-Radius: {(pitch * 3).toFixed(3)}</small></div>
          <p className="privacy-note">Deine Mapping-Datei bleibt auf diesem Gerät und wird nicht hochgeladen.</p>
        </aside>

        <section className="stage-card">
          <div className="stage-toolbar"><div><span className="eyebrow">3D MAP</span><h1>{fileName}</h1></div><div className="view-switch">{['3D', 'Top', 'Front', 'Side'].map(item => <button key={item} className={view === item ? 'selected' : ''} onClick={() => setView(item)}>{item}</button>)}</div></div>
          <div className="viewport">
            <MapCanvas points={points} panels={panels} selectionMode={selectionMode} onSelection={indices => { setSelection(indices); setMessage(`${fmt.format(indices.length)} LEDs im Rahmen markiert.`); }} view={view} />
            <div className="axis-chip"><i className="x" /> X <i className="y" /> Y <i className="z" /> Z</div><div className="canvas-help">{selectionMode ? 'Rahmen ziehen, um LEDs zu markieren' : 'Ziehen: drehen · Scrollen: zoomen · Shift: auswählen'}</div>
          </div>
          <div className="stage-footer"><span><b>{fmt.format(points.length)}</b> Slots</span><span><b>{panels.length}</b> Bereiche</span><span className={placeholders + outliers ? 'warning' : ''}><b>{placeholders + outliers}</b> Warnungen</span><span className="status-message">{message}</span></div>
        </section>

        <aside className="rail right-rail">
          <div className="panel-heading"><div><span className="eyebrow">BEREICHE</span><h2>Panels & Export</h2></div><span className="count-chip">{enabledPanels.length}/{panels.length}</span></div>
          <div className="panel-list">{panels.map(panel => <div className={`panel-row ${panel.id === active?.id ? 'chosen' : ''}`} key={panel.id}><button className="panel-main" onClick={() => setActiveId(panel.id)}><span className="color-dot" style={{ background: panel.color }} /><span><strong>{panel.name}</strong><small>{fmt.format(panel.indices.length)} LEDs · #{panel.indices[0]}–{panel.indices.at(-1)}</small></span></button><label className="switch" title="Für Export aktiv"><input type="checkbox" checked={panel.enabled} onChange={() => togglePanel(panel.id)} /><i /></label></div>)}</div>
          <div className="fixture-preview"><div className="preview-title"><span className="eyebrow">MADMapper 2D-VORSCHAU</span><span>{active?.name ?? '—'}</span></div><FixturePreview panel={active} points={points} ledSize={settings.ledSize} /><p>Best-Fit-Ebene · Quellreihenfolge bleibt erhalten</p></div>
          <button className="export-button" onClick={() => setShowExport(true)}>Fixture erstellen <span>→</span></button>
        </aside>
      </section>

      {error && <div className="toast error" role="alert"><span>!</span>{error}<button onClick={() => setError('')}>×</button></div>}
      {showExport && <div className="modal-backdrop" onMouseDown={() => setShowExport(false)}><section className="modal" onMouseDown={e => e.stopPropagation()} aria-modal="true" role="dialog"><button className="modal-close" onClick={() => setShowExport(false)}>×</button><span className="eyebrow">EXPORT</span><h2>MadMapper Fixture erstellen</h2><p className="modal-lead">{enabledPanels.length} Panel{enabledPanels.length === 1 ? '' : 's'} · {fmt.format(enabledPanels.reduce((sum, panel) => sum + panel.indices.length, 0))} LEDs · in Originalreihenfolge</p><div className="form-grid"><label>Fixture Definition<input value={settings.definition} onChange={e => setSettings(s => ({ ...s, definition: e.target.value }))} /></label><label>Kanäle pro Pixel<select value={settings.channels} onChange={e => setSettings(s => ({ ...s, channels: Number(e.target.value), definition: Number(e.target.value) === 4 ? 'Generic - Pixel RGBW' : 'Generic - Pixel RGB' }))}><option value={3}>RGB · 3</option><option value={4}>RGBW · 4</option></select></label><label>Start Universe<input type="number" min="0" max="32767" value={settings.universe} onChange={e => setSettings(s => ({ ...s, universe: Math.max(0, Number(e.target.value)) }))} /></label><label>Start Channel<input type="number" min="1" max="512" value={settings.channel} onChange={e => setSettings(s => ({ ...s, channel: Math.max(1, Math.min(512, Number(e.target.value))) }))} /></label><label>Pixelgröße in MadMapper<input type="number" min="1" max="64" value={settings.ledSize} onChange={e => setSettings(s => ({ ...s, ledSize: Math.max(1, Number(e.target.value)) }))} /></label></div><div className="format-cards"><button onClick={() => exportFile('svg')}><b>SVG 6.1</b><span>Empfohlen</span><small>Exakte freie 2D-Positionen, Gruppen und DMX-Patch.</small></button><button onClick={() => exportFile('csv')}><b>CSV</b><span>Alternative</span><small>Einzelpixel mit Position, Definition und Patch.</small></button><button onClick={() => exportFile('mmfl')}><b>MMFL</b><span>Experimentell</span><small>Fixture-Editor-Definition auf quantisiertem Raster.</small></button></div><div className="format-note"><strong>Warum 2D?</strong> MadMapper importiert keine echten XYZ-Fixture-Koordinaten. Die App projiziert jedes gewählte Panel verlustarm auf seine lokale Ebene; die 3D-Map bleibt unverändert.</div></section></div>}
      {showHelp && <div className="modal-backdrop" onMouseDown={() => setShowHelp(false)}><section className="modal help-modal" onMouseDown={e => e.stopPropagation()}><button className="modal-close" onClick={() => setShowHelp(false)}>×</button><span className="eyebrow">FORMAT-HILFE</span><h2>Welches Format wofür?</h2><div className="help-row"><b>SVG 6.1</b><p>Für File → Import Fixtures. Jede LED wird als eigenes Fixture mit aktuellen <code>universe</code>-, <code>channel</code>- und <code>fixture_definition</code>-Attributen angelegt.</p></div><div className="help-row"><b>CSV</b><p>Robuste Tabellenalternative für Fixture-Instanzen. Semikolon-getrennt und mit Gruppenpfaden pro Panel.</p></div><div className="help-row"><b>MMFL</b><p>Für den Import im Fixture Editor. Das Format beschreibt nur ein 2D-Pixelraster und Kanalbelegung; seine internen Details sind nicht vollständig öffentlich dokumentiert.</p></div><div className="help-warning">Alte MadMapper-5-SVG-Attribute werden bewusst nicht verwendet. Der Export folgt der aktuellen 6.1-Dokumentation.</div></section></div>}
    </main>
  );
}
