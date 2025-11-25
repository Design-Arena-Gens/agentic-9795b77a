import { useEffect, useMemo, useRef, useState } from 'react';
import { Stage, Layer, Rect, Image as KImage, Text as KText, Group, Line, Star, Arrow, Circle, Transformer } from 'react-konva';
import { saveAs } from 'file-saver';
import cls from 'classnames';

const THUMB_W = 1280;
const THUMB_H = 720;

function useContainerSize() {
  const ref = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cr = entry.contentRect;
        setSize({ width: cr.width, height: cr.height });
      }
    });
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

function loadHTMLImage(fileOrUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    if (typeof fileOrUrl === 'string') {
      img.src = fileOrUrl;
    } else {
      const url = URL.createObjectURL(fileOrUrl);
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.src = url;
    }
  });
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function lerp(a, b, t) { return a + (b - a) * t; }

function getContrastRatio(rgb1, rgb2) {
  function luminance([r, g, b]) {
    const srgb = [r, g, b].map(v => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
  }
  const L1 = luminance(rgb1);
  const L2 = luminance(rgb2);
  const bright = Math.max(L1, L2);
  const dark = Math.min(L1, L2);
  return (bright + 0.05) / (dark + 0.05);
}

function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(x => x + x).join('');
  const bigint = parseInt(h, 16);
  return [ (bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255 ];
}

function avgImageColor(img) {
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const w = 64, h = 36;
    canvas.width = w; canvas.height = h;
    ctx.drawImage(img, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    let r = 0, g = 0, b = 0, count = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]; g += data[i + 1]; b += data[i + 2]; count++;
    }
    return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
  } catch {
    return [20, 20, 20];
  }
}

function computeAnalysis(elements, bgImg) {
  const textEls = elements.filter(e => e.type === 'text');
  const words = textEls.flatMap(t => (t.text || '').trim().split(/\s+/).filter(Boolean));
  const wordCount = words.length;

  const textArea = textEls.reduce((acc, t) => acc + (t.width || 0) * (t.height || 0), 0);
  const areaRatio = textArea / (THUMB_W * THUMB_H);

  const bgAvg = bgImg ? avgImageColor(bgImg) : [20, 20, 20];
  // Approximate contrast by comparing bg average to each text fill color
  const contrasts = textEls.map(t => getContrastRatio(hexToRgb(t.fill || '#ffffff'), bgAvg));
  const avgContrast = contrasts.length ? (contrasts.reduce((a, b) => a + b, 0) / contrasts.length) : 8;

  // Score components
  let score = 0;
  // Word count target 2-6
  const wcScore = clamp(1 - Math.abs(clamp(wordCount, 0, 12) - 4) / 8, 0, 1);
  // Area ratio target ~0.18-0.35
  const arTarget = (areaRatio >= 0.12 && areaRatio <= 0.4) ? 1 : (areaRatio < 0.12 ? clamp(areaRatio / 0.12, 0, 1) : clamp((0.5 - areaRatio) / 0.1, 0, 1));
  // Contrast target >= 4.5
  const contrastScore = clamp(avgContrast / 6.5, 0, 1); // 6.5 treated as excellent
  score = Math.round((wcScore * 0.3 + arTarget * 0.35 + contrastScore * 0.35) * 100);

  const suggestions = [];
  if (wordCount > 6) suggestions.push('Kurangi jumlah kata agar lebih punchy (? 6 kata).');
  if (wordCount === 0) suggestions.push('Tambahkan judul singkat yang kuat.');
  if (areaRatio < 0.12) suggestions.push('Perbesar ukuran teks/elemen penting agar lebih terbaca.');
  if (areaRatio > 0.4) suggestions.push('Kurangi dominasi teks agar visual tetap bersih.');
  if (avgContrast < 4.5) suggestions.push('Tingkatkan kontras teks (ganti warna, tambah outline/shadow).');
  if (!elements.some(e => e.type === 'badge' || e.type === 'arrow')) suggestions.push('Tambahkan elemen penunjuk (badge/arrow) untuk fokus visual.');
  return { score, wordCount, areaRatio, avgContrast, suggestions };
}

export default function Home() {
  const [containerRef, containerSize] = useContainerSize();
  const [stageScale, setStageScale] = useState(1);
  const [bgImg, setBgImg] = useState(null);
  const [bgSettings, setBgSettings] = useState({ brightness: 0, contrast: 0, saturation: 0, blur: 0, overlay: '#000000', overlayAlpha: 0.0, bgColor: '#0a0e15' });
  const [elements, setElements] = useState([]);
  const [showGrid, setShowGrid] = useState(true);
  const [showThirds, setShowThirds] = useState(false);
  const [showSafeZone, setShowSafeZone] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const transformerRef = useRef(null);
  const stageRef = useRef(null);
  const layerRef = useRef(null);

  // autoscale stage to container with preserved aspect ratio
  useEffect(() => {
    const maxW = Math.max(320, containerSize.width - 40);
    const maxH = Math.max(240, containerSize.height - 80);
    const scale = Math.min(maxW / THUMB_W, maxH / THUMB_H);
    setStageScale(scale || 1);
  }, [containerSize]);

  // keep transformer attached to selected node
  useEffect(() => {
    const tr = transformerRef.current;
    const stage = stageRef.current;
    if (!tr || !stage) return;
    const node = stage.findOne(`#node-${selectedId}`);
    if (node) {
      tr.nodes([node]);
      tr.getLayer()?.batchDraw();
    } else {
      tr.nodes([]);
    }
  }, [selectedId, elements, stageScale]);

  const analysis = useMemo(() => computeAnalysis(elements, bgImg), [elements, bgImg]);

  function addText(preset) {
    const id = crypto.randomUUID();
    const text = preset?.text || 'JUDUL BESAR';
    const fill = preset?.fill || '#ffffff';
    const stroke = preset?.stroke || '#000000';
    const shadowColor = preset?.shadowColor || '#000000';
    const fontSize = preset?.fontSize || 120;
    const fontStyle = preset?.fontStyle || 'bold';
    const width = 1000;
    const height = fontSize * 1.3;
    setElements(prev => [...prev, {
      id, type: 'text', x: 80, y: 400, rotation: 0, draggable: true,
      text, fontSize, fontFamily: 'Impact, Anton, Arial Black, sans-serif', fontStyle,
      fill, stroke, strokeWidth: 8, shadowColor, shadowBlur: 10, shadowOpacity: 0.6,
      align: 'left', width, height
    }]);
    setSelectedId(id);
  }

  function addRect() {
    const id = crypto.randomUUID();
    setElements(prev => [...prev, {
      id, type: 'rect', x: 60, y: 60, width: 500, height: 220, rotation: 0, draggable: true,
      fill: '#ffce33', opacity: 0.9, stroke: '#000000', strokeWidth: 0, cornerRadius: 16
    }]);
    setSelectedId(id);
  }
  function addCircle() {
    const id = crypto.randomUUID();
    setElements(prev => [...prev, {
      id, type: 'circle', x: 300, y: 300, radius: 120, rotation: 0, draggable: true,
      fill: '#2fa6ff', opacity: 0.9, stroke: '#000000', strokeWidth: 0
    }]);
    setSelectedId(id);
  }
  function addArrow() {
    const id = crypto.randomUUID();
    setElements(prev => [...prev, {
      id, type: 'arrow', x: 950, y: 540, rotation: -20, draggable: true,
      points: [0, 0, -180, -80], pointerLength: 26, pointerWidth: 26,
      fill: '#ff5b6e', stroke: '#ff5b6e', strokeWidth: 18, opacity: 1
    }]);
    setSelectedId(id);
  }
  function addBadge() {
    const id = crypto.randomUUID();
    setElements(prev => [...prev, {
      id, type: 'badge', x: 1080, y: 120, rotation: 8, draggable: true,
      innerRadius: 38, outerRadius: 90, numPoints: 12,
      fill: '#ffce33', stroke: '#000000', strokeWidth: 10, opacity: 1,
      text: 'NEW', textFill: '#000000', textSize: 48
    }]);
    setSelectedId(id);
  }
  function removeSelected() {
    if (!selectedId) return;
    setElements(prev => prev.filter(e => e.id !== selectedId));
    setSelectedId(null);
  }
  function bringToFront() {
    if (!selectedId) return;
    const idx = elements.findIndex(e => e.id === selectedId);
    if (idx < 0) return;
    const el = elements[idx];
    const arr = elements.slice();
    arr.splice(idx, 1);
    arr.push(el);
    setElements(arr);
  }
  function sendToBack() {
    if (!selectedId) return;
    const idx = elements.findIndex(e => e.id === selectedId);
    if (idx < 0) return;
    const el = elements[idx];
    const arr = elements.slice();
    arr.splice(idx, 1);
    arr.unshift(el);
    setElements(arr);
  }

  async function onUploadBg(ev) {
    const file = ev.target.files?.[0];
    if (!file) return;
    const img = await loadHTMLImage(file);
    setBgImg(img);
  }

  function applyPreset(kind) {
    if (kind === 'impact-yellow') {
      setBgSettings(s => ({ ...s, overlay: '#000000', overlayAlpha: 0.35, saturation: 0.1, contrast: 0.15, brightness: -0.05 }));
      addText({ text: 'JANGAN LEWATKAN INI', fill: '#111111', stroke: '#ffffff', fontSize: 140 });
      addRect();
    } else if (kind === 'neon') {
      setBgSettings(s => ({ ...s, overlay: '#000000', overlayAlpha: 0.25 }));
      addText({ text: 'RAHASIA VIRAL', fill: '#16f3ff', stroke: '#ff00e6', fontSize: 150 });
      addArrow();
    } else if (kind === 'clean') {
      setBgSettings(s => ({ ...s, overlay: '#000000', overlayAlpha: 0.2, saturation: -0.1 }));
      addText({ text: 'TIPS YOUTUBE', fill: '#ffffff', stroke: '#000000', fontSize: 132 });
    }
  }

  function exportPng() {
    const node = stageRef.current;
    if (!node) return;
    const dataURL = node.toDataURL({ pixelRatio: Math.max(1, Math.floor(THUMB_W / (THUMB_W * stageScale))) });
    // Ensure exact 1280x720 by using an offscreen canvas
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = THUMB_W; c.height = THUMB_H;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, THUMB_W, THUMB_H);
      c.toBlob((blob) => blob && saveAs(blob, 'thumbnail.png'));
    };
    img.src = dataURL;
  }

  const handleDragEnd = (id, e) => {
    const { x, y } = e.target.position();
    setElements(prev => prev.map(it => it.id === id ? { ...it, x, y } : it));
  };
  const handleTransformEnd = (id, e) => {
    const node = e.target;
    const type = elements.find(t => t.id === id)?.type;
    if (!type) return;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    if (type === 'text') {
      const width = node.width() * scaleX;
      const height = node.height() * scaleY;
      const rotation = node.rotation();
      node.scaleX(1); node.scaleY(1);
      setElements(prev => prev.map(it => it.id === id ? { ...it, width, height, rotation } : it));
    } else if (type === 'rect') {
      const width = Math.max(10, node.width() * scaleX);
      const height = Math.max(10, node.height() * scaleY);
      const rotation = node.rotation();
      node.scaleX(1); node.scaleY(1);
      setElements(prev => prev.map(it => it.id === id ? { ...it, width, height, rotation } : it));
    } else if (type === 'circle') {
      const radius = Math.max(5, (node.radius?.() || 50) * ((scaleX + scaleY) / 2));
      const rotation = node.rotation();
      node.scaleX(1); node.scaleY(1);
      setElements(prev => prev.map(it => it.id === id ? { ...it, radius, rotation } : it));
    } else if (type === 'arrow') {
      const rotation = node.rotation();
      node.scaleX(1); node.scaleY(1);
      setElements(prev => prev.map(it => it.id === id ? { ...it, rotation } : it));
    } else if (type === 'badge') {
      const rotation = node.rotation();
      node.scaleX(1); node.scaleY(1);
      setElements(prev => prev.map(it => it.id === id ? { ...it, rotation } : it));
    }
  };

  function updateSelected(patch) {
    if (!selectedId) return;
    setElements(prev => prev.map(it => it.id === selectedId ? { ...it, ...patch } : it));
  }

  function selected() { return elements.find(e => e.id === selectedId); }

  const stageWidth = Math.round(THUMB_W * stageScale);
  const stageHeight = Math.round(THUMB_H * stageScale);

  return (
    <div className="app">
      <div className="header">
        <div className="logo">
          <div className="logo-badge">YT Thumb</div>
          <div>
            <div style={{ fontWeight: 800 }}>Pembuat Thumbnail Interaktif</div>
            <div className="hint">Rasio 1280?720, ekspor PNG</div>
          </div>
        </div>
        <div className="header-actions">
          <button className="btn" onClick={() => applyPreset('impact-yellow')}>Preset Kuning</button>
          <button className="btn" onClick={() => applyPreset('neon')}>Preset Neon</button>
          <button className="btn" onClick={() => applyPreset('clean')}>Preset Bersih</button>
          <button className="btn warn" onClick={exportPng}>Ekspor PNG</button>
        </div>
      </div>

      <aside className="left">
        <div className="section">
          <h3>Background</h3>
          <div className="control">
            <label>Gambar Latar</label>
            <input className="input" type="file" accept="image/*" onChange={onUploadBg} />
          </div>
          <div className="control">
            <label>Warna Latar</label>
            <div className="inline">
              <input type="color" className="swatch" value={bgSettings.bgColor} onChange={(e) => setBgSettings(s => ({ ...s, bgColor: e.target.value }))} />
              <span className="hint">Dipakai jika gambar kosong</span>
            </div>
          </div>
          <div className="control">
            <label>Overlay & Opacity</label>
            <div className="inline">
              <input type="color" className="swatch" value={bgSettings.overlay} onChange={(e) => setBgSettings(s => ({ ...s, overlay: e.target.value }))} />
              <input className="range" type="range" min="0" max="1" step="0.01" value={bgSettings.overlayAlpha} onChange={(e) => setBgSettings(s => ({ ...s, overlayAlpha: parseFloat(e.target.value) }))} />
            </div>
          </div>
          <div className="control">
            <label>Brightness</label>
            <input className="range" type="range" min="-0.5" max="0.5" step="0.01" value={bgSettings.brightness} onChange={(e) => setBgSettings(s => ({ ...s, brightness: parseFloat(e.target.value) }))} />
          </div>
          <div className="control">
            <label>Contrast</label>
            <input className="range" type="range" min="-0.5" max="0.5" step="0.01" value={bgSettings.contrast} onChange={(e) => setBgSettings(s => ({ ...s, contrast: parseFloat(e.target.value) }))} />
          </div>
          <div className="control">
            <label>Saturation</label>
            <input className="range" type="range" min="-1" max="1" step="0.02" value={bgSettings.saturation} onChange={(e) => setBgSettings(s => ({ ...s, saturation: parseFloat(e.target.value) }))} />
          </div>
          <div className="control">
            <label>Blur</label>
            <input className="range" type="range" min="0" max="16" step="0.5" value={bgSettings.blur} onChange={(e) => setBgSettings(s => ({ ...s, blur: parseFloat(e.target.value) }))} />
          </div>
        </div>

        <div className="section">
          <h3>Elemen</h3>
          <div className="control-row">
            <button className="btn" onClick={() => addText()}>Tambah Teks</button>
            <button className="btn" onClick={addRect}>Kotak</button>
            <button className="btn" onClick={addCircle}>Lingkaran</button>
          </div>
          <div className="control-row">
            <button className="btn" onClick={addArrow}>Arrow</button>
            <button className="btn" onClick={addBadge}>Badge</button>
            <button className="btn" onClick={removeSelected} disabled={!selectedId}>Hapus</button>
          </div>
          <div className="control-row">
            <button className="btn" onClick={bringToFront} disabled={!selectedId}>Ke Depan</button>
            <button className="btn" onClick={sendToBack} disabled={!selectedId}>Ke Belakang</button>
          </div>
        </div>

        <div className="section">
          <h3>Properti Terpilih</h3>
          {!selected() && <div className="hint">Pilih elemen di kanvas.</div>}
          {selected() && selected().type === 'text' && (
            <>
              <div className="control">
                <label>Konten</label>
                <textarea className="input" rows={3} value={selected().text} onChange={e => updateSelected({ text: e.target.value })} />
              </div>
              <div className="control">
                <label>Ukuran</label>
                <input className="range" type="range" min="32" max="220" step="2" value={selected().fontSize} onChange={e => updateSelected({ fontSize: parseInt(e.target.value) })} />
              </div>
              <div className="control">
                <label>Warna & Outline</label>
                <div className="inline">
                  <input type="color" className="swatch" value={selected().fill} onChange={e => updateSelected({ fill: e.target.value })} />
                  <input type="color" className="swatch" value={selected().stroke} onChange={e => updateSelected({ stroke: e.target.value })} />
                </div>
              </div>
              <div className="control">
                <label>Ketebalan Outline</label>
                <input className="range" type="range" min="0" max="20" step="1" value={selected().strokeWidth} onChange={e => updateSelected({ strokeWidth: parseInt(e.target.value) })} />
              </div>
              <div className="control">
                <label>Shadow</label>
                <div className="inline">
                  <input type="color" className="swatch" value={selected().shadowColor} onChange={e => updateSelected({ shadowColor: e.target.value })} />
                  <input className="range" type="range" min="0" max="40" step="1" value={selected().shadowBlur} onChange={e => updateSelected({ shadowBlur: parseInt(e.target.value) })} />
                </div>
              </div>
            </>
          )}
          {selected() && selected().type === 'rect' && (
            <>
              <div className="control">
                <label>Warna</label>
                <input type="color" className="swatch" value={selected().fill} onChange={e => updateSelected({ fill: e.target.value })} />
              </div>
              <div className="control">
                <label>Opacity</label>
                <input className="range" type="range" min="0.05" max="1" step="0.01" value={selected().opacity} onChange={e => updateSelected({ opacity: parseFloat(e.target.value) })} />
              </div>
              <div className="control">
                <label>Radius Sudut</label>
                <input className="range" type="range" min="0" max="80" step="2" value={selected().cornerRadius || 0} onChange={e => updateSelected({ cornerRadius: parseInt(e.target.value) })} />
              </div>
            </>
          )}
          {selected() && selected().type === 'circle' && (
            <>
              <div className="control">
                <label>Warna</label>
                <input type="color" className="swatch" value={selected().fill} onChange={e => updateSelected({ fill: e.target.value })} />
              </div>
              <div className="control">
                <label>Opacity</label>
                <input className="range" type="range" min="0.05" max="1" step="0.01" value={selected().opacity || 1} onChange={e => updateSelected({ opacity: parseFloat(e.target.value) })} />
              </div>
              <div className="control">
                <label>Radius</label>
                <input className="range" type="range" min="10" max="400" step="2" value={selected().radius} onChange={e => updateSelected({ radius: parseInt(e.target.value) })} />
              </div>
            </>
          )}
          {selected() && selected().type === 'arrow' && (
            <>
              <div className="control">
                <label>Warna</label>
                <input type="color" className="swatch" value={selected().fill} onChange={e => updateSelected({ fill: e.target.value, stroke: e.target.value })} />
              </div>
              <div className="control">
                <label>Ketebalan</label>
                <input className="range" type="range" min="4" max="40" step="1" value={selected().strokeWidth} onChange={e => updateSelected({ strokeWidth: parseInt(e.target.value) })} />
              </div>
            </>
          )}
          {selected() && selected().type === 'badge' && (
            <>
              <div className="control">
                <label>Warna</label>
                <div className="inline">
                  <input type="color" className="swatch" value={selected().fill} onChange={e => updateSelected({ fill: e.target.value })} />
                  <input type="color" className="swatch" value={selected().textFill} onChange={e => updateSelected({ textFill: e.target.value })} />
                </div>
              </div>
              <div className="control">
                <label>Teks Badge</label>
                <input className="input" value={selected().text} onChange={e => updateSelected({ text: e.target.value })} />
              </div>
            </>
          )}
        </div>

        <div className="section">
          <h3>Panduan</h3>
          <div className="control-row">
            <label className="inline"><input type="checkbox" checked={showGrid} onChange={e => setShowGrid(e.target.checked)} /> Grid</label>
            <label className="inline"><input type="checkbox" checked={showThirds} onChange={e => setShowThirds(e.target.checked)} /> Rule of Thirds</label>
            <label className="inline"><input type="checkbox" checked={showSafeZone} onChange={e => setShowSafeZone(e.target.checked)} /> Safe Zone</label>
          </div>
          <div className="hint">Safe zone melindungi area terhalang badge durasi (kanan bawah).</div>
        </div>
      </aside>

      <main className="main">
        <div className="canvas-wrap" ref={containerRef}>
          <div className="stage-frame">
            <Stage
              ref={stageRef}
              width={stageWidth}
              height={stageHeight}
              scaleX={stageScale}
              scaleY={stageScale}
              onMouseDown={(e) => {
                if (e.target === e.target.getStage()) setSelectedId(null);
              }}
            >
              <Layer ref={layerRef}>
                {/* Background color fallback */}
                <Rect x={0} y={0} width={THUMB_W} height={THUMB_H} fill={bgSettings.bgColor} listening={false} />
                {/* Background image */}
                {bgImg && (
                  <KImage
                    image={bgImg}
                    x={0}
                    y={0}
                    width={THUMB_W}
                    height={THUMB_H}
                    filters={[]}
                    opacity={1}
                    listening={false}
                  />
                )}
                {/* overlay */}
                <Rect x={0} y={0} width={THUMB_W} height={THUMB_H} fill={bgSettings.overlay} opacity={bgSettings.overlayAlpha} listening={false} />

                {/* Elements */}
                {elements.map(el => {
                  if (el.type === 'text') {
                    return (
                      <KText
                        key={el.id}
                        id={`node-${el.id}`}
                        {...el}
                        draggable
                        onClick={() => setSelectedId(el.id)}
                        onTap={() => setSelectedId(el.id)}
                        onDragEnd={(e) => handleDragEnd(el.id, e)}
                        onTransformEnd={(e) => handleTransformEnd(el.id, e)}
                      />
                    );
                  }
                  if (el.type === 'rect') {
                    return (
                      <Rect
                        key={el.id}
                        id={`node-${el.id}`}
                        {...el}
                        draggable
                        onClick={() => setSelectedId(el.id)}
                        onTap={() => setSelectedId(el.id)}
                        onDragEnd={(e) => handleDragEnd(el.id, e)}
                        onTransformEnd={(e) => handleTransformEnd(el.id, e)}
                      />
                    );
                  }
                  if (el.type === 'circle') {
                    return (
                      <Circle
                        key={el.id}
                        id={`node-${el.id}`}
                        {...el}
                        draggable
                        onClick={() => setSelectedId(el.id)}
                        onTap={() => setSelectedId(el.id)}
                        onDragEnd={(e) => handleDragEnd(el.id, e)}
                        onTransformEnd={(e) => handleTransformEnd(el.id, e)}
                      />
                    );
                  }
                  if (el.type === 'arrow') {
                    return (
                      <Arrow
                        key={el.id}
                        id={`node-${el.id}`}
                        {...el}
                        draggable
                        onClick={() => setSelectedId(el.id)}
                        onTap={() => setSelectedId(el.id)}
                        onDragEnd={(e) => handleDragEnd(el.id, e)}
                        onTransformEnd={(e) => handleTransformEnd(el.id, e)}
                      />
                    );
                  }
                  if (el.type === 'badge') {
                    return (
                      <Group
                        key={el.id}
                        id={`node-${el.id}`}
                        x={el.x}
                        y={el.y}
                        rotation={el.rotation || 0}
                        draggable
                        onClick={() => setSelectedId(el.id)}
                        onTap={() => setSelectedId(el.id)}
                        onDragEnd={(e) => handleDragEnd(el.id, e)}
                        onTransformEnd={(e) => handleTransformEnd(el.id, e)}
                      >
                        <Star
                          numPoints={el.numPoints}
                          innerRadius={el.innerRadius}
                          outerRadius={el.outerRadius}
                          fill={el.fill}
                          stroke={el.stroke}
                          strokeWidth={el.strokeWidth}
                          opacity={el.opacity}
                        />
                        <KText
                          text={el.text}
                          fill={el.textFill}
                          fontStyle="800"
                          fontSize={el.textSize}
                          width={el.outerRadius * 2}
                          height={el.outerRadius * 2}
                          x={-el.outerRadius}
                          y={-el.outerRadius}
                          align="center"
                          verticalAlign="middle"
                        />
                      </Group>
                    );
                  }
                  return null;
                })}

                {/* Guides */}
                {showGrid && (
                  <Group listening={false} opacity={0.25}>
                    {Array.from({ length: 8 }).map((_, i) => (
                      <Line key={`v-${i}`} points={[(i + 1) * (THUMB_W / 8), 0, (i + 1) * (THUMB_W / 8), THUMB_H]} stroke="#ffffff" strokeWidth={1} dash={[4, 4]} />
                    ))}
                    {Array.from({ length: 4 }).map((_, i) => (
                      <Line key={`h-${i}`} points={[0, (i + 1) * (THUMB_H / 4), THUMB_W, (i + 1) * (THUMB_H / 4)]} stroke="#ffffff" strokeWidth={1} dash={[4, 4]} />
                    ))}
                  </Group>
                )}
                {showThirds && (
                  <Group listening={false} opacity={0.3}>
                    <Line points={[THUMB_W / 3, 0, THUMB_W / 3, THUMB_H]} stroke="#2fa6ff" strokeWidth={2} />
                    <Line points={[(THUMB_W / 3) * 2, 0, (THUMB_W / 3) * 2, THUMB_H]} stroke="#2fa6ff" strokeWidth={2} />
                    <Line points={[0, THUMB_H / 3, THUMB_W, THUMB_H / 3]} stroke="#2fa6ff" strokeWidth={2} />
                    <Line points={[0, (THUMB_H / 3) * 2, THUMB_W, (THUMB_H / 3) * 2]} stroke="#2fa6ff" strokeWidth={2} />
                  </Group>
                )}
                {showSafeZone && (
                  <Group listening={false}>
                    {/* YouTube duration badge safe zone roughly 200x80 at bottom-right */}
                    <Rect x={THUMB_W - 220} y={THUMB_H - 100} width={220} height={100} fill="#000000" opacity={0.25} />
                    <Rect x={THUMB_W - 220} y={THUMB_H - 100} width={220} height={100} stroke="#ffffff" strokeWidth={2} dash={[6, 6]} opacity={0.5} />
                  </Group>
                )}
                <Transformer
                  ref={transformerRef}
                  anchorSize={10}
                  rotateEnabled={true}
                  borderStroke="#2fa6ff"
                  anchorStroke="#2fa6ff"
                  anchorFill="#2fa6ff"
                />
              </Layer>
            </Stage>
            <div className="stage-labels">
              <div className="pill">1280?720</div>
              <div className="pill">{Math.round(stageScale * 100)}%</div>
            </div>
          </div>
        </div>
      </main>

      <aside className="right">
        <div className="section">
          <h3>Analisa Efektivitas</h3>
          <div className="score">
            <div className="dot" style={{ background: analysis.score >= 80 ? 'var(--success)' : analysis.score >= 60 ? 'var(--accent-2)' : 'var(--danger)' }} />
            <div>Score: {analysis.score}/100</div>
          </div>
          <div style={{ marginTop: 10 }}>
            <div className="hint">Kata: {analysis.wordCount} | Area teks: {(analysis.areaRatio * 100).toFixed(1)}% | Kontras: {analysis.avgContrast.toFixed(2)}:1</div>
          </div>
        </div>
        <div className="section">
          <h3>Saran</h3>
          {analysis.suggestions.length === 0 && <div className="hint">Sudah bagus! ??</div>}
          {analysis.suggestions.map((s, i) => (
            <div key={i} className="suggestion">{s}</div>
          ))}
          <div className="hint" style={{ marginTop: 8 }}>
            Praktik efektif: teks besar (? 6 kata), kontras tinggi, fokus visual (badge/arrow), dan komposisi thirds.
          </div>
        </div>
        <div className="section">
          <h3>Tips Warna Cepat</h3>
          <div className="control-row" style={{ flexWrap: 'wrap', gap: 10 }}>
            {['#ffffff','#000000','#ffce33','#ff5b6e','#2fa6ff','#16f3ff','#00ff7f','#ff8a00'].map(c => (
              <button key={c} className="swatch" style={{ background: c }} onClick={() => {
                if (selected() && selected().type === 'text') updateSelected({ fill: c });
                else setBgSettings(s => ({ ...s, overlay: c }));
              }} />
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

